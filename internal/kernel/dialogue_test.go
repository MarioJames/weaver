package kernel

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/MarioJames/weaver/internal/engine"
)

// dialogueFixture adds a rated claude candidate and both dialogue seats.
func dialogueFixture(t *testing.T) *fixture {
	t.Helper()
	f := newFixture(t)
	zero := 5.0
	if _, err := f.k.AddAccount(AccountInput{ID: "acct-claude", Engine: "claude", Kind: "api", APIKey: "k", Label: "claude"}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.k.SetWorker(WorkerInput{ID: "claude_w", Engine: "claude", Model: "m", Intelligence: &zero, Accounts: []string{"acct-claude"}}); err != nil {
		t.Fatal(err)
	}

	for _, seat := range []struct{ id, engine, account, model, effort string }{
		{"debater_a", "codex", "acct-alpha", "top-a", "high"},
		{"debater_b", "claude", "acct-claude", "top-b", "max"},
	} {
		if _, err := f.k.SetWorker(WorkerInput{ID: seat.id, Engine: seat.engine, Model: seat.model, Effort: &seat.effort, Accounts: []string{seat.account}}); err != nil {
			t.Fatal(err)
		}
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
	ids := f.submit(f.mission(), PackageInput{Intelligence: 1, Key: "work", Instruction: "do it"}, PackageInput{Intelligence: 1, Key: "advice", Instruction: "compare the options", Advisory: true})
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
	ids := f.submit(m, PackageInput{Intelligence: 1, Key: "a", Instruction: "first", AutoAccept: true}, pkg("b", "a"))
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
	ids2 := f.submit(m, PackageInput{Intelligence: 1, Key: "c", Instruction: "x", AutoAccept: true})
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
	if _, err := f.k.StartDialogue("", DialogueInput{Mission: m, Brief: "x"}); err == nil || !strings.Contains(AsError(err).Message, "甲方") {
		t.Fatalf("without dialogue seats the dialogue must be refused and say so, got %v", err)
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
	// The mission names the dialogue as what broke, also while other results wait for a verdict.
	if got, _ := f.k.Mission(m); got.State != "dialogue_error" {
		t.Fatalf("mission state = %s, want dialogue_error", got.State)
	}
	for want, counts := range map[string]map[string]int{
		"dialogue_error": {StateVerdict: 1, StateFailed: 1, StatePending: 2},
		"running":        {StateRunning: 1, StateFailed: 1},
	} {
		if got := missionState(counts, 4, true, false); got != want {
			t.Fatalf("missionState(%v) = %s, want %s", counts, got, want)
		}
	}
	if got := missionState(map[string]int{StateVerdict: 1, StateFailed: 1}, 2, false, false); got != "awaiting_verdict" {
		t.Fatalf("a failed work package keeps the old order, got %s", got)
	}
	if _, err := f.k.Retry(ids["dialogue.r1.b"], ""); err != nil {
		t.Fatal(err)
	}
	if got, _ := f.k.Mission(m); got.State == "dialogue_error" {
		t.Fatal("a retried side is no longer a dialogue error")
	}
	f.succeed(ids["dialogue.r1.b"], 2, "B")
	if s := f.state(ids["dialogue.r2.a"]); s != StateLaunch {
		t.Fatalf("the exchange is %s after the retried side came in, want launching", s)
	}
	if tr, _ := f.k.Dialogue(m, ""); tr.State != "running" {
		t.Fatalf("state = %s, want running", tr.State)
	}
}

func TestDialogueDebaterPinsAndAttemptConfigurationA28(t *testing.T) {
	f := dialogueFixture(t)
	d, err := f.k.StartDialogue("", DialogueInput{Mission: f.mission(), Brief: "x"})
	if err != nil {
		t.Fatal(err)
	}
	for i, p := range d.Packages {
		id, model, effort, label := "debater_a", "top-a", "high", "甲方"
		if i%2 == 1 {
			id, model, effort, label = "debater_b", "top-b", "max", "乙方"
		}
		if p.Worker != id || p.Engine != "" || !strings.Contains(p.Title, label) {
			t.Fatalf("package: %+v", p)
		}
		if i < 2 {
			full, err := f.k.Package(p.ID)
			if err != nil {
				t.Fatal(err)
			}
			if full.Current == nil || full.Current.Worker != id || full.Current.Model != model || full.Current.Effort != effort {
				t.Fatalf("attempt: %+v", full.Current)
			}
		}
	}
}

func TestDebatersExcludedFromAutomaticAndEngineRoutingA29(t *testing.T) {
	f := dialogueFixture(t)
	// The seats are idle while the execution candidates carry load; they must
	// stay out of automatic and engine-pinned routing all the same.
	var packages []PackageInput
	for i := 0; i < 20; i++ {
		packages = append(packages, PackageInput{Intelligence: 1, Key: fmt.Sprintf("auto%d", i), Instruction: "x"})
	}
	for i, e := range []string{"codex", "codex", "claude", "claude"} {
		packages = append(packages, PackageInput{Intelligence: 1, Key: fmt.Sprintf("engine%d", i), Instruction: "x", Engine: e})
	}
	ids := f.submit(f.mission(), packages...)
	for _, id := range ids {
		p, err := f.k.Package(id)
		if err != nil {
			t.Fatal(err)
		}
		if p.Current == nil {
			t.Fatalf("package did not launch: %+v", p)
		}
		if p.Current.Worker == "debater_a" || p.Current.Worker == "debater_b" {
			t.Fatalf("routed to seat: %+v", p.Current)
		}
	}
}

func TestDialogueRejectsUnconfiguredDebatersAtomicallyA30(t *testing.T) {
	for _, reason := range []string{"missing", "disabled", "unbound", "account-disabled", "not-ready", "paused"} {
		t.Run(reason, func(t *testing.T) {
			f := dialogueFixture(t)
			err := f.k.write(func(tx *tx) error {
				var err error
				switch reason {
				case "missing":
					_, err = tx.Exec("DELETE FROM workers WHERE id='debater_b'")
				case "disabled":
					_, err = tx.Exec("UPDATE workers SET enabled=0 WHERE id='debater_b'")
				case "unbound":
					_, err = tx.Exec("DELETE FROM worker_accounts WHERE worker_id='debater_b'")
				case "account-disabled":
					_, err = tx.Exec("UPDATE accounts SET enabled=0 WHERE id='acct-claude'")
				case "not-ready":
					_, err = tx.Exec("UPDATE accounts SET ready=0,ready_reason='需要登录' WHERE id='acct-claude'")
				case "paused":
					_, err = tx.Exec("UPDATE accounts SET paused_until=?,pause_reason='限流' WHERE id='acct-claude'", tx.now+60000)
				}
				return err
			})
			if err != nil {
				t.Fatal(err)
			}
			m := f.mission()
			_, err = f.k.StartDialogue("", DialogueInput{Mission: m, Brief: "x"})
			want := map[string]string{"missing": "不存在", "disabled": "已停用", "unbound": "没有绑定账号", "account-disabled": "账号「claude」已停用", "not-ready": "需要登录", "paused": "限流"}[reason]
			if err == nil || AsError(err).Code != "INVALID" || !strings.Contains(err.Error(), "乙方") || !strings.Contains(err.Error(), want) || !strings.Contains(err.Error(), "--workers") || !strings.Contains(err.Error(), "对谈人") {
				t.Fatalf("error: %v", err)
			}
			ps, err := f.k.Packages(m)
			if err != nil || len(ps) != 0 {
				t.Fatalf("packages=%v err=%v", ps, err)
			}
		})
	}
}

func TestDebaterConfigurationAndRole(t *testing.T) {
	f := dialogueFixture(t)
	rated := 9.0
	if _, err := f.k.SetWorker(WorkerInput{ID: "debater_a", Intelligence: &rated}); err == nil || AsError(err).Code != "INVALID" || !strings.Contains(err.Error(), "对谈人不参与选路") {
		t.Fatalf("rated seat: %v", err)
	}
	// Changing a seat's engine must replace the model and accounts with it.
	for _, in := range []WorkerInput{{ID: "debater_a", Engine: "claude"}, {ID: "debater_a", Engine: "claude", Model: "changed"}, {ID: "debater_a", Engine: "claude", Accounts: []string{"acct-claude"}}} {
		if _, err := f.k.SetWorker(in); err == nil || AsError(err).Code != "INVALID" {
			t.Fatalf("partial engine change accepted: %+v: %v", in, err)
		}
	}
	w, err := f.k.SetWorker(WorkerInput{ID: "debater_a", Engine: "claude", Model: "changed", Accounts: []string{"acct-claude"}})
	if err != nil {
		t.Fatal(err)
	}
	if w.Engine != "claude" || w.Intelligence != 0 {
		t.Fatalf("seat: %+v", w)
	}
	for _, id := range []string{"debater_a", "debater_b", "alpha"} {
		w, err := f.k.Worker(id)
		if err != nil {
			t.Fatal(err)
		}
		b, err := json.Marshal(w)
		if err != nil {
			t.Fatal(err)
		}
		var body map[string]any
		if err = json.Unmarshal(b, &body); err != nil {
			t.Fatal(err)
		}
		role := "debater"
		if id == "alpha" {
			role = "worker"
		}
		if body["role"] != role {
			t.Fatalf("%s JSON: %s", id, b)
		}
	}
	if _, err := f.k.SetWorker(WorkerInput{ID: "alpha", Engine: "claude", Accounts: []string{"acct-claude"}}); err == nil {
		t.Fatal("ordinary engine changed")
	}
	if err := f.k.RemoveWorker("debater_a"); err != nil {
		t.Fatal(err)
	}
	for _, in := range []WorkerInput{
		{ID: "debater_a"}, {ID: "debater_a", Engine: "codex"}, {ID: "debater_a", Engine: "codex", Model: "m"},
	} {
		if _, err := f.k.SetWorker(in); err == nil {
			t.Fatalf("incomplete seat accepted: %+v", in)
		}
	}
	_, err = f.k.StartDialogue("", DialogueInput{Mission: f.mission(), Brief: "x"})
	if err == nil || !strings.Contains(err.Error(), "甲方") {
		t.Fatalf("removed seat: %v", err)
	}
}

func TestDialogueRoundsSetting(t *testing.T) {
	f := dialogueFixture(t)
	if got := f.k.Setting("dialogue_rounds"); got != "1" {
		t.Fatalf("default=%q", got)
	}
	for _, v := range []string{"0", "4", "-1", "x", "01", ""} {
		if err := f.k.SetSetting("dialogue_rounds", v); err == nil {
			t.Fatalf("accepted %q", v)
		}
	}
	for _, v := range []string{"1", "2", "3"} {
		if err := f.k.SetSetting("dialogue_rounds", v); err != nil {
			t.Fatal(err)
		}
	}
	d, err := f.k.StartDialogue("", DialogueInput{Mission: f.mission(), Brief: "x"})
	if err != nil {
		t.Fatal(err)
	}
	if len(d.Packages) != 8 {
		t.Fatalf("rounds setting ignored: %d", len(d.Packages))
	}
	d, err = f.k.StartDialogue("", DialogueInput{Mission: f.mission(), Brief: "x", Rounds: 1})
	if err != nil {
		t.Fatal(err)
	}
	if len(d.Packages) != 4 {
		t.Fatalf("explicit rounds ignored: %d", len(d.Packages))
	}
}
