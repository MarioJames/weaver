package kernel

import (
	"fmt"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/MarioJames/weaver/internal/engine"
	"github.com/MarioJames/weaver/internal/quota"
)

func TestIntelligenceValidationAndAtomicPlan(t *testing.T) {
	f := newFixture(t)
	for _, score := range []float64{8, 7.5, 0, 7.3, 0.5, 11, math.NaN(), math.Inf(1)} {
		_, err := f.k.SetWorker(WorkerInput{ID: "alpha", Intelligence: &score})
		valid := score == 8 || score == 7.5 || score == 0
		if (err == nil) != valid {
			t.Fatalf("score %g: %v", score, err)
		}
		if err != nil && AsError(err).Code != "INVALID" {
			t.Fatal(err)
		}
	}
	score := 8.0
	if _, err := f.k.SetWorker(WorkerInput{ID: "alpha", Intelligence: &score}); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		score float64
		code  string
	}{{0, "INVALID"}, {7.3, "INVALID"}, {0.5, "INVALID"}, {11, "INVALID"}, {9, "NO_CANDIDATE"}} {
		m := f.mission()
		_, err := f.k.SubmitPlan("", PlanInput{Mission: m, Packages: []PackageInput{pkg("valid"), {Key: "invalid", Instruction: "x", Intelligence: c.score}}})
		if err == nil || AsError(err).Code != c.code {
			t.Fatalf("%g: %v", c.score, err)
		}
		ps, readErr := f.k.Packages(m)
		if readErr != nil || len(ps) != 0 {
			t.Fatalf("partial plan: %v %v", ps, readErr)
		}
		if c.score == 9 && !strings.Contains(err.Error(), "最高为 8") {
			t.Fatal("missing candidate explanation")
		}
	}
}
func candidate(id string, score float64, rateAccepted int, seconds, quota float64) *routeWorker {
	return &routeWorker{ID: id, Engine: "codex", Intelligence: score, Stats: &statBuckets{overall: statSample{n: 10, accepted: rateAccepted, durations: []float64{seconds, seconds, seconds, seconds, seconds}}}, Accounts: []*routeAccount{{Account: engine.Account{ID: id}, Ready: true, Snapshot: routingQuota(quota)}}}
}
func TestRoutingEligibilityAndPerformance(t *testing.T) {
	for _, c := range []struct {
		name          string
		first, second *routeWorker
		want          string
	}{
		{"acceptance", candidate("a", 8, 2, 600, 1), candidate("b", 8, 9, 600, 1), "b"},
		{"duration", candidate("a", 8, 8, 900, 1), candidate("b", 8, 8, 300, 1), "b"},
		{"quota", candidate("a", 8, 8, 600, 0.4), candidate("b", 8, 8, 600, 0.9), "b"},
		{"tie", candidate("a", 8, 8, 600, 1), candidate("b", 8, 8, 600, 1), "a"},
	} {
		t.Run(c.name, func(t *testing.T) {
			rt := &routing{Workers: []*routeWorker{candidate("weak", 6, 10, 1, 1), candidate("unrated", 0, 10, 1, 1), c.first, c.second}}
			w, _, note := rt.pick("", "", 7)
			if w == nil || w.ID != c.want || !strings.Contains(note, "需求 7") || len([]rune(note)) > 200 {
				t.Fatalf("%v %s", w, note)
			}
			pinned, _, note := rt.pick("unrated", "", 9)
			if pinned == nil || pinned.ID != "unrated" || note != "包指定了候选 unrated" {
				t.Fatalf("pin: %v %s", pinned, note)
			}
		})
	}
	rt := &routing{Workers: []*routeWorker{candidate("a", 8, 8, 600, 1), candidate("b", 8, 8, 600, 1)}}
	counts := map[string]int{}
	for i := 0; i < 20; i++ {
		w, _, _ := rt.pick("", "", 7)
		counts[w.ID]++
	}
	if counts["a"] != 10 || counts["b"] != 10 {
		t.Fatal(counts)
	}
}
func TestAccountSelectionAndExhaustion(t *testing.T) {
	w := candidate("w", 8, 8, 600, 0)
	w.Accounts[0].Account.Label = "空账号"
	rt := &routing{Workers: []*routeWorker{w}}
	if got, _, reason := rt.pick("", "", 7); got != nil || !strings.Contains(reason, "账号「空账号」额度已用完") {
		t.Fatal(got, reason)
	}
	w.Accounts = append(w.Accounts, &routeAccount{Ready: true, Snapshot: routingQuota(0.8), Running: 9}, &routeAccount{Ready: true, Snapshot: routingQuota(0.8), Running: 1}, &routeAccount{Ready: true, Snapshot: routingQuota(0.5)})
	_, a, _ := rt.pick("", "", 7)
	if a != w.Accounts[2] {
		t.Fatal("quota/load account ordering")
	}
}
func TestStatsIndependentFallbacks(t *testing.T) {
	band := &statSample{n: 5, accepted: 5, durations: []float64{10}}
	overall := statSample{n: 10, accepted: 2, durations: []float64{100, 200, 300, 400, 500}}
	global := &statSample{n: 20, accepted: 1, durations: []float64{800, 900, 1000, 1100, 1200}}
	s := &statBuckets{overall: overall, bands: map[int]*statSample{7: band}}
	v := s.performance(7.5, global)
	if v.FirstAcceptanceRate != 0.9 || v.MedianSeconds != 300 {
		t.Fatal(v)
	}
	band.n = 4
	v = s.performance(7.5, global)
	if v.FirstAcceptanceRate != 0.4 || v.MedianSeconds != 300 {
		t.Fatal(v)
	}
	s.overall.n = 3
	s.overall.durations = nil
	v = s.performance(7.5, global)
	if v.FirstAcceptanceRate != 0.2 || v.MedianSeconds != 1000 {
		t.Fatal(v)
	}
	global.n = 0
	global.durations = nil
	v = s.performance(7.5, global)
	if v.FirstAcceptanceRate != 0.75 || v.MedianSeconds != 600 {
		t.Fatal(v)
	}
	v = (*statBuckets)(nil).performance(7, nil)
	if v.FirstAcceptanceRate != 0.8 || v.MedianSeconds != 600 {
		t.Fatal(v)
	}
}
func TestStatsFiltersAndBands(t *testing.T) {
	f := newFixture(t)
	m := f.mission()
	now := time.Now().UnixMilli()
	type sample struct {
		state, failure, model string
		n                     int
		auto                  bool
		score                 float64
		age                   int64
		start                 bool
	}
	samples := []sample{
		{StateAccepted, "", "m", 1, false, 7.5, 0, true},
		{StateReturned, "", "m", 1, false, 7, 0, true},
		{StateFailed, engine.FailVendor, "m", 1, false, 0, 0, true},
		{StateFailed, engine.FailQuota, "m", 1, false, 7, 0, true},
		{StateFailed, engine.FailAuth, "m", 1, false, 7, 0, true},
		{StateFailed, engine.FailRateLimit, "m", 1, false, 7, 0, true},
		{StateAccepted, "", "old-model", 1, false, 7, 0, true},
		{StateAccepted, "", "m", 1, false, 7, int64(31 * 24 * time.Hour / time.Millisecond), true},
		{StateAccepted, "", "m", 1, true, 8, 0, false},
		{StateAccepted, "", "m", 2, false, 8, 0, false},
	}
	for i, s := range samples {
		id := fmt.Sprintf("stats-%d", i)
		if _, err := f.k.db.Exec(`INSERT INTO packages(id,mission_id,key,title,instruction,workspace,state,created_at,updated_at,auto_accept,intelligence,position) VALUES(?,?,?,?,?,?,?,?,?,?,?,0)`, id, m, id, id, "x", f.ws, s.state, now, now, s.auto, s.score); err != nil {
			t.Fatal(err)
		}
		var start any
		if s.start {
			start = now - s.age - 10000
		}
		if _, err := f.k.db.Exec(`INSERT INTO attempts(id,package_id,mission_id,n,state,worker,account_id,engine,model,effort,created_at,started_at,finished_at,failure_kind,mode) VALUES(?,?,?,?,?,'alpha','acct-alpha','codex',?,'',?,?,?,?,'')`, id, id, m, s.n, s.state, s.model, now, start, now-s.age, s.failure); err != nil {
			t.Fatal(err)
		}
	}
	ws, err := f.k.Workers()
	if err != nil {
		t.Fatal(err)
	}
	s := ws[0].Stats
	if s.Samples != 3 || s.FirstAcceptanceRate != 5.0/8 || s.MedianSeconds != 10 || len(s.Bands) != 2 || s.Bands[0].Band != 7 || s.Bands[0].Samples != 2 {
		t.Fatalf("%+v", s)
	}
}
func TestRoutingNoteInAttemptAndLaunchingEvent(t *testing.T) {
	f := newFixture(t)
	m := f.mission()
	ids := f.submit(m, pkg("x"))
	p, err := f.k.Package(ids["x"])
	if err != nil {
		t.Fatal(err)
	}
	if p.Intelligence != 1 || p.Current == nil || !strings.Contains(p.Current.RouteNote, "需求 1") {
		t.Fatalf("%+v", p)
	}
	events, err := f.k.Events(m, 0, 100)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range events {
		if e.Kind == EvLaunching {
			if e.Data["routeNote"] != p.Current.RouteNote {
				t.Fatal(e)
			}
			return
		}
	}
	t.Fatal("missing launching event")
}

// The default dialogue runs on the two seats; candidate ratings do not move it.
func TestDialogueDefaultUsesSeatsWhateverTheRatings(t *testing.T) {
	f := dialogueFixture(t)
	score := 8.5
	if _, err := f.k.SetWorker(WorkerInput{ID: "beta", Intelligence: &score}); err != nil {
		t.Fatal(err)
	}
	d, err := f.k.StartDialogue("", DialogueInput{Mission: f.mission(), Brief: "Compare"})
	if err != nil {
		t.Fatal(err)
	}
	for i, p := range d.Packages {
		want := "debater_a"
		if i%2 == 1 {
			want = "debater_b"
		}
		if p.Worker != want || p.Intelligence != 9 {
			t.Fatalf("%+v", p)
		}
	}
	score = 0
	if _, err := f.k.SetWorker(WorkerInput{ID: "claude_w", Intelligence: &score}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.k.StartDialogue("", DialogueInput{Mission: f.mission(), Brief: "Compare"}); err != nil {
		t.Fatalf("an unrated candidate must not stop a dialogue on the seats: %v", err)
	}
}

func TestPlanQualificationIgnoresReadinessButHonorsEngineAndEnabled(t *testing.T) {
	f := newFixture(t)
	score := 8.0
	if _, err := f.k.SetWorker(WorkerInput{ID: "alpha", Intelligence: &score}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.k.db.Exec(`UPDATE accounts SET ready=0, ready_reason='等待登录'`); err != nil {
		t.Fatal(err)
	}
	m := f.mission()
	result, err := f.k.SubmitPlan("", PlanInput{Mission: m, Packages: []PackageInput{{Key: "ready-later", Instruction: "x", Intelligence: 8}}})
	if err != nil || result.Packages[0].State != StatePending {
		t.Fatal(result, err)
	}
	for _, engineName := range []string{"claude", "unknown"} {
		_, err := f.k.SubmitPlan("", PlanInput{Mission: m, Packages: []PackageInput{{Key: engineName, Instruction: "x", Intelligence: 7, Engine: engineName}}})
		if err == nil || AsError(err).Code != "NO_CANDIDATE" {
			t.Fatal(err)
		}
	}
	if _, err := f.k.db.Exec(`UPDATE workers SET intelligence=0`); err != nil {
		t.Fatal(err)
	}
	_, err = f.k.SubmitPlan("", PlanInput{Mission: m, Packages: []PackageInput{{Key: "unrated", Instruction: "x", Intelligence: 1}}})
	if err == nil || AsError(err).Code != "NO_CANDIDATE" || !strings.Contains(err.Error(), "请先") {
		t.Fatal(err)
	}
	workers, err := f.k.Workers()
	if err != nil {
		t.Fatal(err)
	}
	if workers[0].Available || !strings.Contains(workers[0].Reason, "等待登录") {
		t.Fatalf("unready unrated worker should keep readiness reason: %+v", workers[0])
	}
	if _, err := f.k.db.Exec(`UPDATE accounts SET ready=1, ready_reason=''`); err != nil {
		t.Fatal(err)
	}
	workers, err = f.k.Workers()
	if err != nil {
		t.Fatal(err)
	}
	if !workers[0].Available || !strings.HasPrefix(workers[0].Reason, "未评分：只在包指定它时使用") {
		t.Fatalf("ready unrated worker should report unrated hint: %+v", workers[0])
	}
	if _, err := f.k.db.Exec(`UPDATE workers SET intelligence=10,enabled=0 WHERE id='alpha'`); err != nil {
		t.Fatal(err)
	}
	_, err = f.k.SubmitPlan("", PlanInput{Mission: m, Packages: []PackageInput{{Key: "disabled", Instruction: "x", Intelligence: 9}}})
	if err == nil || AsError(err).Code != "NO_CANDIDATE" {
		t.Fatal(err)
	}
}

func TestMedianAndBandDurationFallback(t *testing.T) {
	raw := statSample{durations: []float64{40, 10, 20, 30}}
	if got := raw.view().MedianSeconds; got != 25 {
		t.Fatal(got)
	}
	band := &statSample{n: 0, durations: []float64{20, 10, 30, 50, 40}}
	overall := statSample{n: 5, accepted: 1}
	s := &statBuckets{overall: overall, bands: map[int]*statSample{7: band}}
	got := s.performance(7.5, nil)
	if got.FirstAcceptanceRate != 0.5 || got.MedianSeconds != 30 {
		t.Fatal(got)
	}
}

var routingQuotaReset = time.Now().Add(time.Hour).UnixMilli()

func routingQuota(factor float64) *quota.Snapshot {
	return &quota.Snapshot{Status: "available", Windows: []quota.Window{{Scope: "account", UsedPercent: (1 - factor) * 100, ResetsAt: routingQuotaReset, DurationMinutes: 60}}}
}
