package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestFindMissionOwner(t *testing.T) {
	for _, engine := range []string{"claude", "codex"} {
		t.Run(engine, func(t *testing.T) {
			root := t.TempDir()
			p := filepath.Join(root, "a.jsonl")
			body := `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"call","name":"Bash","input":{"command":"weaver mission create --title hi"}}]}}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"call","content":"{\"id\":\"m_test\"}"}]}}
`
			if engine == "codex" {
				p = filepath.Join(root, "rollout-date-a.jsonl")
				body = `{"type":"response_item","payload":{"type":"function_call","call_id":"call","name":"exec_command","arguments":"{\"cmd\":\"weaver mission create --title hi\"}"}}
{"type":"response_item","payload":{"type":"function_call_output","call_id":"call","output":"{\"id\":\"m_test\"}"}}
`
			}
			roots := map[string]string{engine: root}
			if _, err := findMissionOwner("m_test", roots); err == nil {
				t.Fatal("expected no match")
			}
			os.WriteFile(p, []byte(body), 0600)
			o, err := findMissionOwner("m_test", roots)
			if err != nil || o["session"] != "a" {
				t.Fatalf("%v %v", o, err)
			}
			other := filepath.Join(root, "b.jsonl")
			if engine == "codex" {
				other = filepath.Join(root, "rollout-date-b.jsonl")
			}
			os.WriteFile(other, []byte(body), 0600)
			if _, err = findMissionOwner("m_test", roots); err == nil {
				t.Fatal("expected ambiguity")
			}
		})
	}
}
