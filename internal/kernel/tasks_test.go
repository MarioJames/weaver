package kernel

import (
	"encoding/json"
	"os"
	"path/filepath"
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
		if len(items) != 1 || items[0].Role != "tool" || items[0].Tool != "exec" || items[0].Text != "exec: weaver dialogue start --mission=m_x" {
			t.Fatalf("%+v", items)
		}
	}
}

// A multi-line command is summarised by its first line.
func TestToolSummaryFirstLine(t *testing.T) {
	item := toolItem(1, "Bash", map[string]any{"command": "export TEST_VALUE=1\nweaver verdict --mission 'm_x' --package=p_x accept"})
	if item.Text != "Bash: export TEST_VALUE=1" {
		t.Fatalf("item=%+v", item)
	}
}
