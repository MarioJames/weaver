package kernel

import (
	"context"
	"database/sql"
	"fmt"
	"github.com/MarioJames/weaver/internal/store"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func timeline(t *testing.T, f *fixture, m string) *TimelineResult {
	t.Helper()
	v, e := f.k.Timeline(context.Background(), TimelineInput{Mission: m, Limit: 10000})
	if e != nil {
		t.Fatal(e)
	}
	return v
}
func entriesOf(v *TimelineResult, kinds ...string) []TimelineEntry {
	out := []TimelineEntry{}
	for _, e := range v.Entries {
		for _, k := range kinds {
			if e.Kind == k {
				out = append(out, e)
			}
		}
	}
	return out
}
func TestTimelineDispatchA4AndNoSessionA9(t *testing.T) {
	f := newFixture(t)
	m := f.mission()
	var plan []PackageInput
	for i := 0; i < 6; i++ {
		plan = append(plan, pkg(fmt.Sprintf("p%d", i)))
	}
	f.submit(m, plan...)
	v := timeline(t, f, m)
	d := entriesOf(v, "dispatch")
	if v.Session.State != "none" || len(d) != 1 || strings.Join(d[0].Packages, ",") != "p0,p1,p2,p3,p4,p5" {
		t.Fatalf("%+v %+v", v.Session, d)
	}
}
func TestTimelineVerdictsA5AndText(t *testing.T) {
	f := newFixture(t)
	m := f.mission()
	id := f.submit(m, pkg("shell"))["shell"]
	body := strings.Repeat("结果🙂", 900)
	note := strings.Repeat("修改意见", 400)
	f.succeed(id, 1, body)
	if _, e := f.k.Verdict(id, "return", note); e != nil {
		t.Fatal(e)
	}
	f.succeed(id, 2, "second")
	if _, e := f.k.Verdict(id, "accept", "通过"); e != nil {
		t.Fatal(e)
	}
	es := entriesOf(timeline(t, f, m), "result", "returned", "accepted")
	if len(es) != 4 || es[0].Kind != "result" || es[1].Kind != "returned" || es[2].Attempt != 2 || es[3].Kind != "accepted" || es[1].Note != string([]rune(note)[:600]) {
		t.Fatalf("%+v", es)
	}
	for ref, want := range map[string]string{es[0].Ref: body, es[1].NoteRef: note, es[3].NoteRef: "通过", "instruction:" + id: "do shell"} {
		got, e := f.k.MissionText(m, ref)
		if e != nil || got.Text != want || got.Title == "" {
			t.Fatalf("ref=%s got=%+v err=%v", ref, got, e)
		}
		if _, e = f.k.MissionText(f.mission(), ref); e == nil {
			t.Fatalf("foreign ref allowed: %s", ref)
		}
	}
}
func TestTimelineProblemA6AndIncremental(t *testing.T) {
	f := newFixture(t)
	m := f.mission()
	id := f.submit(m, pkg("shell"))["shell"]
	reason := "原因原文\n下一行"
	f.fail(id, 1, reason)
	v := timeline(t, f, m)
	ps := entriesOf(v, "problem")
	if len(ps) != 1 || ps[0].Reason != reason || !ps[0].Open || v.Mission.Activity != "shell 失败：原因原文" {
		t.Fatalf("%+v %s", ps, v.Mission.Activity)
	}
	have := []string{}
	for _, e := range v.Entries {
		have = append(have, e.Hash)
	}
	same, e := f.k.Timeline(context.Background(), TimelineInput{Mission: m, From: v.Entries[0].Ord, Have: have})
	if e != nil || same.Keep != len(have) || len(same.Entries) != 0 {
		t.Fatalf("%+v %v", same, e)
	}
	if _, e = f.k.Retry(id, "再试"); e != nil {
		t.Fatal(e)
	}
	f.fail(id, 2, "second failure")
	if _, e = f.k.Cancel(m, id); e != nil {
		t.Fatal(e)
	}
	changed, e := f.k.Timeline(context.Background(), TimelineInput{Mission: m, From: v.Entries[0].Ord, Have: have})
	if e != nil {
		t.Fatal(e)
	}
	if changed.Keep != len(have)-1 {
		t.Fatalf("keep=%d want %d", changed.Keep, len(have)-1)
	}
	ps = entriesOf(timeline(t, f, m), "problem")
	if len(ps) != 1 || ps[0].Open || len(ps[0].Steps) != 3 {
		t.Fatalf("%+v", ps)
	}
	for i, k := range []string{"retry", "failed", "cancelled"} {
		if ps[0].Steps[i].Action != k {
			t.Fatalf("%+v", ps)
		}
	}
	// The action names the step; its text does not say it again.
	if ps[0].Steps[0].Text != "再试" || ps[0].Steps[1].Text != "第 2 次尝试：second failure" {
		t.Fatalf("%+v", ps[0].Steps)
	}
}

func injectTimelineItems(t *testing.T, f *fixture, m string, items ...SessionItem) {
	t.Helper()
	err := f.k.write(func(tx *tx) error {
		if _, e := tx.Exec(`UPDATE missions SET owner_engine='claude',owner_session='s' WHERE id=?`, m); e != nil {
			return e
		}
		if _, e := tx.Exec(`INSERT OR IGNORE INTO owner_sessions(engine,session,state,synced_at) VALUES('claude','s','missing',?)`, time.Now().UnixMilli()); e != nil {
			return e
		}
		for _, v := range items {
			if _, e := tx.Exec(`INSERT INTO session_items(engine,session,at,role,tool,text) VALUES('claude','s',?,?,?,?)`, v.At, v.Role, v.Tool, v.Text); e != nil {
				return e
			}
		}
		tx.touched[m] = true
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
func TestTimelineSessionHistoryA20OpsA4AndMissingA14(t *testing.T) {
	f := newFixture(t)
	t.Setenv("HOME", f.home)
	m := f.mission()
	info, _ := f.k.Mission(m)
	at := info.CreatedAt
	var items []SessionItem
	for i := 0; i < 3; i++ {
		items = append(items, SessionItem{At: at - 100 + int64(i*2), Role: "user", Text: fmt.Sprintf("q%d", i)}, SessionItem{At: at - 99 + int64(i*2), Role: "assistant", Text: fmt.Sprintf("a%d", i)})
	}
	items = append(items, SessionItem{At: at, Role: "tool", Tool: "Bash", Text: "weaver plan submit"}, SessionItem{At: at, Role: "tool", Tool: "Bash", Text: "weaver wait"})
	injectTimelineItems(t, f, m, items...)
	f.submit(m, pkg("x"))
	v := timeline(t, f, m)
	if v.Entries[0].Kind != "user" || v.Entries[0].Text != "q0" {
		t.Fatalf("%+v", v.Entries)
	}
	created, dispatch := -1, -1
	for i, e := range v.Entries {
		if e.Kind == "created" {
			created = i
		}
		if e.Kind == "dispatch" {
			dispatch = i
		}
	}
	if created < 6 || dispatch <= created {
		t.Fatalf("created=%d dispatch=%d", created, dispatch)
	}
	ops := entriesOf(v, "ops")
	if len(ops) != 1 || len(ops[0].Ops) != 2 {
		t.Fatalf("%+v", ops)
	}
	if v.Session.State != "missing" || v.Session.SyncedTo == 0 {
		t.Fatalf("%+v", v.Session)
	}
	es := entriesOf(v, "user", "owner")
	full, e := f.k.MissionText(m, es[1].Ref)
	if e != nil || full.Text != "a0" {
		t.Fatalf("%+v %v", full, e)
	}
}
func TestTimelineSessionFileDeletedA14(t *testing.T) {
	f := newFixture(t)
	t.Setenv("HOME", f.home)
	path := sessionPath(t, f.home, "claude")
	putSession(t, path, sessionLine("claude", "user", "persisted"))
	m, e := f.k.CreateMission("", "task", f.ws, nil, &Owner{Engine: "claude", Session: "s"})
	if e != nil {
		t.Fatal(e)
	}
	if e = os.Remove(path); e != nil {
		t.Fatal(e)
	}
	v := timeline(t, f, m.ID)
	if v.Session.State != "missing" || v.Session.SyncedTo == 0 || len(entriesOf(v, "user")) != 1 {
		t.Fatalf("%+v", v)
	}
}
func TestTimelineSessionBoundsAndClosedReply(t *testing.T) {
	f := newFixture(t)
	t.Setenv("HOME", f.home)
	first, second := f.mission(), f.mission()
	if e := f.k.write(func(tx *tx) error {
		_, e := tx.Exec(`UPDATE missions SET created_at=CASE id WHEN ? THEN 100 ELSE 300 END,closed_at=CASE id WHEN ? THEN 200 ELSE 400 END WHERE id IN (?,?)`, first, first, first, second)
		return e
	}); e != nil {
		t.Fatal(e)
	}
	injectTimelineItems(t, f, first, SessionItem{At: 50, Role: "user", Text: "first"}, SessionItem{At: 210, Role: "assistant", Text: "closing first"}, SessionItem{At: 250, Role: "user", Text: "second"}, SessionItem{At: 410, Role: "assistant", Text: "closing second"}, SessionItem{At: 450, Role: "user", Text: "third"}, SessionItem{At: 460, Role: "assistant", Text: "too late"})
	injectTimelineItems(t, f, second)
	a, b := timeline(t, f, first), timeline(t, f, second)
	ae, be := entriesOf(a, "user", "owner"), entriesOf(b, "user", "owner")
	if len(ae) != 2 || ae[1].Text != "closing first" || len(be) != 2 || be[0].Text != "second" || be[1].Text != "closing second" {
		t.Fatalf("%+v %+v", ae, be)
	}
	if _, e := f.k.MissionText(second, ae[0].Ref); e == nil {
		t.Fatal("out of range session ref accepted")
	}
}
func TestTimelineDialogueA15A16A17(t *testing.T) {
	for _, fail := range []bool{false, true} {
		t.Run(fmt.Sprint(fail), func(t *testing.T) {
			f := dialogueFixture(t)
			m := f.mission()
			d, e := f.k.StartDialogue("", DialogueInput{Mission: m, Name: "design", Brief: "pick", Rounds: 1})
			if e != nil {
				t.Fatal(e)
			}
			ids := map[string]string{}
			for _, p := range d.Packages {
				ids[p.Key] = p.ID
			}
			if fail {
				f.fail(ids["design.r1.a"], 1, "lost")
			} else {
				f.succeed(ids["design.r1.a"], 1, "proposal A")
			}
			f.succeed(ids["design.r1.b"], 1, "proposal B")
			if !fail {
				f.succeed(ids["design.r2.b"], 1, "final B")
				f.succeed(ids["design.r2.a"], 1, "final A")
			}
			v := timeline(t, f, m)
			ds := entriesOf(v, "dialogue")
			if len(ds) != 1 || len(ds[0].Sides) != 2 || ds[0].Rounds != 1 {
				t.Fatalf("%+v", ds)
			}
			for _, s := range ds[0].Sides {
				if s.Engine == "" || s.Model == "" || s.Effort == "" || s.Account == "" {
					t.Fatalf("%+v", s)
				}
			}
			if len(entriesOf(v, "dispatch", "result", "accepted")) != 0 {
				t.Fatalf("dialogue leaked: %+v", v.Entries)
			}
			if fail {
				if len(entriesOf(v, "problem")) != 1 || len(entriesOf(v, "debater")) != 1 {
					t.Fatalf("%+v", v.Entries)
				}
				p := entriesOf(v, "problem")[0]
				if p.Name != "design" || p.Side != "a" {
					t.Fatalf("%+v", p)
				}
			} else {
				rounds := entriesOf(v, "round")
				deb := entriesOf(v, "debater")
				if len(rounds) != 2 || rounds[0].RoundKind != "proposal" || rounds[1].RoundKind != "final" || len(deb) != 4 || deb[2].Side != "b" || deb[3].Side != "a" {
					t.Fatalf("rounds=%+v deb=%+v", rounds, deb)
				}
			}
		})
	}
}
func TestTimelinePaginationAndSessionIncrement(t *testing.T) {
	f := newFixture(t)
	t.Setenv("HOME", f.home)
	m := f.mission()
	at := time.Now().UnixMilli()
	injectTimelineItems(t, f, m, SessionItem{At: at + 1, Role: "user", Text: "one"}, SessionItem{At: at + 2, Role: "assistant", Text: "two"})
	full := timeline(t, f, m)
	page, e := f.k.Timeline(context.Background(), TimelineInput{Mission: m, Limit: 2})
	if e != nil || len(page.Entries) != 2 || !page.HasMore {
		t.Fatalf("%+v %v", page, e)
	}
	earlier, e := f.k.Timeline(context.Background(), TimelineInput{Mission: m, Limit: 2, Before: page.Entries[0].Ord})
	if e != nil || len(earlier.Entries) != 1 || earlier.HasMore {
		t.Fatalf("%+v %v", earlier, e)
	}
	have := []string{}
	for _, e := range full.Entries {
		have = append(have, e.Hash)
	}
	injectTimelineItems(t, f, m, SessionItem{At: at + 3, Role: "assistant", Text: "three"})
	v, e := f.k.Timeline(context.Background(), TimelineInput{Mission: m, From: full.Entries[0].Ord, Have: have})
	if e != nil || v.Keep != len(have) || len(v.Entries) != 1 || v.Entries[0].Text != "three" {
		t.Fatalf("%+v %v", v, e)
	}
}
func TestTimelineWaitNotificationTimeoutAndCancel(t *testing.T) {
	f := newFixture(t)
	m := f.mission()
	v := timeline(t, f, m)
	in := TimelineInput{Mission: m, From: v.Entries[0].Ord, Have: []string{v.Entries[0].Hash}, Wait: true}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		res, e := f.k.Timeline(ctx, in)
		if e == nil && len(res.Entries) == 0 {
			e = fmt.Errorf("no new entries")
		}
		done <- e
	}()
	f.submit(m, pkg("x"))
	select {
	case e := <-done:
		if e != nil {
			t.Fatal(e)
		}
	case <-time.After(time.Second):
		t.Fatal("notification exceeded 1s")
	}
	f.k.timelineWait = 80 * time.Millisecond
	v = timeline(t, f, m)
	in.From = v.Entries[0].Ord
	in.Have = nil
	for _, e := range v.Entries {
		in.Have = append(in.Have, e.Hash)
	}
	start := time.Now()
	res, e := f.k.Timeline(ctx, in)
	if e != nil || len(res.Entries) != 0 || res.Keep != len(in.Have) || time.Since(start) < 70*time.Millisecond {
		t.Fatalf("%+v %v %s", res, e, time.Since(start))
	}
	ctx2, cancel2 := context.WithCancel(context.Background())
	cancel2()
	if _, e = f.k.Timeline(ctx2, in); e != context.Canceled {
		t.Fatalf("cancel=%v", e)
	}
}
func TestTimelinePerformanceA11(t *testing.T) {
	f := newFixture(t)
	t.Setenv("HOME", f.home)
	m := f.mission()
	var plan []PackageInput
	for i := 0; i < 20; i++ {
		plan = append(plan, pkg(fmt.Sprintf("p%d", i)))
	}
	f.submit(m, plan...)
	var items []SessionItem
	for i := 0; i < 500; i++ {
		items = append(items, SessionItem{At: 100 + int64(i), Role: "assistant", Text: strings.Repeat("话", 100)})
	}
	injectTimelineItems(t, f, m, items...)
	if e := f.k.write(func(tx *tx) error {
		for i := 0; i < 3000; i++ {
			kind := EvProgress
			if i%100 == 0 {
				kind = EvExternal
			}
			if _, e := tx.event(m, "", 0, kind, "event"); e != nil {
				return e
			}
		}
		return nil
	}); e != nil {
		t.Fatal(e)
	}
	start := time.Now()
	v := timeline(t, f, m)
	elapsed := time.Since(start)
	t.Logf("A11 first timeline: %s (%d entries, 500 session items, 3000 events, 20 packages)", elapsed, len(v.Entries))
	if !raceDetector && elapsed > 100*time.Millisecond {
		t.Fatalf("timeline exceeded 100ms: %s", elapsed)
	}
}

func TestTimelineActivityAndPlanMembership(t *testing.T) {
	f := newFixture(t)
	m := f.mission()
	ids := f.submit(m, pkg("first"), pkg("next", "first"))
	v := timeline(t, f, m)
	if v.Mission.Activity != "派出 2 个 Agent" {
		t.Fatalf("activity=%q", v.Mission.Activity)
	}
	f.submit(m, pkg("third"))
	ds := entriesOf(timeline(t, f, m), "dispatch")
	if len(ds) != 2 || strings.Join(ds[0].Packages, ",") != "first,next" || strings.Join(ds[1].Packages, ",") != "third" {
		t.Fatalf("%+v", ds)
	}
	f.succeed(ids["first"], 1, "done")
	mInfo, e := f.k.Mission(m)
	if e != nil || mInfo.Activity != "待验收 1 个" {
		t.Fatalf("%+v %v", mInfo, e)
	}
	all, e := f.k.Missions(true)
	if e != nil || len(all) != 1 || all[0].Activity != mInfo.Activity {
		t.Fatalf("%+v %v", all, e)
	}
	if _, e = f.k.Cancel(m, ""); e != nil {
		t.Fatal(e)
	}
	if _, e = f.k.CloseMission(m); e != nil {
		t.Fatal(e)
	}
	mInfo, _ = f.k.Mission(m)
	if mInfo.Activity != "任务结束" {
		t.Fatalf("activity=%q", mInfo.Activity)
	}
}
func TestTimelineReturnedNoteWhenNextAttemptIsWaiting(t *testing.T) {
	f := newFixture(t)
	m := f.mission()
	id := f.submit(m, pkg("work"))["work"]
	f.succeed(id, 1, "result")
	// Disable routing before returning, leaving the full owner note on the package.
	if e := f.k.write(func(tx *tx) error { _, e := tx.Exec(`UPDATE workers SET enabled=0`); return e }); e != nil {
		t.Fatal(e)
	}
	note := strings.Repeat("意", 1500)
	if _, e := f.k.Verdict(id, "return", note); e != nil {
		t.Fatal(e)
	}
	e := entriesOf(timeline(t, f, m), "returned")[0]
	full, err := f.k.MissionText(m, e.NoteRef)
	if err != nil || full.Text != note || e.NoteChars != 1500 {
		t.Fatalf("chars=%d full=%+v err=%v", e.NoteChars, full, err)
	}
}

func TestTimelineWaitForArtifactAndClose(t *testing.T) {
	f := newFixture(t)
	m := f.mission()
	for _, action := range []string{"artifact", "close"} {
		v := timeline(t, f, m)
		have := []string{}
		for _, e := range v.Entries {
			have = append(have, e.Hash)
		}
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		done := make(chan error, 1)
		go func() {
			res, e := f.k.Timeline(ctx, TimelineInput{Mission: m, From: v.Entries[0].Ord, Have: have, Wait: true})
			if e == nil && len(res.Entries) == 0 {
				e = fmt.Errorf("no changes")
			}
			done <- e
		}()
		// Ensure the request is actually waiting, rather than racing its initial read.
		select {
		case e := <-done:
			cancel()
			t.Fatalf("returned before mutation: %v", e)
		case <-time.After(30 * time.Millisecond):
		}
		if action == "artifact" {
			if _, e := f.k.AddArtifact(ArtifactInput{Mission: m, URL: "https://example.com/report.html"}); e != nil {
				cancel()
				t.Fatal(e)
			}
		} else {
			if _, e := f.k.CloseMission(m); e != nil {
				cancel()
				t.Fatal(e)
			}
		}
		e := <-done
		cancel()
		if e != nil {
			t.Fatalf("%s: %v", action, e)
		}
	}
}

func TestTimelineSessionStatesAndScopedInstructionRef(t *testing.T) {
	f := newFixture(t)
	t.Setenv("HOME", f.home)
	m, e := f.k.CreateMission("", "unsupported", f.ws, nil, &Owner{Engine: "opencode", Session: "s"})
	if e != nil {
		t.Fatal(e)
	}
	if v := timeline(t, f, m.ID); v.Session.State != "unsupported" {
		t.Fatalf("%+v", v.Session)
	}
	normal := f.mission()
	injectTimelineItems(t, f, normal, SessionItem{At: 100, Role: "user", Text: "persisted"})
	if e = f.k.write(func(tx *tx) error { _, e := tx.Exec(`UPDATE owner_sessions SET state='rewritten'`); return e }); e != nil {
		t.Fatal(e)
	}
	if v := timeline(t, f, normal); v.Session.State != "rewritten" || v.Session.SyncedTo != 100 || len(entriesOf(v, "user")) != 1 {
		t.Fatalf("%+v", v.Session)
	}
	f.submit(normal, pkg("work"))
	ref := "instruction:" + normal + "/work"
	full, e := f.k.MissionText(normal, ref)
	if e != nil || full.Text != "do work" {
		t.Fatalf("%+v %v", full, e)
	}
	if _, e = f.k.MissionText(m.ID, ref); e == nil {
		t.Fatal("foreign scoped instruction ref allowed")
	}
}
func TestTimelineDialogueClassificationMatchesShow(t *testing.T) {
	f := newFixture(t)
	m := f.mission()
	f.submit(m, pkg("fake.r1.a"), pkg("fake.r1.b"))
	if _, e := f.k.Dialogue(m, "fake"); e == nil {
		t.Fatal("non advisory packages treated as dialogue")
	}
	v := timeline(t, f, m)
	if len(entriesOf(v, "dialogue")) != 0 || len(entriesOf(v, "dispatch")) != 1 {
		t.Fatalf("%+v", v.Entries)
	}
}

func TestTimelinePlanMembershipMigration(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(home, "legacy.db")
	db, e := sql.Open("sqlite", path)
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	if _, e = db.Exec(`CREATE TABLE schema_migrations(name TEXT PRIMARY KEY,applied_at INTEGER NOT NULL)`); e != nil {
		t.Fatal(e)
	}
	files, e := os.ReadDir("../store/migrations")
	if e != nil {
		t.Fatal(e)
	}
	for _, file := range files {
		if file.Name() >= "0008" {
			continue
		}
		body, e := os.ReadFile(filepath.Join("../store/migrations", file.Name()))
		if e != nil {
			t.Fatal(e)
		}
		if _, e = db.Exec(string(body)); e != nil {
			t.Fatal(e)
		}
		if _, e = db.Exec(`INSERT INTO schema_migrations VALUES(?,0)`, file.Name()); e != nil {
			t.Fatal(e)
		}
	}
	if _, e = db.Exec(`INSERT INTO missions(id,title,workspace,created_at) VALUES('m','legacy',?,100)`, home); e != nil {
		t.Fatal(e)
	}
	for i := 1; i <= 3; i++ {
		if _, e = db.Exec(`INSERT INTO packages(id,mission_id,key,title,instruction,workspace,state,position,created_at,updated_at) VALUES(?,'m',?,'title','instruction',?,'pending',?,100,100)`, fmt.Sprintf("p%d", i), fmt.Sprintf("p%d", i), home, i); e != nil {
			t.Fatal(e)
		}
	}
	for _, message := range []string{"提交计划：2 个工作包", "提交计划：1 个工作包"} {
		if _, e = db.Exec(`INSERT INTO events(mission_id,kind,message,at) VALUES('m','plan',?,100)`, message); e != nil {
			t.Fatal(e)
		}
	}
	if e = db.Close(); e != nil {
		t.Fatal(e)
	}
	migrated, e := store.Open(path)
	if e != nil {
		t.Fatal(e)
	}
	for i, want := range []int{1, 1, 2} {
		var got int
		if e = migrated.QueryRow(`SELECT plan_seq FROM packages WHERE id=?`, fmt.Sprintf("p%d", i+1)).Scan(&got); e != nil || got != want {
			migrated.Close()
			t.Fatalf("package %d plan=%d want %d err=%v", i+1, got, want, e)
		}
	}
	if e = migrated.Close(); e != nil {
		t.Fatal(e)
	}
	again, e := store.Open(path)
	if e != nil {
		t.Fatal(e)
	}
	if e = again.Close(); e != nil {
		t.Fatal(e)
	}
}
func TestTimelineLiveCancellation(t *testing.T) {
	f := newFixture(t)
	m := f.mission()
	v := timeline(t, f, m)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, e := f.k.Timeline(ctx, TimelineInput{Mission: m, From: v.Entries[0].Ord, Have: []string{v.Entries[0].Hash}, Wait: true})
		done <- e
	}()
	select {
	case e := <-done:
		t.Fatalf("returned before cancel: %v", e)
	case <-time.After(20 * time.Millisecond):
	}
	cancel()
	select {
	case e := <-done:
		if e != context.Canceled {
			t.Fatalf("%v", e)
		}
	case <-time.After(100 * time.Millisecond):
		t.Fatal("cancellation did not return promptly")
	}
}

func TestTimelineCancellationDuringSessionSync(t *testing.T) {
	f := newFixture(t)
	t.Setenv("HOME", f.home)
	m := f.mission()
	injectTimelineItems(t, f, m, SessionItem{At: 1, Role: "user", Text: "retained"})
	f.k.sessionMu.Lock()
	defer f.k.sessionMu.Unlock()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { _, e := f.k.Timeline(ctx, TimelineInput{Mission: m}); done <- e }()
	time.AfterFunc(20*time.Millisecond, cancel)
	select {
	case e := <-done:
		if e != context.Canceled {
			t.Fatalf("%v", e)
		}
	case <-time.After(150 * time.Millisecond):
		t.Fatal("session sync prevented request cancellation")
	}
}
