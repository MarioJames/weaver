package kernel

import (
	"bufio"
	"encoding/json"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

type WeaverCall struct {
	Command string `json:"command"`
	Mission string `json:"mission,omitempty"`
	Package string `json:"package,omitempty"`
}
type TranscriptItem struct {
	At     int64       `json:"at"`
	Role   string      `json:"role"`
	Text   string      `json:"text"`
	Tool   string      `json:"tool,omitempty"`
	Ref    string      `json:"ref,omitempty"`
	Weaver *WeaverCall `json:"weaver,omitempty"`
}
type Transcript struct {
	Engine  string           `json:"engine"`
	Session string           `json:"session"`
	Path    string           `json:"path"`
	Items   []TranscriptItem `json:"items"`
	Next    int64            `json:"next"`
}

func (k *Kernel) MissionTranscript(mission string, after int64) (*Transcript, error) {
	m, err := k.Mission(mission)
	if err != nil {
		return nil, err
	}
	if m.Owner == nil || m.Owner.Session == "" {
		return nil, errf("NOT_FOUND", "未记录父 Agent")
	}
	if m.Owner.Engine != "claude" && m.Owner.Engine != "codex" {
		return nil, errf("INVALID", "暂不支持读取 %s 的对话记录", m.Owner.Engine)
	}
	// Session identifiers are filename components, never paths or glob patterns.
	if strings.ContainsAny(m.Owner.Session, "/\\") || m.Owner.Session == "." || m.Owner.Session == ".." {
		return nil, errf("NOT_FOUND", "找不到父 Agent 的会话记录")
	}
	path := findSessionPath(os.Getenv("HOME"), *m.Owner)
	if path == "" {
		return nil, errf("NOT_FOUND", "找不到父 Agent 的会话记录")
	}
	return readTranscript(path, *m.Owner, after)
}
func findSessionPath(home string, owner Owner) string {
	var path string
	if owner.Engine == "claude" {
		dirs, _ := os.ReadDir(filepath.Join(home, ".claude", "projects"))
		for _, d := range dirs {
			if !d.IsDir() {
				continue
			}
			p := filepath.Join(home, ".claude", "projects", d.Name(), owner.Session+".jsonl")
			if st, e := os.Stat(p); e == nil && st.Mode().IsRegular() {
				path = p
				break
			}
		}
	} else {
		_ = filepath.WalkDir(filepath.Join(home, ".codex", "sessions"), func(p string, d fs.DirEntry, e error) error {
			if e == nil && !d.IsDir() && strings.HasPrefix(d.Name(), "rollout-") && strings.HasSuffix(d.Name(), "-"+owner.Session+".jsonl") {
				path = p
			}
			return nil
		})
	}
	return path
}
func readTranscript(path string, owner Owner, after int64) (*Transcript, error) {
	if after < 0 {
		return nil, errf("INVALID", "after 需要非负字节偏移")
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, errf("NOT_FOUND", "找不到父 Agent 的会话记录")
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if after > st.Size() {
		after = 0
	}
	if _, err = f.Seek(after, 0); err != nil {
		return nil, err
	}
	out := &Transcript{Engine: owner.Engine, Session: owner.Session, Path: path, Items: []TranscriptItem{}, Next: after}
	r := bufio.NewReader(f)
	for len(out.Items) < 2000 {
		line, e := r.ReadBytes('\n')
		if e == io.EOF {
			break
		}
		if e != nil {
			return nil, e
		}
		items := parseTranscriptLine(line, owner.Engine)
		// Keep a whole JSONL record for the next page rather than dropping its tail.
		if len(out.Items)+len(items) > 2000 && len(out.Items) > 0 {
			break
		}
		if len(items) > 2000 {
			items = items[:2000]
		}
		out.Items = append(out.Items, items...)
		out.Next += int64(len(line))
	}
	sort.SliceStable(out.Items, func(i, j int) bool { return out.Items[i].At < out.Items[j].At })
	return out, nil
}
func str(m map[string]any, k string) string { s, _ := m[k].(string); return s }
func object(v any) map[string]any           { m, _ := v.(map[string]any); return m }
func parseTranscriptLine(line []byte, engine string) []TranscriptItem {
	var row map[string]any
	if json.Unmarshal(line, &row) != nil {
		return nil
	}
	at := int64(0)
	switch ts := row["timestamp"].(type) {
	case string:
		if t, e := time.Parse(time.RFC3339Nano, ts); e == nil {
			at = t.UnixMilli()
		}
	case float64:
		at = int64(ts)
	}
	var content any
	role := ""
	if engine == "claude" {
		if row["isSidechain"] == true || row["isMeta"] == true || row["isCompactSummary"] == true {
			return nil
		}
		role = str(row, "type")
		if role != "user" && role != "assistant" {
			return nil
		}
		msg := object(row["message"])
		content = msg["content"]
	} else {
		if str(row, "type") != "response_item" {
			return nil
		}
		p := object(row["payload"])
		switch str(p, "type") {
		case "message":
			role = str(p, "role")
			if role != "user" && role != "assistant" {
				return nil
			}
			if str(p, "channel") == "analysis" {
				return nil
			}
			content = p["content"]
		case "custom_tool_call", "function_call":
			input := p["arguments"]
			if input == nil {
				input = p["input"]
			}
			return []TranscriptItem{toolItem(at, str(p, "name"), input)}
		default:
			return nil
		}
	}
	out := []TranscriptItem{}
	addText := func(text string) {
		text = strings.TrimSpace(text)
		if role == "user" {
			text = cleanUserText(text)
		}
		// "No response requested." is Claude Code's stock reply to a message that asked for nothing.
		if text == "" || role == "assistant" && text == "No response requested." {
			return
		}
		if role == "user" && (strings.Contains(text, "<environment_context>") || strings.HasPrefix(text, "# AGENTS.md instructions") || strings.HasPrefix(text, "<permissions instructions>")) {
			return
		}
		out = append(out, TranscriptItem{At: at, Role: role, Text: text})
	}
	if s, ok := content.(string); ok {
		addText(s)
		return out
	}
	blocks, _ := content.([]any)
	for _, b := range blocks {
		v := object(b)
		switch str(v, "type") {
		case "text", "input_text", "output_text":
			addText(str(v, "text"))
		case "thinking":
			// Claude Code files what the owner says ahead of a tool call here; most blocks carry only a signature.
			if role == "assistant" {
				addText(str(v, "thinking"))
			}
		case "tool_use":
			if role == "assistant" {
				out = append(out, toolItem(at, str(v, "name"), v["input"]))
			}
		}
	}
	return out
}

var weaverPattern = regexp.MustCompile(`(?:^|[\s/;|&"'` + "`" + `])weaver\s+([a-z]+)(?:\s+([a-z]+))?`)
var weaverFlag = regexp.MustCompile(`--(mission|package)(?:=|\s+)(?:"([^"]*)"|'([^']*)'|([^\s;|&"']+))`)

func toolItem(at int64, name string, input any) TranscriptItem {
	raw := ""
	if s, ok := input.(string); ok {
		raw = s
		var parsed any
		if json.Unmarshal([]byte(s), &parsed) == nil {
			input = parsed
		}
	} else {
		b, _ := json.Marshal(input)
		raw = string(b)
	}
	summary := ""
	search := raw
	p := object(input)
	for _, key := range []string{"command", "cmd", "file_path", "path", "pattern", "query", "url", "skill"} {
		if s := str(p, key); s != "" {
			summary = s
			if key == "command" || key == "cmd" {
				search = s
			}
			break
		}
	}
	if summary == "" {
		summary = raw
	}
	if d := strings.TrimSpace(str(p, "description")); d != "" {
		summary = d
	}
	summary = strings.SplitN(summary, "\n", 2)[0]
	item := TranscriptItem{At: at, Role: "tool", Tool: name, Text: sessionSummary(name + ": " + summary)}
	if loc := convorelCommand.FindStringIndex(search); loc != nil {
		if m := convorelID.FindStringSubmatch(search[loc[1]:]); m != nil {
			item.Ref = "convorel:" + m[1] + m[2] + m[3]
		}
	}
	if m := weaverPattern.FindStringSubmatch(search); m != nil {
		cmd := m[1]
		switch cmd {
		case "plan", "dialogue", "mission", "artifact", "package", "timer", "account", "worker", "engine", "config", "service":
			if m[2] != "" {
				cmd += " " + m[2]
			}
		}
		w := &WeaverCall{Command: cmd}
		for _, f := range weaverFlag.FindAllStringSubmatch(strings.ReplaceAll(search, `\"`, `"`), -1) {
			v := f[2] + f[3] + f[4]
			if f[1] == "mission" {
				w.Mission = v
			} else {
				w.Package = v
			}
		}
		item.Weaver = w
	}
	return item
}

var userWrapper = regexp.MustCompile(`(?s)<(system-reminder|command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat)>.*?</(?:system-reminder|command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat)>`)

// Only ask and followup send a question; wait, result, history and the rest read one back.
var convorelCommand = regexp.MustCompile(`(?:^|[\s/;|&"'])convorel\s+(?:--(?:config-dir|state-dir)(?:=|\s+)\S+\s+)*(?:ask|followup)\s+`)
var convorelID = regexp.MustCompile(`--id(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s;|&"']+))`)

func cleanUserText(s string) string {
	if strings.HasPrefix(s, "Base directory for this skill:") || strings.HasPrefix(s, "[Request interrupted") {
		return ""
	}
	return strings.TrimSpace(userWrapper.ReplaceAllString(s, ""))
}
func sessionSummary(s string) string {
	r := []rune(s)
	if len(r) > 300 {
		return string(r[:299]) + "…"
	}
	return s
}
