package engine

import (
	"encoding/json"
	"regexp"
	"strings"
)

const (
	resultMax = 30000
	noteMax   = 400
)

// normalizer folds one engine's JSON event stream into the facts Weaver
// needs: has it started, is it producing, did it finish, and with what.
type normalizer struct {
	engine string

	text    string
	clipped bool
	session string
	in, out int

	done          bool   // the vendor's own success terminal was seen
	failure       string // sticky: a failure event was seen
	failureDetail string
	stopReason    string
	sessionClosed bool // pi: agent_end or a clean agent_settled
	dshTools      map[string]string
	unparsed      int
}

// signal is what one line told us.
type signal struct {
	started bool     // the engine is up and working on the prompt
	output  bool     // the model produced text or used a tool
	notes   []string // progress lines worth keeping
}

func newNormalizer(engine string) *normalizer { return &normalizer{engine: engine} }

// succeeded reports whether the engine has given its final answer.
func (n *normalizer) succeeded() bool {
	done := n.done
	if n.engine == "pi" {
		done = n.sessionClosed && n.stopReason == "stop"
	}
	return done && n.failure == "" && strings.TrimSpace(n.text) != ""
}

// truncated reports whether the answer was cut off by an output limit.
func (n *normalizer) truncated() bool {
	return n.stopReason == "length" || n.stopReason == "max_tokens"
}

// result returns the final answer, bounded to its last resultMax bytes.
func (n *normalizer) result() string {
	text := strings.TrimSpace(n.text)
	if n.clipped {
		return "[前面的回复已省略，只保留最后一段]\n" + text
	}
	return text
}

type obj = map[string]any

func asObj(v any) obj  { o, _ := v.(obj); return o }
func str(v any) string { s, _ := v.(string); return s }
func num(v any) int {
	f, _ := v.(float64)
	if f < 0 {
		return 0
	}
	return int(f)
}

func (n *normalizer) usage(in, out any) {
	if v := num(in); v > 0 {
		n.in = v
	}
	if v := num(out); v > 0 {
		n.out = v
	}
}

func contentText(content any) string {
	parts, _ := content.([]any)
	var b strings.Builder
	for _, part := range parts {
		item := asObj(part)
		if item["type"] == "text" {
			b.WriteString(str(item["text"]))
		}
	}
	return b.String()
}

func (n *normalizer) fail(kind, detail string) {
	n.failure = kind
	detail = strings.TrimSpace(detail)
	if detail != "" && n.failureDetail == "" {
		n.failureDetail = clip(Redact(detail), 4000)
	}
}

// remember keeps completed assistant text, bounded to the tail.
func (n *normalizer) remember(text string, add bool) {
	safe := Redact(text)
	if add && n.text != "" {
		safe = n.text + "\n" + safe
	}
	if len(safe) > resultMax {
		n.clipped = true
		safe = lastBytes(safe, resultMax)
	} else if !add {
		n.clipped = false
	}
	n.text = safe
}

var reToolName = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,80}$`)

func toolNote(name any, status string) string {
	if s := str(name); reToolName.MatchString(s) {
		return "工具 " + s + " " + status
	}
	return "工具" + status
}

// push consumes one stdout line.
func (n *normalizer) push(line string) signal {
	line = strings.TrimSpace(line)
	if line == "" {
		return signal{}
	}
	var event obj
	if err := json.Unmarshal([]byte(line), &event); err != nil || str(event["type"]) == "" {
		n.unparsed++
		return signal{}
	}
	switch n.engine {
	case "pi":
		return n.pi(event)
	case "opencode":
		return n.opencode(event)
	case "grok":
		return n.grok(event)
	case "codex":
		return n.codex(event)
	case "claude", "qodercli":
		return n.claude(event)
	case "dsh":
		return n.dsh(event)
	}
	return signal{}
}

func (n *normalizer) pi(e obj) (s signal) {
	switch e["type"] {
	case "session":
		n.session = str(e["id"])
	case "agent_start":
		s.started = true
	case "message_end":
		m := asObj(e["message"])
		if m["role"] != "assistant" {
			return
		}
		u := asObj(m["usage"])
		n.usage(u["input"], u["output"])
		n.stopReason = str(m["stopReason"])
		n.remember(contentText(m["content"]), false)
		s.output = true
		if n.stopReason == "error" || n.stopReason == "aborted" {
			detail := str(m["errorMessage"])
			if detail == "" {
				detail = "unknown pi error"
			}
			n.fail(n.stopReason, detail)
		}
	case "tool_execution_start":
		s.output = true
		s.notes = append(s.notes, toolNote(e["toolName"], "开始"))
	case "tool_execution_end":
		status := "完成"
		if e["isError"] == true {
			status = "失败"
		}
		s.notes = append(s.notes, toolNote(e["toolName"], status))
	case "agent_end":
		n.sessionClosed = true
	case "agent_settled":
		if e["aborted"] == true {
			n.fail("aborted", "pi run aborted")
		} else {
			n.sessionClosed = true
		}
	}
	return
}

func (n *normalizer) opencode(e obj) (s signal) {
	if id := str(e["sessionID"]); id != "" {
		n.session = id
	}
	part := asObj(e["part"])
	switch e["type"] {
	case "step_start":
		s.started = true
	case "text":
		if text := str(part["text"]); strings.TrimSpace(text) != "" {
			n.remember(text, true)
			s.output = true
		}
	case "tool_use":
		status := "完成"
		if asObj(part["state"])["status"] == "error" {
			status = "失败"
		}
		s.output = true
		s.notes = append(s.notes, toolNote(part["tool"], status))
	case "step_finish":
		tokens := asObj(part["tokens"])
		n.usage(tokens["input"], tokens["output"])
		reason := str(part["reason"])
		n.stopReason = reason
		// tool-calls and other reasons are intermediate; a later stop can still
		// succeed. error and aborted stay sticky across that later stop.
		if reason == "error" || reason == "aborted" {
			n.fail(reason, "")
			n.done = false
		} else {
			n.done = reason == "stop" && n.failure == ""
		}
	case "error":
		er := asObj(e["error"])
		message := str(er["message"])
		if message == "" {
			message = str(asObj(er["data"])["message"])
		}
		if message == "" {
			message = str(er["name"])
		}
		if message == "" {
			message = "opencode error"
		}
		n.fail("error", message)
	}
	return
}

func (n *normalizer) grok(e obj) (s signal) {
	switch e["type"] {
	case "system":
		n.session = str(e["session_id"])
		s.started = true
	case "assistant":
		m := asObj(e["message"])
		u := asObj(m["usage"])
		n.usage(u["input_tokens"], u["output_tokens"])
		if text := contentText(m["content"]); strings.TrimSpace(text) != "" {
			n.remember(text, false)
		}
		s.output = true
		if r := str(m["stop_reason"]); r != "" {
			n.stopReason = r
		}
	case "result":
		if id := str(e["session_id"]); id != "" {
			n.session = id
		}
		u := asObj(e["usage"])
		n.usage(u["input_tokens"], u["output_tokens"])
		if text := str(e["result"]); strings.TrimSpace(text) != "" {
			n.remember(text, false)
		}
		if r := str(e["stop_reason"]); r != "" {
			n.stopReason = r
		}
		if e["is_error"] == true || e["subtype"] != "success" {
			n.fail("result", grokFailure(e))
		} else {
			n.done = true
		}
	case "error":
		message := str(e["message"])
		if message == "" {
			message = "grok error"
		}
		n.fail("error", message)
	}
	return
}

func grokFailure(e obj) string {
	var parts []string
	if r := strings.TrimSpace(str(e["result"])); r != "" {
		parts = append(parts, r)
	}
	switch errs := e["errors"].(type) {
	case string:
		if strings.TrimSpace(errs) != "" {
			parts = append(parts, strings.TrimSpace(errs))
		}
	case []any:
		for _, item := range errs {
			if s := strings.TrimSpace(str(item)); s != "" {
				parts = append(parts, s)
			} else if row := asObj(item); row != nil {
				if m := strings.TrimSpace(str(row["message"])); m != "" {
					parts = append(parts, m)
				} else if m := strings.TrimSpace(str(row["error"])); m != "" {
					parts = append(parts, m)
				}
			}
		}
	}
	if len(parts) == 0 {
		return "unknown grok error"
	}
	return strings.Join(parts, "; ")
}

func (n *normalizer) codex(e obj) (s signal) {
	switch e["type"] {
	case "thread.started":
		n.session = str(e["thread_id"])
		s.started = true
	case "turn.started":
		s.started = true
	case "item.started", "item.completed":
		item := asObj(e["item"])
		kind := str(item["type"])
		completed := e["type"] == "item.completed"
		s.output = true
		switch {
		case kind == "agent_message" && completed:
			if text := str(item["text"]); strings.TrimSpace(text) != "" {
				n.remember(text, true)
			}
		case kind != "" && kind != "agent_message" && kind != "reasoning":
			status := "完成"
			if !completed {
				status = "开始"
			}
			s.notes = append(s.notes, toolNote(kind, status))
		}
	case "turn.completed":
		u := asObj(e["usage"])
		n.usage(u["input_tokens"], u["output_tokens"])
		n.done = true
		n.stopReason = "completed"
	case "turn.failed", "error":
		message := str(e["message"])
		if message == "" {
			message = str(asObj(e["error"])["message"])
		}
		if message == "" {
			message = str(e["type"])
		}
		n.fail(str(e["type"]), message)
	}
	return
}

// claude and qodercli share the Claude Code stream-json shape: system init,
// assistant and user turns, then one result.
func (n *normalizer) claude(e obj) (s signal) {
	switch e["type"] {
	case "system":
		if e["subtype"] == "init" {
			n.session = str(e["session_id"])
			s.started = true
		}
	case "assistant":
		m := asObj(e["message"])
		u := asObj(m["usage"])
		n.usage(u["input_tokens"], u["output_tokens"])
		s.output = true
		if parts, ok := m["content"].([]any); ok {
			for _, part := range parts {
				if item := asObj(part); item["type"] == "tool_use" {
					s.notes = append(s.notes, toolNote(item["name"], "开始"))
				}
			}
		}
		if text := contentText(m["content"]); strings.TrimSpace(text) != "" {
			n.remember(text, false)
		}
		if r := str(m["stop_reason"]); r != "" {
			n.stopReason = r
		}
	case "stream_event":
		s.output = true
	case "result":
		if id := str(e["session_id"]); id != "" {
			n.session = id
		}
		u := asObj(e["usage"])
		n.usage(u["input_tokens"], u["output_tokens"])
		text := str(e["result"])
		if e["is_error"] == true || e["subtype"] != "success" {
			detail := strings.TrimSpace(text)
			if detail == "" {
				detail = str(e["subtype"])
			}
			if detail == "" {
				detail = "unknown " + n.engine + " error"
			}
			n.fail("result", detail)
			return
		}
		if strings.TrimSpace(text) != "" {
			n.remember(text, false)
		}
		if r := str(e["stop_reason"]); r != "" {
			n.stopReason = r
		}
		n.done = true
	case "error":
		message := str(e["message"])
		if message == "" {
			message = n.engine + " error"
		}
		n.fail("error", message)
	}
	return
}

// dsh --json emits session, status phases, tool calls and one lossless final.
// A failed turn still ends with final plus a non-completed turn_end reason, so
// the turn_end reason is the failure signal, and only final becomes the result.
func (n *normalizer) dsh(e obj) (s signal) {
	switch e["type"] {
	case "session":
		n.session = str(e["sessionId"])
		s.started = true
	case "status":
		switch str(e["phase"]) {
		case "turn_start":
			s.started = true
		case "step_end":
			if u := asObj(e["usage"]); u != nil {
				in, out := u["input_tokens"], u["output_tokens"]
				if in == nil {
					in = u["inputTokens"]
				}
				if out == nil {
					out = u["outputTokens"]
				}
				n.usage(in, out)
			}
		case "turn_end":
			reason := asObj(e["reason"])
			kind := str(reason["kind"])
			if kind == "" {
				kind = str(e["reason"])
			}
			if kind == "" {
				kind = "unknown"
			}
			n.stopReason = kind
			if kind == "completed" {
				n.done = true
				return
			}
			detail := kind
			if kind == "error" {
				er := asObj(reason["error"])
				detail = strings.Trim(strings.TrimSpace(str(er["code"]))+": "+strings.TrimSpace(str(er["message"])), ": ")
			}
			if detail == "" || detail == "unknown" {
				detail = "unknown dsh error"
			}
			n.fail(kind, detail)
		}
	case "text", "thinking":
		s.output = true
	case "tool_call":
		if n.dshTools == nil {
			n.dshTools = map[string]string{}
		}
		if id, tool := str(e["callId"]), str(e["tool"]); id != "" && tool != "" && len(n.dshTools) < 200 {
			n.dshTools[id] = tool
		}
		s.output = true
		s.notes = append(s.notes, toolNote(e["tool"], "开始"))
	case "tool_result":
		// A tool-level error is ordinary agent flow; only turn_end fails the run.
		status := "完成"
		if e["status"] == "error" {
			status = "失败"
		}
		s.notes = append(s.notes, toolNote(n.dshTools[str(e["callId"])], status))
	case "final":
		if text := str(e["text"]); strings.TrimSpace(text) != "" {
			n.remember(text, false)
		}
	case "error":
		message := str(e["message"])
		if message == "" {
			message = "dsh error"
		}
		n.fail("error", message)
	}
	return
}
