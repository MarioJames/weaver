package kernel

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func writeTaskFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0600); err != nil {
		t.Fatal(err)
	}
}
func TestTranscriptFormatsAndIncrement(t *testing.T) {
	for _, engine := range []string{"claude", "codex"} {
		t.Run(engine, func(t *testing.T) {
			f := newFixture(t)
			home := t.TempDir()
			t.Setenv("HOME", home)
			m, err := f.k.CreateMission("", "owner", f.ws, nil, &Owner{Engine: engine, Session: "fixture"})
			if err != nil {
				t.Fatal(err)
			}
			var path, body string
			if engine == "claude" {
				path = filepath.Join(home, ".claude/projects/project/fixture.jsonl")
				body = `{"type":"user","timestamp":"2026-01-01T00:00:00Z","message":{"content":"hello"}}
{"type":"assistant","timestamp":"2026-01-01T00:00:01Z","message":{"content":[{"type":"thinking","thinking":"secret"},{"type":"text","text":"reply"},{"type":"tool_use","name":"Bash","input":{"command":"weaver plan submit --mission m_test --package p_test"}}]}}
{"type":"user","message":{"content":[{"type":"tool_result","content":"secret"}]}}
{"type":"user","isMeta":true,"message":{"content":"secret"}}
{"type":"assistant","isSidechain":true,"message":{"content":"secret"}}
{"type":"attachment"}
unknown
`
			} else {
				path = filepath.Join(home, ".codex/sessions/nested/rollout-test-fixture.jsonl")
				body = `{"type":"response_item","timestamp":"2026-01-01T00:00:00Z","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]}}
{"type":"response_item","timestamp":"2026-01-01T00:00:01Z","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"reply"}]}}
{"type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\"cmd\":\"weaver plan submit --mission m_test --package p_test\"}"}}
{"type":"response_item","payload":{"type":"reasoning","summary":"secret"}}
{"type":"response_item","payload":{"type":"function_call_output","output":"secret"}}
{"type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"secret"}]}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>secret</environment_context>"}]}}
unknown
`
			}
			writeTaskFile(t, path, body)
			tr, err := f.k.MissionTranscript(m.ID, 0)
			if err != nil {
				t.Fatal(err)
			}
			if len(tr.Items) != 3 {
				t.Fatalf("items=%+v", tr.Items)
			}
			tool := 0
			for _, i := range tr.Items {
				if strings.Contains(i.Text, "secret") {
					t.Fatal("leak")
				}
				if i.Role == "tool" {
					tool++
					if i.Weaver == nil || i.Weaver.Command != "plan submit" || i.Weaver.Mission != "m_test" || i.Weaver.Package != "p_test" {
						t.Fatalf("weaver=%+v", i.Weaver)
					}
				}
			}
			if tool != 1 {
				t.Fatal(tool)
			}
			next := tr.Next
			tr, err = f.k.MissionTranscript(m.ID, next)
			if err != nil || len(tr.Items) != 0 || tr.Next != next {
				t.Fatalf("increment %+v %v", tr, err)
			}
			file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0600)
			if err != nil {
				t.Fatal(err)
			}
			_, err = file.WriteString(strings.Split(body, "\n")[0] + "\n")
			file.Close()
			if err != nil {
				t.Fatal(err)
			}
			tr, err = f.k.MissionTranscript(m.ID, next)
			if err != nil || len(tr.Items) != 1 {
				t.Fatalf("append %+v %v", tr, err)
			}
		})
	}
}
func TestTranscriptErrors(t *testing.T) {
	f := newFixture(t)
	t.Setenv("HOME", t.TempDir())
	for _, c := range []struct {
		owner     *Owner
		code, msg string
	}{{nil, "NOT_FOUND", "未记录父 Agent"}, {&Owner{"claude", "missing"}, "NOT_FOUND", "找不到父 Agent 的会话记录"}} {
		m, e := f.k.CreateMission("", "test", f.ws, nil, c.owner)
		if e != nil {
			t.Fatal(e)
		}
		_, e = f.k.MissionTranscript(m.ID, 0)
		if e == nil || AsError(e).Code != c.code || AsError(e).Message != c.msg {
			t.Fatalf("%v", e)
		}
	}
}
func TestTranscriptLegacyUnsupportedOwner(t *testing.T) {
	f := newFixture(t)
	id := f.mission()
	if _, err := f.k.db.Exec(`UPDATE missions SET owner_engine='other',owner_session='fixture' WHERE id=?`, id); err != nil {
		t.Fatal(err)
	}
	_, err := f.k.MissionTranscript(id, 0)
	if err == nil || AsError(err).Code != "INVALID" {
		t.Fatal(err)
	}
}
func TestArtifacts(t *testing.T) {
	f := newFixture(t)
	mission := f.mission()
	for _, c := range []struct {
		name, body, kind string
		summary          map[string]any
	}{
		{"design-v1.html", `<title>Design title</title><div class="other decision"></div><div class='decision'></div><p data-check-id="a"></p>`, "design", map[string]any{"decisions": float64(2), "checks": float64(1)}},
		{"REPORT.html", `<div data-status="pass"></div><div data-status='pass'></div><div data-status="fail"></div><section class="verdict"><span class="chip">通过</span><span class="chip">other</span></section>`, "report", map[string]any{"pass": float64(2), "fail": float64(1), "verdict": "通过"}},
		{"capture.json", "{}", "evidence", map[string]any{}}, {"note.txt", "note", "doc", map[string]any{}},
	} {
		path := filepath.Join(t.TempDir(), c.name)
		writeTaskFile(t, path, c.body)
		a, err := f.k.AddArtifact(ArtifactInput{Mission: mission, Path: path, URL: "https://example.test/" + c.name})
		if err != nil {
			t.Fatal(err)
		}
		if a.Kind != c.kind || a.Size != int64(len(c.body)) || len(a.SHA256) != 64 {
			t.Fatalf("artifact %+v", a)
		}
		var summary map[string]any
		if err = json.Unmarshal(a.Summary, &summary); err != nil {
			t.Fatal(err)
		}
		for key, v := range c.summary {
			if summary[key] != v {
				t.Fatalf("summary=%v", summary)
			}
		}
		if c.kind == "design" {
			if a.GroupKey != "design" || a.Title != "Design title" {
				t.Fatalf("%+v", a)
			}
			path2 := filepath.Join(t.TempDir(), "design-v2.html")
			writeTaskFile(t, path2, c.body)
			b, err := f.k.AddArtifact(ArtifactInput{Mission: mission, Path: path2, URL: a.URL})
			if err != nil || a.ID != b.ID || b.Path != path2 {
				t.Fatalf("idempotent %+v %v", b, err)
			}
			_, err = f.k.AddArtifact(ArtifactInput{Mission: mission, Path: path, URL: "https://example.test/second"})
			if err != nil {
				t.Fatal(err)
			}
		}
	}
	groups, err := f.k.Artifacts(mission)
	if err != nil {
		t.Fatal(err)
	}
	if len(groups) != 4 {
		t.Fatalf("%+v", groups)
	}
	for _, g := range groups {
		if g.GroupKey == "design" && len(g.Items) != 2 {
			t.Fatalf("versions %+v", g)
		}
	}
	m, err := f.k.Mission(mission)
	if err != nil || m.Artifacts != 5 {
		t.Fatalf("count %+v %v", m, err)
	}
	if err = f.k.RemoveArtifact(groups[0].Items[0].ID); err != nil {
		t.Fatal(err)
	}
	for _, in := range []ArtifactInput{{Mission: mission}, {Mission: mission, Path: "relative"}, {Mission: mission, Path: "/does/not/exist"}, {Mission: mission, URL: "https://example.test", Kind: "bad"}} {
		if _, err := f.k.AddArtifact(in); err == nil {
			t.Fatalf("accepted %+v", in)
		}
	}
}
func TestArchiveRules(t *testing.T) {
	f := newFixture(t)
	now := time.Date(2026, 11, 14, 12, 0, 0, 0, time.UTC)
	f.k.now = func() time.Time { return now }
	done, running, recent := f.mission(), f.mission(), f.mission()
	for _, c := range []struct {
		id, state string
		days      int
	}{{done, StateAccepted, 8}, {running, StateRunning, 10}, {recent, StateAccepted, 8}} {
		_, err := f.k.db.Exec(`INSERT INTO packages(id,mission_id,key,title,instruction,workspace,state,created_at,updated_at,position) VALUES(?,?,?,?,?,?,?,?,?,0)`, "p_"+c.id, c.id, "test", "test", "test", f.ws, c.state, 1, 1)
		if err != nil {
			t.Fatal(err)
		}
		_, err = f.k.db.Exec(`UPDATE missions SET created_at=? WHERE id=?`, now.Add(-time.Duration(c.days)*24*time.Hour).UnixMilli(), c.id)
		if err != nil {
			t.Fatal(err)
		}
	}
	if _, err := f.k.db.Exec(`INSERT INTO events(mission_id,kind,at) VALUES(?,?,?)`, recent, "test", now.UnixMilli()); err != nil {
		t.Fatal(err)
	}
	if err := f.k.SetSetting("archive_after_days", "0"); err != nil {
		t.Fatal(err)
	}
	if err := f.k.AutoArchive(); err != nil {
		t.Fatal(err)
	}
	m, _ := f.k.Mission(done)
	if m.Archived {
		t.Fatal("disabled")
	}
	if err := f.k.SetSetting("archive_after_days", "7"); err != nil {
		t.Fatal(err)
	}
	if err := f.k.AutoArchive(); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{done, running, recent} {
		m, err := f.k.Mission(id)
		if err != nil || m.Archived != (id == done) {
			t.Fatalf("archive %+v %v", m, err)
		}
	}
	m, err := f.k.ArchiveMission(done, false)
	if err != nil || m.Archived {
		t.Fatalf("restore %+v %v", m, err)
	}
	if _, err = f.k.ArchiveMission(running, true); err == nil || AsError(err).Message != "进行中的主任务不能归档" {
		t.Fatal(err)
	}
	if _, err = f.k.ArchiveMission(done, true); err != nil {
		t.Fatal(err)
	}
	list, err := f.k.Missions(true)
	if err != nil || len(list) != 2 {
		t.Fatalf("list %d %v", len(list), err)
	}
	list, err = f.k.Missions(false, true)
	if err != nil || len(list) != 1 || list[0].ID != done {
		t.Fatalf("archived %+v %v", list, err)
	}
	if err = f.k.SetSetting("archive_after_days", "2"); err == nil {
		t.Fatal("invalid setting")
	}
}
func TestTranscriptToolVariants(t *testing.T) {
	for _, raw := range []string{`{"type":"response_item","payload":{"type":"custom_tool_call","name":"exec","input":"weaver dialogue start --mission=m_x"}}`, `{"type":"response_item","payload":{"type":"function_call","name":"exec","arguments":"{\"command\":\"weaver dialogue start --mission=m_x\"}"}}`} {
		items := parseTranscriptLine([]byte(raw), "codex")
		if len(items) != 1 || items[0].Weaver == nil || items[0].Weaver.Command != "dialogue start" || items[0].Weaver.Mission != "m_x" {
			t.Fatalf("%+v", items)
		}
	}
}

func TestTranscriptPaginationAndPartialRecord(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.jsonl")
	line := `{"type":"user","message":{"content":"hello"}}` + "\n"
	writeTaskFile(t, path, strings.Repeat(line, 2001)+`{"type":"user"`)
	first, err := readTranscript(path, Owner{Engine: "claude"}, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Items) != 2000 || first.Next != int64(len(line)*2000) {
		t.Fatalf("page size=%d next=%d", len(first.Items), first.Next)
	}
	second, err := readTranscript(path, Owner{Engine: "claude"}, first.Next)
	if err != nil {
		t.Fatal(err)
	}
	if len(second.Items) != 1 || second.Next != int64(len(line)*2001) {
		t.Fatalf("second %+v", second)
	}
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	_, err = file.WriteString(`,"message":{"content":"completed"}}` + "\n")
	file.Close()
	if err != nil {
		t.Fatal(err)
	}
	third, err := readTranscript(path, Owner{Engine: "claude"}, second.Next)
	if err != nil || len(third.Items) != 1 || third.Items[0].Text != "completed" {
		t.Fatalf("completed %+v %v", third, err)
	}
}

func TestMultilineWeaverToolCommand(t *testing.T) {
	item := toolItem(1, "Bash", map[string]any{"command": "export TEST_VALUE=1\nweaver verdict --mission 'm_x' --package=p_x accept"})
	if item.Text != "Bash: export TEST_VALUE=1" || item.Weaver == nil || item.Weaver.Command != "verdict" || item.Weaver.Mission != "m_x" || item.Weaver.Package != "p_x" {
		t.Fatalf("item=%+v weaver=%+v", item, item.Weaver)
	}
}
