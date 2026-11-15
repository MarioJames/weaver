package kernel

import (
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

type TranscriptItem struct {
	At   int64  `json:"at"`
	Role string `json:"role"`
	Text string `json:"text"`
	Tool string `json:"tool,omitempty"`
	Ref  string `json:"ref,omitempty"`
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
		switch role {
		case "user", "assistant":
			content = object(row["message"])["content"]
		case "attachment":
			// What the user typed while the agent was working.
			q := object(row["attachment"])
			if str(q, "type") != "queued_command" || str(q, "commandMode") != "prompt" {
				return nil
			}
			role, content = "user", q["prompt"]
		default:
			return nil
		}
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
