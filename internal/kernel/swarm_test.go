package kernel

import (
	"strings"
	"testing"

	"github.com/MarioJames/weaver/internal/engine"
)

// A package goes to the lowest-rated candidates that qualify, however good
// the stronger ones look: those are kept for the packages that need them.
func TestRoutingPrefersLowestSufficientTier(t *testing.T) {
	mid := func() *routeWorker { return candidate("mid", 6, 5, 1200, 1) }
	strong := func() *routeWorker { return candidate("strong", 8.5, 10, 60, 1) }

	rt := &routing{Workers: []*routeWorker{strong(), mid()}}
	w, _, note := rt.pick("", "", 6)
	if w == nil || w.ID != "mid" || !strings.Contains(note, "最低档") {
		t.Fatalf("level 6 should stay in the middle tier: %v %s", w, note)
	}
	if w, _, _ := rt.pick("", "", 6.5); w == nil || w.ID != "strong" {
		t.Fatalf("level 6.5 needs the stronger candidate: %v", w)
	}

	// A full or unavailable lower tier overflows upwards instead of queueing.
	full := mid()
	full.MaxParallel, full.Running = 2, 2
	rt = &routing{Workers: []*routeWorker{strong(), full}}
	if w, _, note := rt.pick("", "", 6); w == nil || w.ID != "strong" || !strings.Contains(note, "更低档已满或不可用") {
		t.Fatalf("overflow past a full tier: %v %s", w, note)
	}
	down := mid()
	down.Accounts[0].Ready, down.Accounts[0].Reason = false, "账号未就绪"
	rt = &routing{Workers: []*routeWorker{strong(), down}}
	if w, _, _ := rt.pick("", "", 6); w == nil || w.ID != "strong" {
		t.Fatalf("overflow past an unavailable tier: %v", w)
	}

	// Inside one tier the measured score still decides, and load spreads.
	rt = &routing{Workers: []*routeWorker{strong(), candidate("slow", 6, 8, 900, 1), candidate("fast", 6, 8, 300, 1)}}
	counts := map[string]int{}
	for i := 0; i < 8; i++ {
		w, _, _ := rt.pick("", "", 6)
		counts[w.ID]++
	}
	if counts["strong"] != 0 || counts["fast"] != 6 || counts["slow"] != 2 {
		t.Fatalf("same-tier spread: %v", counts)
	}
}

func (f *fixture) rate(id string, score float64) {
	f.t.Helper()
	if _, err := f.k.SetWorker(WorkerInput{ID: id, Intelligence: &score}); err != nil {
		f.t.Fatal(err)
	}
}

func (f *fixture) current(id string) *Attempt {
	f.t.Helper()
	p, err := f.k.Package(id)
	if err != nil || p.Current == nil {
		f.t.Fatalf("package %s has no attempt: %v", id, err)
	}
	return p.Current
}

// An attempt that was not accepted moves the package one tier up, so rating a
// package low costs one retry at most.
func TestNextAttemptEscalatesPastTheCandidateThatWasNotAccepted(t *testing.T) {
	f := newFixture(t)
	f.rate("alpha", 6)
	f.rate("beta", 7.5)
	ids := f.submit(f.mission(), PackageInput{Intelligence: 6, Key: "x", Instruction: "x"})
	if a := f.current(ids["x"]); a.Worker != "alpha" {
		t.Fatalf("first attempt: %s", a.Worker)
	}
	f.succeed(ids["x"], 1, "done")
	if _, err := f.k.Verdict(ids["x"], "return", "漏了相邻情况"); err != nil {
		t.Fatal(err)
	}
	a := f.current(ids["x"])
	if a.N != 2 || a.Worker != "beta" || !strings.Contains(a.RouteNote, "升档") {
		t.Fatalf("returned package should escalate: %+v", a)
	}

	// Nothing is rated above beta: the package stays in its own pool rather than waiting forever.
	f.succeed(ids["x"], 2, "done")
	if _, err := f.k.Verdict(ids["x"], "return", "还是不对"); err != nil {
		t.Fatal(err)
	}
	if a := f.current(ids["x"]); a.N != 3 || a.Worker != "beta" || f.state(ids["x"]) != StateLaunch {
		t.Fatalf("no higher tier: %+v", a)
	}
}

func TestRetryAfterAFailureAvoidsTheFailedTier(t *testing.T) {
	f := newFixture(t)
	f.rate("alpha", 5)
	f.rate("beta", 6)
	ids := f.submit(f.mission(), PackageInput{Intelligence: 4.5, Key: "x", Instruction: "x"})
	id := attemptID(ids["x"], 1)
	f.k.Handed(id, engine.ModeCold, "unit")
	f.k.Finished(id, engine.Outcome{FailureKind: engine.FailVendor, FailureMessage: "Variant unavailable"})
	if f.state(ids["x"]) != StateFailed {
		t.Fatal(f.state(ids["x"]))
	}
	if _, err := f.k.Retry(ids["x"], ""); err != nil {
		t.Fatal(err)
	}
	if a := f.current(ids["x"]); a.N != 2 || a.Worker != "beta" {
		t.Fatalf("retry should leave the failed candidate: %+v", a)
	}
}

// A pinned package keeps its candidate on every attempt.
func TestPinnedPackageDoesNotEscalate(t *testing.T) {
	f := newFixture(t)
	f.rate("alpha", 6)
	f.rate("beta", 7.5)
	ids := f.submit(f.mission(), PackageInput{Intelligence: 6, Key: "x", Instruction: "x", Worker: "alpha"})
	f.succeed(ids["x"], 1, "done")
	if _, err := f.k.Verdict(ids["x"], "return", "再来"); err != nil {
		t.Fatal(err)
	}
	if a := f.current(ids["x"]); a.N != 2 || a.Worker != "alpha" {
		t.Fatalf("%+v", a)
	}
}

func plan(t *testing.T, f *fixture, mission string, packages ...PackageInput) *PlanResult {
	t.Helper()
	res, err := f.k.SubmitPlan("", PlanInput{Mission: mission, Packages: packages})
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func advised(res *PlanResult, text string) bool {
	for _, a := range res.Advice {
		if strings.Contains(a, text) {
			return true
		}
	}
	return false
}

// The reply to a plan says how wide it really is, and says so when the shape
// cannot be faster than the owner doing the work.
func TestPlanReplyReportsShapeAndWeakPlans(t *testing.T) {
	f := newFixture(t)
	f.rate("beta", 9)
	level := func(key string, n float64, deps ...string) PackageInput {
		return PackageInput{Intelligence: n, Key: key, Instruction: "x", DependsOn: deps}
	}

	// Three packages with one prerequisite: only one starts.
	res := plan(t, f, f.mission(), level("base", 5), level("a", 5, "base"), level("b", 5, "base"))
	if res.Shape.Packages != 3 || res.Shape.Ready != 1 || res.Shape.Waves != 2 {
		t.Fatalf("%+v", res.Shape)
	}
	if !advised(res, "只有 1 个包能立即开工") {
		t.Fatalf("narrow plan not flagged: %v", res.Advice)
	}

	// A wide plan of well-specified packages needs no advice.
	res = plan(t, f, f.mission(), level("a", 5), level("b", 5), level("c", 5), level("d", 5, "a", "b", "c"))
	if res.Shape.Ready != 3 || res.Shape.Waves != 2 || len(res.Advice) != 0 {
		t.Fatalf("%+v %v", res.Shape, res.Advice)
	}

	// Too many packages left at 8 or above.
	res = plan(t, f, f.mission(), level("a", 8), level("b", 8.5), level("c", 5), level("d", 5))
	if res.Shape.High != 2 || !advised(res, "8 分以上") {
		t.Fatalf("%+v %v", res.Shape, res.Advice)
	}

	// A dependency on a package already accepted in the mission does not hold anything back.
	m := f.mission()
	first := plan(t, f, m, level("a", 5), level("b", 5), level("c", 5))
	if advised(first, "连续") {
		t.Fatal(first.Advice)
	}
	for _, p := range first.Packages {
		f.succeed(p.ID, 1, "ok")
		if _, err := f.k.Verdict(p.ID, "accept", ""); err != nil {
			t.Fatal(err)
		}
	}
	res = plan(t, f, m, level("d", 5, "a"), level("e", 5, "a"), level("g", 5, "b"))
	if res.Shape.Ready != 3 || res.Shape.Waves != 1 {
		t.Fatalf("%+v", res.Shape)
	}

	// A package added beside a running wave widens it.
	if add := plan(t, f, m, level("h", 5)); add.Shape.Parallel != 4 || len(add.Advice) != 0 {
		t.Fatalf("%+v %v", add.Shape, add.Advice)
	}

	// One single-package plan after another is serial work.
	m = f.mission()
	one := plan(t, f, m, level("h", 5))
	if !advised(one, "只有 1 个包能立即开工") || advised(one, "连续") {
		t.Fatalf("first single-package plan: %v", one.Advice)
	}
	f.succeed(one.Packages[0].ID, 1, "ok")
	if _, err := f.k.Verdict(one.Packages[0].ID, "accept", ""); err != nil {
		t.Fatal(err)
	}
	two := plan(t, f, m, level("i", 5))
	if !advised(two, "连续第 2 份单包计划") {
		t.Fatalf("chain of single-package plans not flagged: %v", two.Advice)
	}
}
