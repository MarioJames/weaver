package kernel

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/MarioJames/weaver/internal/engine"
	"github.com/MarioJames/weaver/internal/store"
)

// fakeEngines records what the kernel asks of the launch layer.
type fakeEngines struct {
	mu        sync.Mutex
	launched  []engine.Run
	cancelled []string
	prewarmed []engine.Run
	residual  bool
	liveness  engine.Liveness
}

func (f *fakeEngines) Launch(run engine.Run) {
	f.mu.Lock()
	f.launched = append(f.launched, run)
	f.mu.Unlock()
}
func (f *fakeEngines) Cancel(id string) engine.CancelResult {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.cancelled = append(f.cancelled, id)
	return engine.CancelResult{Residual: f.residual, Workspace: "/ws"}
}
func (f *fakeEngines) Reattach(engine.Run, string, string, string) {}
func (f *fakeEngines) Prewarm(run engine.Run) {
	f.mu.Lock()
	f.prewarmed = append(f.prewarmed, run)
	f.mu.Unlock()
}
func (f *fakeEngines) DropPrewarm(string) {}
func (f *fakeEngines) Warm(string)        {}
func (f *fakeEngines) Liveness(string) engine.Liveness {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.liveness
}
func (f *fakeEngines) runs() []engine.Run {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]engine.Run{}, f.launched...)
}

type fixture struct {
	t    *testing.T
	k    *Kernel
	eng  *fakeEngines
	home string
	ws   string
	push chan string
}

func open(t *testing.T, home string, eng *fakeEngines, push chan string) *Kernel {
	t.Helper()
	db, err := store.Open(filepath.Join(home, "weaver.db"))
	if err != nil {
		t.Fatal(err)
	}
	k := New(Options{DB: db, Home: home, Engines: eng, Check: func(engine.Account) (bool, string) { return true, "" },
		Push: func(session, pane, text string) error { push <- text; return nil }})
	t.Cleanup(func() { k.Close(); db.Close() })
	return k
}

// newFixture seeds two weight-5 candidates on separate accounts and one weight-0 candidate.
func newFixture(t *testing.T) *fixture {
	t.Helper()
	home := t.TempDir()
	f := &fixture{t: t, eng: &fakeEngines{liveness: engine.Liveness{Known: true}}, home: home, ws: t.TempDir(), push: make(chan string, 8)}
	f.k = open(t, home, f.eng, f.push)
	five, zero := 5, 0
	for _, w := range []struct {
		id     string
		weight *int
	}{{"alpha", &five}, {"beta", &five}, {"gamma", &zero}} {
		if _, err := f.k.AddAccount(AccountInput{ID: "acct-" + w.id, Engine: "codex", Kind: "api", APIKey: "k", Label: w.id}); err != nil {
			t.Fatal(err)
		}
		if _, err := f.k.SetWorker(WorkerInput{ID: w.id, Engine: "codex", Model: "m", Weight: w.weight, Accounts: []string{"acct-" + w.id}}); err != nil {
			t.Fatal(err)
		}
	}
	return f
}

func (f *fixture) mission() string {
	f.t.Helper()
	m, err := f.k.CreateMission("", "任务", f.ws, nil)
	if err != nil {
		f.t.Fatal(err)
	}
	return m.ID
}

func (f *fixture) submit(mission string, packages ...PackageInput) map[string]string {
	f.t.Helper()
	res, err := f.k.SubmitPlan("", PlanInput{Mission: mission, Packages: packages})
	if err != nil {
		f.t.Fatal(err)
	}
	ids := map[string]string{}
	for _, p := range res.Packages {
		ids[p.Key] = p.ID
	}
	return ids
}

func (f *fixture) state(id string) string {
	f.t.Helper()
	p, err := f.k.Package(id)
	if err != nil {
		f.t.Fatal(err)
	}
	return p.State
}

func (f *fixture) succeed(pkg string, n int, text string) {
	id := attemptID(pkg, n)
	f.k.Handed(id, engine.ModeCold, "unit")
	f.k.Started(id, "")
	f.k.Finished(id, engine.Outcome{Success: true, Text: text})
}

func pkg(key string, deps ...string) PackageInput {
	return PackageInput{Key: key, Instruction: "do " + key, DependsOn: deps}
}

func TestIndependentPackagesAreAllReleasedBySubmit(t *testing.T) {
	f := newFixture(t)
	var plan []PackageInput
	for i := 0; i < 10; i++ {
		plan = append(plan, pkg(fmt.Sprintf("p%d", i)))
	}
	ids := f.submit(f.mission(), plan...)
	for key, id := range ids {
		if s := f.state(id); s != StateLaunch {
			t.Errorf("%s is %s, want launching", key, s)
		}
	}
	if n := len(f.eng.runs()); n != 10 {
		t.Fatalf("launched %d attempts, want 10", n)
	}
}

func TestDependentWaitsUntilUpstreamIsAccepted(t *testing.T) {
	f := newFixture(t)
	ids := f.submit(f.mission(), pkg("a"), pkg("b", "a"))
	b, _ := f.k.Package(ids["b"])
	if b.State != StatePending || !strings.Contains(b.Waiting, "a") {
		t.Fatalf("b = %s %q, want pending and waiting on a", b.State, b.Waiting)
	}
	f.succeed(ids["a"], 1, "A-RESULT")
	if s := f.state(ids["b"]); s != StatePending {
		t.Fatalf("b became %s on a's result; it must wait for the verdict", s)
	}
	if _, err := f.k.Verdict(ids["a"], "accept", ""); err != nil {
		t.Fatal(err)
	}
	if s := f.state(ids["b"]); s != StateLaunch {
		t.Fatalf("b is %s after a was accepted, want launching", s)
	}
	runs := f.eng.runs()
	if last := runs[len(runs)-1]; last.PackageID != ids["b"] || !strings.Contains(last.Instruction, "A-RESULT") {
		t.Fatalf("b was not launched with a's accepted result in its instruction")
	}
}

func TestCyclicPlanIsRejectedWhole(t *testing.T) {
	f := newFixture(t)
	m := f.mission()
	_, err := f.k.SubmitPlan("", PlanInput{Mission: m, Packages: []PackageInput{pkg("ok"), pkg("x", "z"), pkg("y", "x"), pkg("z", "y")}})
	e := AsError(err)
	if err == nil || e.Code != "CYCLE" {
		t.Fatalf("err = %v, want CYCLE", err)
	}
	for _, key := range []string{"x", "y", "z"} {
		if !strings.Contains(e.Message, key) {
			t.Errorf("message %q does not name %s", e.Message, key)
		}
	}
	packages, _ := f.k.Packages(m)
	if len(packages) != 0 || len(f.eng.runs()) != 0 {
		t.Fatalf("a rejected plan created %d packages and %d launches", len(packages), len(f.eng.runs()))
	}
}

func TestReturnStartsSecondAttemptCarryingTheNote(t *testing.T) {
	f := newFixture(t)
	m := f.mission()
	ids := f.submit(m, pkg("a"))
	f.succeed(ids["a"], 1, "first answer")
	if _, err := f.k.Verdict(ids["a"], "return", "缺少单元测试"); err != nil {
		t.Fatal(err)
	}
	p, _ := f.k.Package(ids["a"])
	if p.State != StateLaunch || p.Attempt != 2 || len(p.Attempts) != 2 || p.Attempts[0].State != StateReturned {
		t.Fatalf("after return: state=%s attempt=%d attempts=%d", p.State, p.Attempt, len(p.Attempts))
	}
	runs := f.eng.runs()
	second := runs[len(runs)-1]
	if second.AttemptID != attemptID(ids["a"], 2) || !strings.Contains(second.Instruction, "缺少单元测试") || !strings.Contains(second.Instruction, "first answer") {
		t.Fatalf("second attempt does not carry the note and the previous reply")
	}
	if packages, _ := f.k.Packages(m); len(packages) != 1 {
		t.Fatalf("mission lists %d packages, want the same one", len(packages))
	}
}

func TestVerdictOnlyAppliesToPackagesAwaitingOne(t *testing.T) {
	f := newFixture(t)
	ids := f.submit(f.mission(), pkg("a"))
	if _, err := f.k.Verdict(ids["a"], "accept", ""); AsError(err).Code != "WRONG_STATE" {
		t.Fatalf("accepting a launching package: %v, want WRONG_STATE", err)
	}
}

func TestRepeatedKeyReturnsFirstPlanWithoutCreatingAgain(t *testing.T) {
	f := newFixture(t)
	m := f.mission()
	in := PlanInput{Mission: m, Packages: []PackageInput{pkg("a"), pkg("b")}}
	first, err := f.k.SubmitPlan("key-1", in)
	if err != nil {
		t.Fatal(err)
	}
	second, err := f.k.SubmitPlan("key-1", in)
	if err != nil {
		t.Fatal(err)
	}
	if second.Packages[0].ID != first.Packages[0].ID || second.Packages[1].ID != first.Packages[1].ID {
		t.Fatalf("replay returned different packages")
	}
	if packages, _ := f.k.Packages(m); len(packages) != 2 || len(f.eng.runs()) != 2 {
		t.Fatalf("replay created more: %d packages, %d launches", len(packages), len(f.eng.runs()))
	}
}

func TestWaitDeliversEachResultExactlyOnce(t *testing.T) {
	f := newFixture(t)
	m := f.mission()
	ids := f.submit(m, pkg("a"), pkg("b"), pkg("c"))
	done := make(chan *WaitResult, 1)
	go func() {
		res, err := f.k.Wait(context.Background(), m, nil, 5*time.Second)
		if err != nil {
			t.Error(err)
		}
		done <- res
	}()
	time.Sleep(50 * time.Millisecond)
	f.succeed(ids["a"], 1, "A")
	var first *WaitResult
	select {
	case first = <-done:
	case <-time.After(time.Second):
		t.Fatal("wait did not return after the first result")
	}
	if len(first.Wakes) != 1 || first.Wakes[0].Key != "a" || first.Wakes[0].Summary != "A" {
		t.Fatalf("first wait = %+v", first.Wakes)
	}
	f.succeed(ids["b"], 1, "B")
	f.succeed(ids["c"], 1, "C")
	second, err := f.k.Wait(context.Background(), m, &first.Cursor, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if len(second.Wakes) != 2 || second.Wakes[0].Key != "b" || second.Wakes[1].Key != "c" {
		t.Fatalf("second wait = %+v, want b then c", second.Wakes)
	}
	third, err := f.k.Wait(context.Background(), m, nil, 100*time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	if len(third.Wakes) != 0 {
		t.Fatalf("a wait without a cursor repeated %d wakes", len(third.Wakes))
	}
}

func TestWaitReturnsAtOnceWhenNothingCanArrive(t *testing.T) {
	f := newFixture(t)
	m := f.mission()
	ids := f.submit(m, pkg("a"))
	f.succeed(ids["a"], 1, "A")
	if _, err := f.k.Wait(context.Background(), m, nil, time.Second); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	res, err := f.k.Wait(context.Background(), m, nil, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if !res.Idle || time.Since(start) > time.Second {
		t.Fatalf("idle=%v after %s; a wait with nothing running must not block", res.Idle, time.Since(start))
	}
}

func TestTimerSetBeforeRestartFiresAfterIt(t *testing.T) {
	f := newFixture(t)
	m := f.mission()
	due := time.Now().Add(600 * time.Millisecond)
	if _, err := f.k.SetTimer("", m, due, "看一眼构建"); err != nil {
		t.Fatal(err)
	}
	f.k.Close()
	restarted := open(t, f.home, f.eng, f.push)
	if err := restarted.Start(); err != nil {
		t.Fatal(err)
	}
	res, err := restarted.Wait(context.Background(), m, nil, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Wakes) != 1 || res.Wakes[0].Kind != EvTimer || !strings.Contains(res.Wakes[0].Message, "看一眼构建") {
		t.Fatalf("wakes = %+v, want the timer", res.Wakes)
	}
	if late := time.Since(due); late < 0 || late > 2*time.Second {
		t.Fatalf("timer fired %s after its due time", late)
	}
}

func TestCancelledPackageNeverReachesVerdict(t *testing.T) {
	f := newFixture(t)
	m := f.mission()
	ids := f.submit(m, pkg("a"), pkg("b"))
	id := attemptID(ids["a"], 1)
	f.k.Handed(id, engine.ModeCold, "unit")
	f.k.Started(id, "")
	res, err := f.k.Cancel("", ids["a"])
	if err != nil {
		t.Fatal(err)
	}
	if len(f.eng.cancelled) != 1 || f.eng.cancelled[0] != id {
		t.Fatalf("engine cancel calls = %v", f.eng.cancelled)
	}
	if res.Mission.Counts[StateCanceled] != 1 || res.Mission.Counts[StateLaunch] != 1 {
		t.Fatalf("mission counts after cancel = %v", res.Mission.Counts)
	}
	// The engine may still report a result that was already on its way.
	f.k.Finished(id, engine.Outcome{Success: true, Text: "late"})
	if s := f.state(ids["a"]); s != StateCanceled {
		t.Fatalf("cancelled package became %s", s)
	}
	if _, err := f.k.Cancel("", ids["a"]); AsError(err).Code != "WRONG_STATE" {
		t.Fatalf("cancelling twice: %v", err)
	}
}

func TestCancelOnResidentEngineWarnsAboutLeftoverProcesses(t *testing.T) {
	f := newFixture(t)
	f.eng.residual = true
	m := f.mission()
	ids := f.submit(m, pkg("a"))
	f.k.Started(attemptID(ids["a"], 1), "")
	res, err := f.k.Cancel("", ids["a"])
	if err != nil {
		t.Fatal(err)
	}
	if !res.Cancelled[0].Residual || res.Cancelled[0].Workspace != "/ws" {
		t.Fatalf("cancel result = %+v", res.Cancelled[0])
	}
	events, _ := f.k.Events(m, 0, 0)
	last := events[len(events)-1]
	if last.Kind != EvCancelled || !strings.Contains(last.Message, "/ws") {
		t.Fatalf("last event = %+v, want a warning naming the workspace", last)
	}
}

func TestRoutingUsesOnlyWeightedCandidatesAndBalancesThem(t *testing.T) {
	f := newFixture(t)
	var plan []PackageInput
	for i := 0; i < 10; i++ {
		plan = append(plan, pkg(fmt.Sprintf("p%d", i)))
	}
	f.submit(f.mission(), plan...)
	count := map[string]int{}
	packages, _ := f.k.Packages(f.missionID())
	for _, p := range packages {
		count[p.Current.Worker]++
	}
	if count["alpha"] != 5 || count["beta"] != 5 || count["gamma"] != 0 {
		t.Fatalf("distribution = %v, want alpha 5, beta 5, gamma 0", count)
	}
}

func (f *fixture) missionID() string {
	missions, _ := f.k.Missions(false)
	return missions[0].ID
}

func TestPinnedPackageUsesAZeroWeightCandidate(t *testing.T) {
	f := newFixture(t)
	ids := f.submit(f.mission(), PackageInput{Key: "a", Instruction: "x", Worker: "gamma"})
	p, _ := f.k.Package(ids["a"])
	if p.State != StateLaunch || p.Current.Worker != "gamma" {
		t.Fatalf("pinned package: state=%s worker=%v", p.State, p.Current)
	}
}

func TestVendorLimitPausesTheAccountAndMovesThePackage(t *testing.T) {
	f := newFixture(t)
	m := f.mission()
	ids := f.submit(m, pkg("a"))
	p, _ := f.k.Package(ids["a"])
	firstWorker := p.Current.Worker
	f.k.Finished(attemptID(ids["a"], 1), engine.Outcome{FailureKind: engine.FailQuota, FailureMessage: "usage limit reached"})
	p, _ = f.k.Package(ids["a"])
	if p.State != StateLaunch || p.Attempt != 2 || p.Current.Worker == firstWorker {
		t.Fatalf("after a quota failure: state=%s attempt=%d worker=%s (first was %s)", p.State, p.Attempt, p.Current.Worker, firstWorker)
	}
	account, _ := f.k.Account("acct-" + firstWorker)
	if until := time.UnixMilli(account.PausedUntil); time.Until(until) < 9*time.Minute || time.Until(until) > 11*time.Minute {
		t.Fatalf("account paused until %s, want about 10 minutes", until)
	}
}

func TestOrdinaryFailureWakesTheParentAndCanBeRetried(t *testing.T) {
	f := newFixture(t)
	m := f.mission()
	ids := f.submit(m, pkg("a"))
	f.k.Finished(attemptID(ids["a"], 1), engine.Outcome{FailureKind: engine.FailVendor, FailureMessage: "boom"})
	res, err := f.k.Wait(context.Background(), m, nil, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Wakes) != 1 || res.Wakes[0].Kind != EvFailed || res.Wakes[0].State != StateFailed {
		t.Fatalf("wakes = %+v", res.Wakes)
	}
	if _, err := f.k.Retry(ids["a"], ""); err != nil {
		t.Fatal(err)
	}
	if p, _ := f.k.Package(ids["a"]); p.State != StateLaunch || p.Attempt != 2 {
		t.Fatalf("after retry: %s attempt %d", p.State, p.Attempt)
	}
}

func TestSilentAttemptIsReportedStalledButKeepsRunning(t *testing.T) {
	f := newFixture(t)
	if err := f.k.SetSetting("stall_seconds", "1"); err != nil {
		t.Fatal(err)
	}
	if err := f.k.Start(); err != nil {
		t.Fatal(err)
	}
	m := f.mission()
	ids := f.submit(m, pkg("a"))
	f.k.Started(attemptID(ids["a"], 1), "")
	res, err := f.k.Wait(context.Background(), m, nil, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Wakes) != 1 || res.Wakes[0].Kind != EvStalled || res.Wakes[0].Key != "a" {
		t.Fatalf("wakes = %+v, want one stall report for a", res.Wakes)
	}
	if s := f.state(ids["a"]); s != StateRunning {
		t.Fatalf("stalled package is %s; it must keep running", s)
	}
}

func TestBusyProcessIsNotReportedStalled(t *testing.T) {
	f := newFixture(t)
	if err := f.k.SetSetting("stall_seconds", "1"); err != nil {
		t.Fatal(err)
	}
	stop := make(chan struct{})
	defer close(stop)
	go func() { // a process burning a full core
		start := time.Now()
		for {
			select {
			case <-stop:
				return
			case <-time.After(20 * time.Millisecond):
				f.eng.mu.Lock()
				f.eng.liveness = engine.Liveness{Known: true, Process: true, CPUNSec: uint64(time.Since(start))}
				f.eng.mu.Unlock()
			}
		}
	}()
	if err := f.k.Start(); err != nil {
		t.Fatal(err)
	}
	m := f.mission()
	ids := f.submit(m, pkg("a"))
	f.k.Started(attemptID(ids["a"], 1), "")
	res, err := f.k.Wait(context.Background(), m, nil, 2500*time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Wakes) != 0 {
		t.Fatalf("a silent but busy process was reported: %+v", res.Wakes)
	}
}

func TestResultIsPushedWhenNobodyWaitsAndNotRepeatedToTheNextWait(t *testing.T) {
	f := newFixture(t)
	m, err := f.k.CreateMission("", "任务", f.ws, &Notify{Pane: "pane-1"})
	if err != nil {
		t.Fatal(err)
	}
	ids := f.submit(m.ID, pkg("a"), pkg("b"))
	f.succeed(ids["a"], 1, "A")
	select {
	case text := <-f.push:
		if !strings.Contains(text, ids["a"]) || !strings.Contains(text, `"summary":"A"`) {
			t.Fatalf("pushed text lacks the result: %s", text)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("nothing was pushed")
	}
	res, err := f.k.Wait(context.Background(), m.ID, nil, 200*time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Wakes) != 0 {
		t.Fatalf("the pushed result was delivered again: %+v", res.Wakes)
	}
}

func TestPrewarmIsRequestedOnceUpstreamHasItsResult(t *testing.T) {
	f := newFixture(t)
	ids := f.submit(f.mission(), pkg("a"), PackageInput{Key: "b", Instruction: "x", Worker: "gamma", DependsOn: []string{"a"}})
	if len(f.eng.prewarmed) != 0 {
		t.Fatalf("prewarmed before the upstream result")
	}
	f.succeed(ids["a"], 1, "A")
	if len(f.eng.prewarmed) == 0 || f.eng.prewarmed[0].PackageID != ids["b"] || f.eng.prewarmed[0].AttemptID != attemptID(ids["b"], 1) {
		t.Fatalf("prewarm requests = %+v", f.eng.prewarmed)
	}
}
