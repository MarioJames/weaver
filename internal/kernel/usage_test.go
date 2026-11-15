package kernel

import (
	"io"
	"log/slog"
	"path/filepath"
	"testing"
	"time"

	"github.com/MarioJames/weaver/internal/engine"
	"github.com/MarioJames/weaver/internal/store"
)

// fixedKernel builds a kernel whose clock is the given variable.
func fixedKernel(t *testing.T, clock *time.Time, logw io.Writer) *Kernel {
	t.Helper()
	home := t.TempDir()
	db, err := store.Open(filepath.Join(home, "weaver.db"))
	if err != nil {
		t.Fatal(err)
	}
	opts := Options{
		DB:      db,
		Home:    home,
		Engines: &fakeEngines{liveness: engine.Liveness{Known: true}},
		Check:   func(engine.Account) (bool, string) { return true, "" },
		Push:    func(string, string, string) error { return nil },
		Now:     func() time.Time { return *clock },
	}
	if logw != nil {
		opts.Log = slog.New(slog.NewTextHandler(logw, nil))
	}
	k := New(opts)
	t.Cleanup(func() { k.Close(); db.Close() })
	return k
}

func addUsageAccount(t *testing.T, k *Kernel, id, provider, baseURL, config string) {
	t.Helper()
	if _, err := k.AddAccount(AccountInput{
		ID: id, Engine: "dsh", Kind: "api", APIKey: "sk-usage", Provider: provider, BaseURL: baseURL, Config: config,
	}); err != nil {
		t.Fatal(err)
	}
}

func near(t *testing.T, got *float64, want float64, what string) {
	t.Helper()
	if got == nil {
		t.Fatalf("%s is missing, want %.4f", what, want)
	}
	if diff := *got - want; diff > 0.000001 || diff < -0.000001 {
		t.Fatalf("%s = %.6f, want %.6f", what, *got, want)
	}
}

func f64(v float64) *float64 { return &v }

func set(v float64) OptionalFloat { return OptionalFloat{Set: true, Value: &v} }

func price(model string, in, out, cacheRead float64) ModelPrice {
	return ModelPrice{Model: model, UsagePrices: UsagePrices{Input: f64(in), Output: f64(out), CacheRead: f64(cacheRead)}}
}

func (u *AccountUsage) model(name string) ModelUsage {
	for _, m := range u.Models {
		if m.Model == name {
			return m
		}
	}
	return ModelUsage{}
}

// finishOn runs one package on a candidate of account acct-gamma: gamma runs
// model m, delta model m2. It finishes the run with the given usage.
func (f *fixture) finishOn(mission, worker, key string, o engine.Outcome) {
	f.t.Helper()
	ids := f.submit(mission, PackageInput{Intelligence: 1, Key: key, Instruction: "do " + key, Worker: worker})
	id := attemptID(ids[key], 1)
	f.k.Handed(id, engine.ModeCold, "unit")
	f.k.Started(id, "")
	o.Success, o.Text = true, "done"
	f.k.Finished(id, o)
}

func (f *fixture) usage(id string) *AccountUsage {
	f.t.Helper()
	a, err := f.k.Account(id)
	if err != nil {
		f.t.Fatal(err)
	}
	if a.Usage == nil {
		f.t.Fatalf("%s has no usage view", id)
	}
	return a.Usage
}

// TestUsageIsCountedFromWhatRunsReported walks the whole bookkeeping: a
// reported price is taken as is, tokens are valued at the prices of their
// own model, and the balance is reduced only by runs after it was recorded.
func TestUsageIsCountedFromWhatRunsReported(t *testing.T) {
	f := newFixture(t)
	// A new candidate is unrated, so only a package that names it uses it.
	if _, err := f.k.SetWorker(WorkerInput{ID: "delta", Engine: "codex", Model: "m2", Accounts: []string{"acct-gamma"}}); err != nil {
		t.Fatal(err)
	}
	m := f.mission()

	f.finishOn(m, "gamma", "claude", engine.Outcome{InputTokens: 12, OutputTokens: 40, CostUSD: f64(0.42)})
	f.finishOn(m, "gamma", "dsh", engine.Outcome{InputTokens: 2000, OutputTokens: 400, CacheReadTokens: 6000})
	f.finishOn(m, "delta", "other", engine.Outcome{InputTokens: 1000, OutputTokens: 100})
	u := f.usage("acct-gamma")
	if u.Month.Runs != 3 || u.Month.InputTokens != 3012 || u.Month.OutputTokens != 540 || u.Month.CacheReadTokens != 6000 || u.Month.Unpriced != 2 {
		t.Fatalf("month without prices = %+v", u.Month)
	}
	near(t, u.Month.Cost, 0.42, "cost of the priced run")
	if len(u.Models) != 2 || u.model("m").Runs != 2 || u.model("m2").Unpriced != 1 {
		t.Fatalf("models = %+v", u.Models)
	}

	// Each model has its own prices; a model without any stays unpriced.
	if _, err := f.k.SetAccountUsage("acct-gamma", UsagePatch{Prices: []ModelPrice{price("m", 1, 5, 0.1)}}); err != nil {
		t.Fatal(err)
	}
	u = f.usage("acct-gamma")
	// 0.42 reported, plus (2000×1 + 400×5 + 6000×0.1) / 1e6; the reported run is not re-priced.
	near(t, u.model("m").Cost, 0.4246, "model m")
	if u.model("m2").Cost != nil || u.Month.Unpriced != 1 {
		t.Fatalf("m2 got m's prices: %+v month=%+v", u.model("m2"), u.Month)
	}
	if _, err := f.k.SetAccountUsage("acct-gamma", UsagePatch{Prices: []ModelPrice{price("m2", 10, 20, 0)}}); err != nil {
		t.Fatal(err)
	}
	u = f.usage("acct-gamma")
	near(t, u.model("m2").Cost, 0.012, "model m2") // (1000×10 + 100×20) / 1e6
	near(t, u.Month.Cost, 0.4366, "month")
	if p := u.model("m").Prices; p.Input == nil || *p.Input != 1 {
		t.Fatalf("setting m2 changed m: %+v", p)
	}

	time.Sleep(5 * time.Millisecond) // the balance is stamped strictly after the runs above
	a, err := f.k.SetAccountUsage("acct-gamma", UsagePatch{Balance: set(50)})
	if err != nil {
		t.Fatal(err)
	}
	near(t, a.Usage.Remaining, 50, "remaining right after recording")
	if a.Usage.BalanceAt == 0 {
		t.Fatal("balance has no time")
	}

	f.finishOn(m, "gamma", "later", engine.Outcome{InputTokens: 1, CostUSD: f64(2.66)})
	u = f.usage("acct-gamma")
	near(t, u.Remaining, 47.34, "remaining")
	near(t, u.SpentSinceBalance, 2.66, "spent since balance")
	if u.Low {
		t.Fatal("low without an alert line")
	}
	a, err = f.k.SetAccountUsage("acct-gamma", UsagePatch{AlertBelow: set(48)})
	if err != nil {
		t.Fatal(err)
	}
	if !a.Usage.Low {
		t.Fatalf("47.34 below 48 must be low: %+v", a.Usage)
	}
	// Low only marks the data: the account stays ready and is not paused.
	if !a.Ready || a.PausedUntil != 0 {
		t.Fatalf("low usage changed dispatch state: ready=%v paused=%d", a.Ready, a.PausedUntil)
	}

	// Removing a model's prices leaves its later spend unpriced: no estimate.
	if _, err := f.k.SetAccountUsage("acct-gamma", UsagePatch{Prices: []ModelPrice{{Model: "m2"}}}); err != nil {
		t.Fatal(err)
	}
	f.finishOn(m, "delta", "unpriced", engine.Outcome{InputTokens: 100, OutputTokens: 10})
	u = f.usage("acct-gamma")
	if u.Remaining != nil || u.Low || u.model("m2").Unpriced != 2 {
		t.Fatalf("unpriced spend since balance: remaining=%v low=%v m2=%+v", u.Remaining, u.Low, u.model("m2"))
	}
	near(t, u.Balance, 50, "balance is kept")
}

func TestUsageSettingsRejectBadInput(t *testing.T) {
	f := newFixture(t)
	bad := price("m", 1, -1, 0)
	if _, err := f.k.SetAccountUsage("acct-alpha", UsagePatch{Prices: []ModelPrice{bad}}); AsError(err).Code != "INVALID" {
		t.Fatalf("negative price: %v", err)
	}
	if _, err := f.k.AddAccount(AccountInput{ID: "sub", Engine: "claude", Kind: "subscription", AuthDir: t.TempDir()}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.k.SetAccountUsage("sub", UsagePatch{Balance: set(10)}); AsError(err).Code != "INVALID" {
		t.Fatalf("subscription account: %v", err)
	}
	a, err := f.k.Account("sub")
	if err != nil {
		t.Fatal(err)
	}
	if a.Usage != nil {
		t.Fatalf("subscription account has a usage view: %+v", a.Usage)
	}
	if u := f.usage("acct-alpha"); u.model("m").Prices.set() {
		t.Fatal("a rejected price was stored")
	}
}
