package kernel

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSessionBackfillA21(t *testing.T) {
	f := newFixture(t)
	t.Setenv("HOME", f.home)
	p := filepath.Join(f.home, ".claude/projects/test/s.jsonl")
	os.MkdirAll(filepath.Dir(p), 0700)
	os.WriteFile(p, []byte("{\"type\":\"user\",\"message\":{\"content\":\"hello\"}}\n{\"type\":\"assistant\",\"message\":{\"content\":\"reply\"}}\n"), 0600)
	m, err := f.k.CreateMission("", "task", f.ws, nil, &Owner{Engine: "claude", Session: "s"})
	if err != nil {
		t.Fatal(err)
	}
	if err = f.k.SyncMissionSession(m.ID); err != nil {
		t.Fatal(err)
	}
	items, err := f.k.SessionItems("claude", "s", 0, 0)
	if err != nil || len(items) != 2 {
		t.Fatalf("%v %v", items, err)
	}
}

func sessionLine(engine, role, text string) string {
	var v any
	if engine == "claude" {
		v = map[string]any{"type": role, "timestamp": int64(100), "message": map[string]any{"content": text}}
	} else {
		v = map[string]any{"type": "response_item", "timestamp": int64(100), "payload": map[string]any{"type": "message", "role": role, "content": []any{map[string]any{"type": "input_text", "text": text}}}}
	}
	b, _ := json.Marshal(v)
	return string(b) + "\n"
}
func sessionPath(t *testing.T, home, engine string) string {
	t.Helper()
	p := filepath.Join(home, ".claude/projects/test/s.jsonl")
	if engine == "codex" {
		p = filepath.Join(home, ".codex/sessions/2026/rollout-date-s.jsonl")
	}
	if err := os.MkdirAll(filepath.Dir(p), 0700); err != nil {
		t.Fatal(err)
	}
	return p
}
func putSession(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0600); err != nil {
		t.Fatal(err)
	}
}
func getSessionItems(t *testing.T, k *Kernel, engine string) []SessionItem {
	t.Helper()
	items, err := k.SessionItems(engine, "s", 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	return items
}
func toolRecord(engine, command, description string) string {
	input := map[string]any{"command": command, "description": description}
	var row any
	if engine == "claude" {
		row = map[string]any{"type": "assistant", "message": map[string]any{"content": []any{map[string]any{"type": "tool_use", "name": "Bash", "input": input}}}}
	} else {
		b, _ := json.Marshal(input)
		row = map[string]any{"type": "response_item", "payload": map[string]any{"type": "function_call", "name": "exec_command", "arguments": string(b)}}
	}
	b, _ := json.Marshal(row)
	return string(b) + "\n"
}
func outputRecord(engine, text string) string {
	var row any
	if engine == "claude" {
		row = map[string]any{"type": "user", "message": map[string]any{"content": []any{map[string]any{"type": "tool_result", "content": text}}}}
	} else {
		row = map[string]any{"type": "response_item", "payload": map[string]any{"type": "function_call_output", "output": text}}
	}
	b, _ := json.Marshal(row)
	return string(b) + "\n"
}
func TestSessionFilteringAndBackfillA10A21(t *testing.T) {
	for _, engine := range []string{"claude", "codex"} {
		t.Run(engine, func(t *testing.T) {
			f := newFixture(t)
			t.Setenv("HOME", f.home)
			p := sessionPath(t, f.home, engine)
			body := ""
			for i := 0; i < 3; i++ {
				body += sessionLine(engine, "user", fmt.Sprintf("question %d", i)) + sessionLine(engine, "assistant", fmt.Sprintf("answer %d", i))
			}
			body += toolRecord(engine, strings.Repeat("x", 1000)+"; convorel ask --id foo-1 hi", "  description\nsecond line") + outputRecord(engine, strings.Repeat("private output", 100000))
			if engine == "claude" {
				body += `{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"","signature":"sig"}]}}` + "\n"
			} else {
				body += `{"type":"response_item","payload":{"type":"reasoning","summary":"secret thought"}}` + "\n" + `{"type":"response_item","payload":{"type":"message","role":"assistant","channel":"analysis","content":[{"type":"output_text","text":"secret thought"}]}}` + "\n"
			}
			putSession(t, p, body)
			m, err := f.k.CreateMission("", "task", f.ws, nil, &Owner{Engine: engine, Session: "s"})
			if err != nil {
				t.Fatal(err)
			}
			items := getSessionItems(t, f.k, engine)
			counts := map[string]int{}
			size := 0
			var direct []TranscriptItem
			for _, line := range strings.Split(body, "\n") {
				direct = append(direct, parseTranscriptLine([]byte(line), engine)...)
			}
			if len(items) != len(direct) || len(items) != 7 {
				t.Fatalf("database=%d direct=%d", len(items), len(direct))
			}
			for _, v := range items {
				counts[v.Role]++
				size += len(v.Text)
				if strings.Contains(v.Text, "private output") || strings.Contains(v.Text, "secret thought") {
					t.Fatal(v)
				}
			}
			if counts["user"] != 3 || counts["assistant"] != 3 || counts["tool"] != 1 || size > len(body)/100 {
				t.Fatalf("%v bytes=%d/%d", counts, size, len(body))
			}
			tool := items[6]
			if tool.Ref != "convorel:foo-1" || !strings.HasSuffix(tool.Text, "description") {
				t.Fatal(tool)
			}
			if err = f.k.SyncMissionSession(m.ID); err != nil {
				t.Fatal(err)
			}
			if len(getSessionItems(t, f.k, engine)) != 7 {
				t.Fatal("duplicate")
			}
			one, err := f.k.SessionItem(items[0].Seq)
			if err != nil || one.Text != items[0].Text {
				t.Fatalf("%v %v", one, err)
			}
			byTime, err := f.k.SessionItemsAt(engine, "s", 100, 100)
			if err != nil || len(byTime) != 6 {
				t.Fatalf("time range %v %v", byTime, err)
			}
			bySeq, err := f.k.SessionItems(engine, "s", items[0].Seq, items[1].Seq)
			if err != nil || len(bySeq) != 1 {
				t.Fatalf("seq range %v %v", bySeq, err)
			}
		})
	}
}
func TestSessionUserFilters(t *testing.T) {
	for _, engine := range []string{"claude", "codex"} {
		for _, text := range []string{"Base directory for this skill: /tmp/skill\nbody", "[Request interrupted by user]", "<system-reminder>automated</system-reminder>", "<local-command-caveat>note</local-command-caveat><command-name>/clear</command-name><command-message>clear</command-message><command-args></command-args>", "<local-command-stdout>done</local-command-stdout>", "<environment_context>env</environment_context>", "# AGENTS.md instructions for repo", "<permissions instructions>rules"} {
			if got := parseTranscriptLine([]byte(sessionLine(engine, "user", text)), engine); len(got) != 0 {
				t.Fatalf("%s %q: %v", engine, text, got)
			}
		}
		got := parseTranscriptLine([]byte(sessionLine(engine, "user", "hello<system-reminder>private</system-reminder>world")), engine)
		if len(got) != 1 || got[0].Text != "helloworld" {
			t.Fatal(got)
		}
	}
	// Claude Code's stock reply to a message that asked for nothing is not something the owner said.
	if got := parseTranscriptLine([]byte(sessionLine("claude", "assistant", "No response requested.")), "claude"); len(got) != 0 {
		t.Fatalf("placeholder reply kept: %+v", got)
	}
	// Claude Code records what the owner says ahead of a tool call as a thinking block; a signature-only block says nothing.
	thinking := `{"type":"assistant","timestamp":100,"message":{"content":[{"type":"thinking","thinking":"","signature":"x"},{"type":"thinking","thinking":" 先看选路代码。\n","signature":"y"},{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]}}`
	if got := parseTranscriptLine([]byte(thinking), "claude"); len(got) != 2 || got[0].Role != "assistant" || got[0].Text != "先看选路代码。" || got[1].Role != "tool" {
		t.Fatalf("thinking block: %+v", got)
	}
	for _, flag := range []string{"isMeta", "isSidechain", "isCompactSummary"} {
		line := fmt.Sprintf(`{"type":"user",%q:true,"message":{"content":"hidden"}}`, flag)
		if len(parseTranscriptLine([]byte(line), "claude")) != 0 {
			t.Fatal(flag)
		}
	}
	for _, engine := range []string{"claude", "codex"} {
		v := parseTranscriptLine([]byte(toolRecord(engine, "echo --id other; "+strings.Repeat("x", 900)+"; convorel followup --id foo-1", "")), engine)[0]
		if len([]rune(v.Text)) > 300 || v.Ref != "convorel:foo-1" {
			t.Fatal(v)
		}
		// Only sending a question joins the conversation; reading one back does not.
		for command, want := range map[string]string{
			"convorel ask --id a-1 --prompt-file q.md":                     "convorel:a-1",
			"convorel --state-dir /tmp/s followup --id a-2 --request-id r": "convorel:a-2",
			"convorel history --id a-3":                                    "",
			"convorel wait --id a-4 --timeout-seconds 600":                 "",
			"convorel result --id a-5":                                     "",
			"convorel status --id a-6":                                     "",
		} {
			if got := parseTranscriptLine([]byte(toolRecord(engine, command, "")), engine)[0]; got.Ref != want {
				t.Fatalf("%s %q: ref=%q want %q", engine, command, got.Ref, want)
			}
		}
	}
}

// A message the user types while the agent is working is recorded as a queued
// command, not as a user row; background task notifications use the same record.
func TestSessionQueuedUserMessage(t *testing.T) {
	line := func(mode string, prompt any) []byte {
		b, _ := json.Marshal(map[string]any{"type": "attachment", "timestamp": "2026-11-15T14:26:59.106Z", "attachment": map[string]any{"type": "queued_command", "commandMode": mode, "prompt": prompt}})
		return b
	}
	for _, prompt := range []any{"头像多给我几个风格", []any{map[string]any{"type": "text", "text": "头像多给我几个风格"}}} {
		got := parseTranscriptLine(line("prompt", prompt), "claude")
		if len(got) != 1 || got[0].Role != "user" || got[0].Text != "头像多给我几个风格" || got[0].At == 0 {
			t.Fatalf("%v: %+v", prompt, got)
		}
	}
	if got := parseTranscriptLine(line("task-notification", "<task-notification>done</task-notification>"), "claude"); len(got) != 0 {
		t.Fatalf("notification kept: %+v", got)
	}
	if got := parseTranscriptLine([]byte(`{"type":"attachment","attachment":{"type":"file","prompt":"x"}}`), "claude"); len(got) != 0 {
		t.Fatalf("other attachment kept: %+v", got)
	}
}
func TestSessionFollowSharedPartialMissingA14(t *testing.T) {
	for _, engine := range []string{"claude", "codex"} {
		t.Run(engine, func(t *testing.T) {
			f := newFixture(t)
			t.Setenv("HOME", f.home)
			p := sessionPath(t, f.home, engine)
			initial := sessionLine(engine, "user", "initial")
			putSession(t, p, initial)
			m1, err := f.k.CreateMission("", "one", f.ws, nil, &Owner{Engine: engine, Session: "s"})
			if err != nil {
				t.Fatal(err)
			}
			m2 := f.mission()
			if _, err = f.k.SetMissionOwner(m2, engine, "s"); err != nil {
				t.Fatal(err)
			}
			c1, u1 := f.k.subscribe(m1.ID)
			defer u1()
			c2, u2 := f.k.subscribe(m2)
			defer u2()
			line := sessionLine(engine, "assistant", "new reply")
			putSession(t, p, initial+strings.TrimSuffix(line, "\n"))
			if err = f.k.SyncMissionSession(m1.ID); err != nil {
				t.Fatal(err)
			}
			if len(getSessionItems(t, f.k, engine)) != 1 {
				t.Fatal("half record consumed")
			}
			start := time.Now()
			putSession(t, p, initial+line)
			for _, ch := range []chan struct{}{c1, c2} {
				select {
				case <-ch:
				case <-time.After(time.Second - time.Since(start)):
					t.Fatal("no follow notification within one second")
				}
			}
			if len(getSessionItems(t, f.k, engine)) != 2 {
				t.Fatal("shared session duplicated or missing")
			}
			if err = f.k.SyncMissionSession(m1.ID); err != nil {
				t.Fatal(err)
			}
			if len(getSessionItems(t, f.k, engine)) != 2 {
				t.Fatal("partial duplicated")
			}
			if err = os.Remove(p); err != nil {
				t.Fatal(err)
			}
			if err = f.k.SyncMissionSession(m1.ID); err != nil {
				t.Fatal(err)
			}
			var state string
			f.k.read(func() error {
				return f.k.db.QueryRow(`SELECT state FROM owner_sessions WHERE engine=?`, engine).Scan(&state)
			})
			if state != "missing" || len(getSessionItems(t, f.k, engine)) != 2 {
				t.Fatalf("state=%s", state)
			}
		})
	}
}
func TestSessionRewrittenAndValidation(t *testing.T) {
	f := newFixture(t)
	t.Setenv("HOME", f.home)
	p := sessionPath(t, f.home, "claude")
	putSession(t, p, sessionLine("claude", "user", "one"))
	m := f.mission()
	for _, o := range []Owner{{"other", "s"}, {"claude", "../s"}, {"codex", "a\\b"}, {"claude", ""}} {
		if _, err := f.k.SetMissionOwner(m, o.Engine, o.Session); err == nil {
			t.Fatalf("accepted %v", o)
		}
		// A mission may be owned by an engine Weaver cannot read; only a session
		// identifier that could escape the sessions directory is refused.
		_, err := f.k.CreateMission("", "bad", f.ws, nil, &o)
		if unsafe := strings.ContainsAny(o.Session, "/\\"); unsafe != (err != nil) {
			t.Fatalf("create %v: %v", o, err)
		}
	}
	if _, err := f.k.SetMissionOwner(m, "claude", "s"); err != nil {
		t.Fatal(err)
	}
	putSession(t, p, "")
	if err := f.k.SyncMissionSession(m); err != nil {
		t.Fatal(err)
	}
	var state string
	f.k.read(func() error { return f.k.db.QueryRow(`SELECT state FROM owner_sessions`).Scan(&state) })
	if state != "rewritten" || len(getSessionItems(t, f.k, "claude")) != 1 {
		t.Fatal(state)
	}
}
func TestSessionResumeAndPerformanceA13(t *testing.T) {
	for _, engine := range []string{"claude", "codex"} {
		t.Run(engine, func(t *testing.T) {
			f := newFixture(t)
			t.Setenv("HOME", f.home)
			p := sessionPath(t, f.home, engine)
			record := sessionLine(engine, "user", "hello") + sessionLine(engine, "assistant", "world") + outputRecord(engine, strings.Repeat("x", 10000))
			body := strings.Repeat(record, 3100)
			putSession(t, p, body)
			m := f.mission()
			c, unsubscribe := f.k.subscribe(m)
			defer unsubscribe()
			done := make(chan error, 1)
			go func() { _, err := f.k.SetMissionOwner(m, engine, "s"); done <- err }()
			select {
			case <-c:
			case <-time.After(5 * time.Second):
				t.Fatal("first batch timeout")
			}
			f.k.Close()
			if err := <-done; err != nil {
				t.Fatal(err)
			}
			var offset int64
			f.k.read(func() error { return f.k.db.QueryRow(`SELECT offset FROM owner_sessions`).Scan(&offset) })
			if offset <= 0 || offset >= int64(len(body)) {
				t.Fatalf("not interrupted between batches: %d/%d", offset, len(body))
			}
			restarted := open(t, f.home, f.eng, f.push)
			start := time.Now()
			syncDone := make(chan error, 1)
			go func() { syncDone <- restarted.SyncMissionSession(m) }()
			maxWrite := time.Duration(0)
			for {
				select {
				case err := <-syncDone:
					if err != nil {
						t.Fatal(err)
					}
					goto synced
				default:
				}
				at := time.Now()
				if _, err := restarted.ArchiveMission(m, false); err != nil {
					t.Fatal(err)
				}
				if d := time.Since(at); d > maxWrite {
					maxWrite = d
				}
				time.Sleep(time.Millisecond)
			}
		synced:
			elapsed := time.Since(start)
			items := getSessionItems(t, restarted, engine)
			if len(items) != 6200 {
				t.Fatalf("count=%d", len(items))
			}
			if elapsed > 5*time.Second || maxWrite > time.Second {
				t.Fatalf("sync=%v max write=%v", elapsed, maxWrite)
			}
			// Compare against a separate uninterrupted import of the entire file.
			other := newFixture(t)
			t.Setenv("HOME", other.home)
			putSession(t, sessionPath(t, other.home, engine), body)
			at := time.Now()
			_, err := other.k.CreateMission("", "single", other.ws, nil, &Owner{Engine: engine, Session: "s"})
			if err != nil {
				t.Fatal(err)
			}
			full := time.Since(at)
			if len(getSessionItems(t, other.k, engine)) != len(items) || full > 5*time.Second {
				t.Fatalf("single import=%v", full)
			}
			t.Logf("%s: %.2f MiB, full=%v resume=%v max concurrent write=%v", engine, float64(len(body))/(1<<20), full, elapsed, maxWrite)
		})
	}
}

func TestSessionCreateWithExistingOwnerSyncsImmediately(t *testing.T) {
	f := newFixture(t)
	t.Setenv("HOME", f.home)
	p := sessionPath(t, f.home, "claude")
	body := sessionLine("claude", "user", "first")
	putSession(t, p, body)
	if _, err := f.k.CreateMission("", "first", f.ws, nil, &Owner{"claude", "s"}); err != nil {
		t.Fatal(err)
	}
	// Stop the follower so only the create call can import the append.
	f.k.Close()
	k := New(Options{DB: f.k.db, Home: f.home, Engines: f.eng})
	defer k.Close()
	k.sessionMu.Lock()
	// No follower tick occurs during this short create operation.
	putSession(t, p, body+sessionLine("claude", "user", "second"))
	k.sessionMu.Unlock()
	if _, err := k.CreateMission("", "second", f.ws, nil, &Owner{"claude", "s"}); err != nil {
		t.Fatal(err)
	}
	if len(getSessionItems(t, k, "claude")) != 2 {
		t.Fatal("existing owner not immediately synchronized")
	}
}

func TestSessionMissingRetryAndClosedMissionRefresh(t *testing.T) {
	f := newFixture(t)
	t.Setenv("HOME", f.home)
	m, err := f.k.CreateMission("", "missing", f.ws, nil, &Owner{"claude", "s"})
	if err != nil {
		t.Fatal(err)
	}
	p := sessionPath(t, f.home, "claude")
	putSession(t, p, sessionLine("claude", "user", "late"))
	if err = f.k.SyncMissionSession(m.ID); err != nil {
		t.Fatal(err)
	}
	if len(getSessionItems(t, f.k, "claude")) != 0 {
		t.Fatal("missing retried before 30 seconds")
	}
	if _, err = f.k.db.Exec(`UPDATE owner_sessions SET synced_at=synced_at-30000`); err != nil {
		t.Fatal(err)
	}
	if err = f.k.SyncMissionSession(m.ID); err != nil {
		t.Fatal(err)
	}
	if len(getSessionItems(t, f.k, "claude")) != 1 {
		t.Fatal("missing never retried")
	}
	// Old closed missions are read on demand, while recent closes keep following.
	if _, err = f.k.db.Exec(`UPDATE missions SET closed_at=? WHERE id=?`, time.Now().Add(-11*time.Minute).UnixMilli(), m.ID); err != nil {
		t.Fatal(err)
	}
	putSession(t, p, sessionLine("claude", "user", "late")+sessionLine("claude", "assistant", "after close"))
	time.Sleep(650 * time.Millisecond)
	if len(getSessionItems(t, f.k, "claude")) != 1 {
		t.Fatal("old closed mission still followed")
	}
	if err = f.k.SyncMissionSession(m.ID); err != nil {
		t.Fatal(err)
	}
	if len(getSessionItems(t, f.k, "claude")) != 2 {
		t.Fatal("closed mission failed to refresh")
	}
	if _, err = f.k.db.Exec(`UPDATE missions SET closed_at=? WHERE id=?`, time.Now().UnixMilli(), m.ID); err != nil {
		t.Fatal(err)
	}
	ch, unsubscribe := f.k.subscribe(m.ID)
	defer unsubscribe()
	putSession(t, p, sessionLine("claude", "user", "late")+sessionLine("claude", "assistant", "after close")+sessionLine("claude", "assistant", "final"))
	select {
	case <-ch:
	case <-time.After(time.Second):
		t.Fatal("recent close not followed")
	}
}
