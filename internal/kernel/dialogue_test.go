package kernel

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/MarioJames/weaver/internal/engine"
)

// dialogueFixture adds one claude candidate next to the codex ones, at weight 0
// like the real setup: a dialogue must still be able to use it.
func dialogueFixture(t *testing.T) *fixture {
	f := newFixture(t)
	zero := 0
	if _, err := f.k.AddAccount(AccountInput{ID: "acct-claude", Engine: "claude", Kind: "api", APIKey: "k", Label: "claude"}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.k.SetWorker(WorkerInput{ID: "claude_w", Engine: "claude", Model: "m", Weight: &zero, Accounts: []string{"acct-claude"}}); err != nil {
		t.Fatal(err)
	}
	return f
}

func (f *fixture) last(pkgID string) string {
	f.t.Helper()
	runs := f.eng.runs()
	for i := len(runs) - 1; i >= 0; i-- {
		if runs[i].PackageID == pkgID {
			return runs[i].Instruction
		}
	}
	f.t.Fatalf("package %s was never launched", pkgID)
	return ""
}

func TestAdvisoryPackageIsToldToWriteADocumentAndLeaveFilesAlone(t *testing.T) {
	f := newFixture(t)
	ids := f.submit(f.mission(), PackageInput{Key: "work", Instruction: "do it"}, PackageInput{Key: "advice", Instruction: "compare the options", Advisory: true})
	advice, work := f.last(ids["advice"]), f.last(ids["work"])
	if !strings.Contains(advice, "Do not create, modify or delete files") {
		t.Errorf("an advisory package must be told not to change files:\n%s", advice)
	}
	if strings.Contains(advice, "what you actually changed") {
		t.Error("an advisory package must not be asked to report changes")
	}
	if !strings.Contains(work, "what you actually changed") || strings.Contains(work, "Do not create, modify or delete files") {
		t.Error("an ordinary package keeps the worker contract")
	}
}

func TestAutoAcceptedResultReleasesDependentsWithoutWakingTheOwner(t *testing.T) {
	f := newFixture(t)
	m := f.mission()
	ids := f.submit(m, PackageInput{Key: "a", Instruction: "first", AutoAccept: true}, pkg("b", "a"))
	f.succeed(ids["a"], 1, "A-RESULT")
	if s := f.state(ids["a"]); s != StateAccepted {
		t.Fatalf("a is %s after its result, want accepted", s)
	}
	if s := f.state(ids["b"]); s != StateLaunch {
		t.Fatalf("b is %s, want launching as soon as a had its result", s)
	}
	res, err := f.k.Wait(context.Background(), m, nil, 100*time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Wakes) != 0 {
		t.Fatalf("an auto-accepted result woke the owner: %+v", res.Wakes)
	}
	// A failure is never hidden, auto-accept or not.
	ids2 := f.submit(m, PackageInput{Key: "c", Instruction: "x", AutoAccept: true})
	f.fail(ids2["c"], 1, "boom")
	res, _ = f.k.Wait(context.Background(), m, nil, 100*time.Millisecond)
	if len(res.Wakes) != 1 || res.Wakes[0].Kind != EvFailed {
		t.Fatalf("a failed auto-accept package must wake the owner, got %+v", res.Wakes)
	}
}

func TestDialogueRunsProposalsThenCrossReviewAndWakesOnlyAtTheEnd(t *testing.T) {
	f := dialogueFixture(t)
	m := f.mission()
	d, err := f.k.StartDialogue("", DialogueInput{Mission: m, Name: "design", Brief: "Should the cache live in the gateway or in a sidecar?"})
	if err != nil {
		t.Fatal(err)
	}
	if len(d.Packages) != 4 || len(d.Final) != 2 {
		t.Fatalf("a default dialogue is two proposals and one exchange, got %d packages, final %v", len(d.Packages), d.Final)
	}
	ids := map[string]string{}
	for _, p := range d.Packages {
		ids[p.Key] = p.ID
	}
	// Round 1: both sides at once, on different engines, each seeing only the brief.
	runs := f.eng.runs()
	if len(runs) != 2 {
		t.Fatalf("round 1 launched %d packages, want 2", len(runs))
	}
	engines := map[string]bool{}
	for _, r := range runs {
		engines[r.Engine] = true
		if !strings.Contains(r.Instruction, "cache live in the gateway") || !strings.Contains(r.Instruction, "Do not create, modify or delete files") {
			t.Errorf("a proposal must carry the brief and the read-only contract")
		}
	}
	if !engines["codex"] || !engines["claude"] {
		t.Fatalf("the two sides must run on codex and claude, got %v", engines)
	}
	f.succeed(ids["design.r1.a"], 1, "PROPOSAL-A "+strings.Repeat("x", 9000))
	if s := f.state(ids["design.r2.a"]); s != StatePending {
		t.Fatalf("the exchange started with only one proposal in (%s)", s)
	}
	f.succeed(ids["design.r1.b"], 1, "PROPOSAL-B")
	// Round 2 starts by itself and each side reads both proposals in full.
	for _, key := range []string{"design.r2.a", "design.r2.b"} {
		in := f.last(ids[key])
		if !strings.HasPrefix(strings.SplitN(in, "PROPOSAL-A", 2)[0], "You are") || !strings.Contains(in, "PROPOSAL-A "+strings.Repeat("x", 9000)) || !strings.Contains(in, "PROPOSAL-B") {
			t.Errorf("%s did not receive both proposals whole", key)
		}
		if !strings.Contains(in, "cache live in the gateway") {
			t.Errorf("%s lost the brief; each round is a fresh agent", key)
		}
	}
	if res, _ := f.k.Wait(context.Background(), m, nil, 100*time.Millisecond); len(res.Wakes) != 0 {
		t.Fatalf("the owner was woken between rounds: %+v", res.Wakes)
	}
	f.succeed(ids["design.r2.a"], 1, "FINAL-A")
	f.succeed(ids["design.r2.b"], 1, "FINAL-B")
	res, _ := f.k.Wait(context.Background(), m, nil, 100*time.Millisecond)
	if len(res.Wakes) != 2 {
		t.Fatalf("the final positions must wake the owner, got %+v", res.Wakes)
	}
	if s := f.state(ids["design.r2.a"]); s != StateVerdict {
		t.Fatalf("a final position is %s; the owner decides on it", s)
	}
	tr, err := f.k.Dialogue(m, "design")
	if err != nil {
		t.Fatal(err)
	}
	if tr.State != "concluded" || len(tr.Rounds) != 2 || tr.Rounds[1].Entries[1].Result != "FINAL-B" || tr.Rounds[0].Entries[0].Result[:10] != "PROPOSAL-A" {
		t.Fatalf("transcript = %+v", tr)
	}
	if !strings.Contains(tr.Hint, "采纳") {
		t.Fatalf("while the final positions await a verdict the hint must ask for it, got %q", tr.Hint)
	}
	for _, key := range []string{"design.r2.a", "design.r2.b"} {
		if _, err := f.k.Verdict(ids[key], "accept", ""); err != nil {
			t.Fatal(err)
		}
	}
	if tr, _ = f.k.Dialogue(m, "design"); tr.State != "concluded" || strings.Contains(tr.Hint, "给出采纳") {
		t.Fatalf("a closed dialogue must not keep asking for a verdict: %s %q", tr.State, tr.Hint)
	}
}

func TestDialogueNeedsTwoDifferentReadySides(t *testing.T) {
	f := newFixture(t) // codex only
	m := f.mission()
	if _, err := f.k.StartDialogue("", DialogueInput{Mission: m, Brief: "x"}); err == nil || !strings.Contains(AsError(err).Message, "claude") {
		t.Fatalf("without a claude candidate the dialogue must be refused and say so, got %v", err)
	}
	if ps, _ := f.k.Packages(m); len(ps) != 0 {
		t.Fatalf("a refused dialogue created %d packages", len(ps))
	}
	// Two named candidates work on any engines.
	d, err := f.k.StartDialogue("", DialogueInput{Mission: m, Brief: "x", Workers: []string{"alpha", "gamma"}, Rounds: 2})
	if err != nil {
		t.Fatal(err)
	}
	if len(d.Packages) != 6 {
		t.Fatalf("two exchanges make six packages, got %d", len(d.Packages))
	}
	if _, err := f.k.StartDialogue("", DialogueInput{Mission: m, Name: "again", Brief: "x", Workers: []string{"alpha", "alpha"}}); err == nil {
		t.Fatal("a dialogue of one candidate with itself must be refused")
	}
}

func (f *fixture) fail(pkg string, n int, message string) {
	f.k.Finished(attemptID(pkg, n), engine.Outcome{FailureKind: engine.FailVendor, FailureMessage: message})
}

func TestDialogueContinuesAfterAFailedSideIsRetried(t *testing.T) {
	f := dialogueFixture(t)
	m := f.mission()
	d, err := f.k.StartDialogue("", DialogueInput{Mission: m, Brief: "x"})
	if err != nil {
		t.Fatal(err)
	}
	ids := map[string]string{}
	for _, p := range d.Packages {
		ids[p.Key] = p.ID
	}
	f.succeed(ids["dialogue.r1.a"], 1, "A")
	f.fail(ids["dialogue.r1.b"], 1, "boom")
	res, _ := f.k.Wait(context.Background(), m, nil, 100*time.Millisecond)
	if len(res.Wakes) != 1 || res.Wakes[0].Kind != EvFailed {
		t.Fatalf("the failed side must wake the owner, got %+v", res.Wakes)
	}
	tr, _ := f.k.Dialogue(m, "")
	if tr.State != "needs_attention" || !strings.Contains(tr.Hint, "dialogue.r1.b") {
		t.Fatalf("transcript = %s %q", tr.State, tr.Hint)
	}
	if s := f.state(ids["dialogue.r2.a"]); s != StatePending {
		t.Fatalf("the exchange started without the failed side (%s)", s)
	}
	if _, err := f.k.Retry(ids["dialogue.r1.b"], ""); err != nil {
		t.Fatal(err)
	}
	f.succeed(ids["dialogue.r1.b"], 2, "B")
	if s := f.state(ids["dialogue.r2.a"]); s != StateLaunch {
		t.Fatalf("the exchange is %s after the retried side came in, want launching", s)
	}
	if tr, _ := f.k.Dialogue(m, ""); tr.State != "running" {
		t.Fatalf("state = %s, want running", tr.State)
	}
}
