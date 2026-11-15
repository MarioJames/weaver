package kernel

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func fakeConvorel(t *testing.T, fn func(string) ([]byte, error)) {
	t.Helper()
	old := readConvorelHistory
	readConvorelHistory = func(_ context.Context, id string) ([]byte, error) { return fn(id) }
	t.Cleanup(func() { readConvorelHistory = old })
}
func convorelJSON(at int64, complete bool) []byte {
	stamp := func(n int64) string { return time.UnixMilli(n).UTC().Format(time.RFC3339Nano) }
	state := "waiting"
	if complete {
		state = "complete"
	}
	v := map[string]any{"id": "t-1", "runs": []any{
		map[string]any{"id": "one", "state": "complete", "input": strings.Repeat("问题一🙂", 400), "submittedAt": stamp(at), "lastObservedAt": stamp(at + 10), "observedModel": "6 Pro", "reply": map[string]any{"final": true, "markdown": strings.Repeat("答复一🙂", 400)}},
		map[string]any{"id": "two", "state": state, "input": "问题二", "submittedAt": stamp(at + 20), "lastObservedAt": stamp(at + 30), "observedModel": "6 Pro", "reply": map[string]any{"final": complete, "markdown": "答复二"}},
	}}
	b, _ := json.Marshal(v)
	return b
}
func convorelMission(t *testing.T) (*fixture, string, int64) {
	t.Helper()
	f := newFixture(t)
	t.Setenv("HOME", f.home)
	m := f.mission()
	info, _ := f.k.Mission(m)
	at := info.CreatedAt
	injectTimelineItems(t, f, m, SessionItem{At: at, Role: "tool", Tool: "Bash", Text: "convorel ask --id t-1"}, SessionItem{At: at + 20, Role: "tool", Tool: "Bash", Text: "convorel followup --id t-1"}, SessionItem{At: at + 40, Role: "tool", Tool: "Bash", Text: "pwd"})
	if err := f.k.write(func(tx *tx) error {
		_, e := tx.Exec(`UPDATE session_items SET ref='convorel:t-1' WHERE text LIKE 'convorel%'`)
		return e
	}); err != nil {
		t.Fatal(err)
	}
	return f, m, at
}
func TestTimelineConvorelA23AndCompletedCache(t *testing.T) {
	f, m, at := convorelMission(t)
	calls := 0
	fakeConvorel(t, func(id string) ([]byte, error) {
		calls++
		if id != "t-1" {
			t.Fatal(id)
		}
		return convorelJSON(at, true), nil
	})
	v := timeline(t, f, m)
	es := entriesOf(v, "ask", "review")
	if len(es) != 4 {
		t.Fatalf("want two rounds: %+v", v.Entries)
	}
	for i, e := range es {
		want := []string{strings.Repeat("问题一🙂", 400), strings.Repeat("答复一🙂", 400), "问题二", "答复二"}[i]
		full, err := f.k.MissionText(m, e.Ref)
		title := fmt.Sprintf("问 Convorel · 第 %d 轮", i/2+1)
		if e.Kind == "review" {
			title = fmt.Sprintf("Convorel · 第 %d 轮回复", i/2+1)
			if e.Model != "6 Pro" || e.State != "complete" {
				t.Fatalf("%+v", e)
			}
		}
		if err != nil || full.Text != want || full.Title != title || e.Convorel != "t-1" || e.Round != i/2+1 || e.Chars != len([]rune(want)) {
			t.Fatalf("%+v full=%+v err=%v", e, full, err)
		}
		if _, err = f.k.MissionText(f.mission(), e.Ref); err == nil {
			t.Fatal("foreign ref allowed")
		}
	}
	ops := entriesOf(v, "ops")
	if len(ops) != 1 || len(ops[0].Ops) != 1 || ops[0].Ops[0].Text != "pwd" {
		t.Fatalf("%+v", ops)
	}
	timeline(t, f, m)
	if calls != 1 {
		t.Fatalf("completed cache calls=%d", calls)
	}
	injectTimelineItems(t, f, m, SessionItem{At: at + 50, Role: "tool", Tool: "Bash", Text: "convorel history --id t-1"})
	if err := f.k.write(func(tx *tx) error {
		_, e := tx.Exec(`UPDATE session_items SET ref='convorel:t-1' WHERE text LIKE 'convorel%'`)
		return e
	}); err != nil {
		t.Fatal(err)
	}
	timeline(t, f, m)
	if calls != 2 {
		t.Fatalf("new operation did not invalidate: %d", calls)
	}
}
func TestTimelineConvorelA24Fallback(t *testing.T) {
	for _, tc := range []struct {
		name string
		body []byte
		err  error
	}{
		{name: "missing command", err: errors.New("找不到命令")},
		{name: "invalid JSON", body: []byte("not JSON")},
		{name: "missing record", body: []byte(`{}`)},
		{name: "wrong record", body: []byte(`{"id":"other","runs":[]}`)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f, m, _ := convorelMission(t)
			fakeConvorel(t, func(string) ([]byte, error) { return tc.body, tc.err })
			v := timeline(t, f, m)
			ops := entriesOf(v, "ops")
			count := 0
			for _, group := range ops {
				count += len(group.Ops)
			}
			if len(entriesOf(v, "ask", "review")) != 0 || count != 3 {
				t.Fatalf("%+v", v.Entries)
			}
		})
	}
}
func TestTimelineConvorelWaitingRefresh(t *testing.T) {
	f, m, at := convorelMission(t)
	var done atomic.Bool
	var calls atomic.Int32
	fakeConvorel(t, func(string) ([]byte, error) { calls.Add(1); return convorelJSON(at, done.Load()), nil })
	v := timeline(t, f, m)
	reviews := entriesOf(v, "review")
	if len(reviews) != 2 || reviews[1].State != "waiting" || reviews[1].Text != "" || reviews[1].At != at+21 {
		t.Fatalf("%+v", reviews)
	}
	have := []string{}
	for _, e := range v.Entries {
		have = append(have, e.Hash)
	}
	done.Store(true)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	start := time.Now()
	next, err := f.k.Timeline(ctx, TimelineInput{Mission: m, From: v.Entries[0].Ord, Have: have, Wait: true})
	if err != nil {
		t.Fatal(err)
	}
	reviews = entriesOf(next, "review")
	if len(reviews) != 1 || reviews[0].State != "complete" || reviews[0].Text != "答复二" || calls.Load() != 2 {
		t.Fatalf("%+v calls=%d", next, calls.Load())
	}
	t.Logf("waiting review refreshed after %s", time.Since(start))
}
func TestTimelineConvorelDisplayBounds(t *testing.T) {
	f, m, at := convorelMission(t)
	injectTimelineItems(t, f, m, SessionItem{At: at + 15, Role: "user", Text: "next mission"})
	if err := f.k.write(func(tx *tx) error { _, e := tx.Exec(`UPDATE missions SET closed_at=? WHERE id=?`, at+12, m); return e }); err != nil {
		t.Fatal(err)
	}
	fakeConvorel(t, func(string) ([]byte, error) { return convorelJSON(at, true), nil })
	v := timeline(t, f, m)
	es := entriesOf(v, "ask", "review")
	if len(es) != 2 || es[0].Round != 1 || es[1].Round != 1 {
		t.Fatalf("%+v", es)
	}
	if _, err := f.k.MissionText(m, "ask:t-1:2"); err == nil {
		t.Fatal("out of range round allowed")
	}
}

func TestTimelineConvorelLowerBound(t *testing.T) {
	f := newFixture(t)
	t.Setenv("HOME", f.home)
	first, second := f.mission(), f.mission()
	injectTimelineItems(t, f, first, SessionItem{At: 50, Role: "user", Text: "first"}, SessionItem{At: 250, Role: "user", Text: "second"}, SessionItem{At: 260, Role: "tool", Tool: "Bash", Text: "convorel followup --id t-1"})
	if err := f.k.write(func(tx *tx) error {
		if _, e := tx.Exec(`UPDATE missions SET owner_engine='claude',owner_session='s',created_at=CASE id WHEN ? THEN 100 ELSE 300 END,closed_at=CASE id WHEN ? THEN 200 ELSE NULL END WHERE id IN (?,?)`, first, first, first, second); e != nil {
			return e
		}
		_, e := tx.Exec(`UPDATE session_items SET ref='convorel:t-1' WHERE role='tool'`)
		return e
	}); err != nil {
		t.Fatal(err)
	}
	fakeConvorel(t, func(string) ([]byte, error) { return convorelJSON(230, true), nil })
	es := entriesOf(timeline(t, f, second), "ask", "review")
	if len(es) != 2 || es[0].Round != 2 || es[1].Round != 2 || es[0].At != 250 {
		t.Fatalf("%+v", es)
	}
	if _, err := f.k.MissionText(second, "ask:t-1:1"); err == nil {
		t.Fatal("previous mission question allowed")
	}
}

func TestTimelineConvorelCreatedFallbackAndFailed(t *testing.T) {
	f, m, at := convorelMission(t)
	fakeConvorel(t, func(string) ([]byte, error) {
		var h map[string]any
		if err := json.Unmarshal(convorelJSON(at, true), &h); err != nil {
			t.Fatal(err)
		}
		runs := h["runs"].([]any)
		first := runs[0].(map[string]any)
		first["createdAt"], first["submittedAt"] = first["submittedAt"], ""
		first["reply"].(map[string]any)["final"] = false
		runs[1].(map[string]any)["state"] = "failed"
		b, e := json.Marshal(h)
		return b, e
	})
	es := entriesOf(timeline(t, f, m), "ask", "review")
	if len(es) != 4 || es[0].At != at || es[1].State != "waiting" || es[1].Text != "" || es[1].At != at+1 || es[3].State != "failed" || es[3].At != at+30 {
		t.Fatalf("%+v", es)
	}
}

func TestConvorelCommandLookupAndDeadline(t *testing.T) {
	for _, fallback := range []bool{false, true} {
		t.Run(fmt.Sprint(fallback), func(t *testing.T) {
			home, bin := t.TempDir(), t.TempDir()
			t.Setenv("HOME", home)
			t.Setenv("PATH", bin)
			dir := bin
			if fallback {
				dir = filepath.Join(home, ".local", "bin")
			}
			if err := os.MkdirAll(dir, 0700); err != nil {
				t.Fatal(err)
			}
			script := "#!/bin/sh\n[ \"$1\" = history ] && [ \"$2\" = --id ] || exit 2\nprintf '%s' \"$3\"\n"
			if err := os.WriteFile(filepath.Join(dir, "convorel"), []byte(script), 0700); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			b, err := readConvorelHistory(ctx, "t-1")
			if err != nil || string(b) != "t-1" {
				t.Fatalf("%s %v", b, err)
			}
		})
	}
	f, m, _ := convorelMission(t)
	old := readConvorelHistory
	readConvorelHistory = func(ctx context.Context, _ string) ([]byte, error) {
		deadline, ok := ctx.Deadline()
		remaining := time.Until(deadline)
		if !ok || remaining <= 0 || remaining > 3*time.Second {
			t.Errorf("missing three-second deadline: %v %s", ok, remaining)
		}
		return nil, context.DeadlineExceeded
	}
	t.Cleanup(func() { readConvorelHistory = old })
	if len(entriesOf(timeline(t, f, m), "ask", "review")) != 0 {
		t.Fatal("timeout must keep operations")
	}
}
