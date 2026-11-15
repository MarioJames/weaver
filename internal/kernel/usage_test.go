package kernel

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/MarioJames/weaver/internal/engine"
	"github.com/MarioJames/weaver/internal/store"
)

// fixedKernel builds a kernel whose clock is the given variable. The pointer
// lets a test move time forward between queries.
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

func withOpenAICosts(t *testing.T, url string) {
	t.Helper()
	old := openAICostsURL
	openAICostsURL = url
	t.Cleanup(func() { openAICostsURL = old })
}

func withAnthropicCosts(t *testing.T, url string) {
	t.Helper()
	old := anthropicCostURL
	anthropicCostURL = url
	t.Cleanup(func() { anthropicCostURL = old })
}

func TestUsagePatchTellsAbsentBalanceFromNull(t *testing.T) {
	var omitted struct {
		ID string `json:"id"`
		UsagePatch
	}
	if err := json.Unmarshal([]byte(`{"id":"a"}`), &omitted); err != nil {
		t.Fatal(err)
	}
	if omitted.Balance.Set || omitted.AlertBelow.Set {
		t.Fatalf("an absent field was treated as set: %+v", omitted.UsagePatch)
	}
	var cleared struct {
		ID string `json:"id"`
		UsagePatch
	}
	if err := json.Unmarshal([]byte(`{"id":"a","adminKey":"","balance":null,"alertBelow":null}`), &cleared); err != nil {
		t.Fatal(err)
	}
	if cleared.AdminKey == nil || *cleared.AdminKey != "" {
		t.Fatalf("adminKey = %v, want an explicit empty string", cleared.AdminKey)
	}
	if !cleared.Balance.Set || cleared.Balance.Value != nil || !cleared.AlertBelow.Set || cleared.AlertBelow.Value != nil {
		t.Fatalf("null fields were not kept as clears: %+v", cleared.UsagePatch)
	}
	var set struct {
		ID string `json:"id"`
		UsagePatch
	}
	if err := json.Unmarshal([]byte(`{"id":"a","balance":12.5}`), &set); err != nil {
		t.Fatal(err)
	}
	if !set.Balance.Set || set.Balance.Value == nil || *set.Balance.Value != 12.5 {
		t.Fatalf("balance = %+v", set.Balance)
	}
}

func TestOpenAIUsageSumsBucketsAndFollowsPages(t *testing.T) {
	clock := time.Date(2026, 11, 15, 12, 0, 0, 0, time.UTC)
	k := fixedKernel(t, &clock, nil)
	monthStart := utcMonthStart(clock)
	pages := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer admin-secret" {
			t.Errorf("Authorization = %q", got)
		}
		q := r.URL.Query()
		if got := q.Get("start_time"); got != strconv.FormatInt(monthStart.Unix(), 10) {
			t.Errorf("start_time = %s, want %d", got, monthStart.Unix())
		}
		if got := q.Get("end_time"); got != strconv.FormatInt(clock.Unix(), 10) {
			t.Errorf("end_time = %s, want %d", got, clock.Unix())
		}
		if q.Get("bucket_width") != "1d" || q.Get("limit") != "31" {
			t.Errorf("query = %v", q)
		}
		pages++
		switch q.Get("page") {
		case "":
			io.WriteString(w, `{"data":[{"results":[{"amount":{"value":1.25,"currency":"usd"}},{"amount":{"value":1,"currency":"usd"}}]}],"has_more":true,"next_page":"p2"}`)
		case "p2":
			io.WriteString(w, `{"data":[{"results":[{"amount":{"value":1.5,"currency":"usd"}}]}],"has_more":false,"next_page":null}`)
		default:
			t.Errorf("unexpected page %q", q.Get("page"))
		}
	}))
	defer server.Close()
	withOpenAICosts(t, server.URL+"/costs")

	addUsageAccount(t, k, "acct-openai", "openai", "", "")
	key := "admin-secret"
	if _, err := k.SetAccountUsage("acct-openai", UsagePatch{AdminKey: &key}); err != nil {
		t.Fatal(err)
	}
	a, err := k.QueryAccountUsage("acct-openai")
	if err != nil {
		t.Fatal(err)
	}
	if a.Usage == nil || !a.Usage.Supported || a.Usage.Provider != "openai" {
		t.Fatalf("usage = %+v", a.Usage)
	}
	near(t, a.Usage.SpentMonth, 3.75, "spentMonth")
	if pages != 2 {
		t.Fatalf("read %d pages, want 2", pages)
	}
	if a.Usage.CheckedAt != clock.UnixMilli() || a.Usage.Error != "" {
		t.Fatalf("usage = %+v", a.Usage)
	}
}

func TestAnthropicUsageReadsCentAmountsAndFollowsPages(t *testing.T) {
	clock := time.Date(2026, 11, 15, 12, 0, 0, 0, time.UTC)
	k := fixedKernel(t, &clock, nil)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("x-api-key"); got != "admin-secret" {
			t.Errorf("x-api-key = %q", got)
		}
		if got := r.Header.Get("anthropic-version"); got != "2023-06-01" {
			t.Errorf("anthropic-version = %q", got)
		}
		q := r.URL.Query()
		if got := q.Get("starting_at"); got != "2026-11-01T00:00:00Z" {
			t.Errorf("starting_at = %q", got)
		}
		if got := q.Get("ending_at"); got != "2026-11-15T12:00:00Z" {
			t.Errorf("ending_at = %q", got)
		}
		switch q.Get("page") {
		case "":
			io.WriteString(w, `{"data":[{"results":[{"amount":"150.5"}]}],"has_more":true,"next_page":"next"}`)
		case "next":
			io.WriteString(w, `{"data":[{"results":[{"amount":"49.5"}]}],"has_more":false,"next_page":null}`)
		default:
			t.Errorf("unexpected page %q", q.Get("page"))
		}
	}))
	defer server.Close()
	withAnthropicCosts(t, server.URL+"/cost_report")

	addUsageAccount(t, k, "acct-anthropic", "anthropic", "", "")
	key := "admin-secret"
	if _, err := k.SetAccountUsage("acct-anthropic", UsagePatch{AdminKey: &key}); err != nil {
		t.Fatal(err)
	}
	a, err := k.QueryAccountUsage("acct-anthropic")
	if err != nil {
		t.Fatal(err)
	}
	if a.Usage == nil || a.Usage.Provider != "anthropic" {
		t.Fatalf("usage = %+v", a.Usage)
	}
	near(t, a.Usage.SpentMonth, 2.00, "spentMonth")
}

func TestBalanceBaselineKeepsEarlierSameDaySpendOutOfTheEstimate(t *testing.T) {
	recorded := time.Date(2026, 11, 15, 10, 0, 0, 0, time.UTC)
	clock := recorded
	k := fixedKernel(t, &clock, nil)
	dayStart := utcDayStart(recorded)
	monthStart := utcMonthStart(recorded)
	var baselineCalls, dayCalls, monthCalls int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		switch q.Get("start_time") {
		case strconv.FormatInt(monthStart.Unix(), 10):
			monthCalls++
			io.WriteString(w, `{"data":[{"results":[{"amount":{"value":9,"currency":"usd"}}]}],"has_more":false}`)
		case strconv.FormatInt(dayStart.Unix(), 10):
			if q.Get("end_time") == strconv.FormatInt(recorded.Unix(), 10) {
				baselineCalls++
				io.WriteString(w, `{"data":[{"results":[{"amount":{"value":5,"currency":"usd"}}]}],"has_more":false}`)
			} else {
				dayCalls++
				io.WriteString(w, `{"data":[{"results":[{"amount":{"value":8,"currency":"usd"}}]}],"has_more":false}`)
			}
		default:
			t.Errorf("unexpected start_time %q", q.Get("start_time"))
		}
	}))
	defer server.Close()
	withOpenAICosts(t, server.URL+"/costs")

	addUsageAccount(t, k, "acct-balance", "openai", "", "")
	key := "admin-secret"
	balance := 50.0
	a, err := k.SetAccountUsage("acct-balance", UsagePatch{AdminKey: &key, Balance: OptionalFloat{Set: true, Value: &balance}})
	if err != nil {
		t.Fatal(err)
	}
	if baselineCalls != 1 {
		t.Fatalf("baseline queried %d times, want 1", baselineCalls)
	}
	near(t, a.Usage.Balance, 50, "balance")
	near(t, a.Usage.Remaining, 50, "remaining right after recording")

	clock = time.Date(2026, 11, 15, 12, 0, 0, 0, time.UTC)
	a, err = k.QueryAccountUsage("acct-balance")
	if err != nil {
		t.Fatal(err)
	}
	if monthCalls != 1 || dayCalls != 1 {
		t.Fatalf("queries: month=%d day=%d, want 1 and 1", monthCalls, dayCalls)
	}
	near(t, a.Usage.SpentMonth, 9, "spentMonth")
	near(t, a.Usage.Remaining, 47, "remaining")
	if a.Usage.Low {
		t.Fatalf("low before the alert line is set: %+v", a.Usage)
	}

	alert := 48.0
	a, err = k.SetAccountUsage("acct-balance", UsagePatch{AlertBelow: OptionalFloat{Set: true, Value: &alert}})
	if err != nil {
		t.Fatal(err)
	}
	near(t, a.Usage.Remaining, 47, "remaining")
	if !a.Usage.Low {
		t.Fatalf("remaining 47 below alert 48 must be low: %+v", a.Usage)
	}
	// Low only marks the data: the account stays ready and is not paused.
	if !a.Ready || a.PausedUntil != 0 {
		t.Fatalf("low usage changed dispatch state: ready=%v paused=%d", a.Ready, a.PausedUntil)
	}
}

func TestUsageFailureKeepsTheVendorsOwnMessageAndTheAccountReady(t *testing.T) {
	clock := time.Date(2026, 11, 15, 12, 0, 0, 0, time.UTC)
	var logs bytes.Buffer
	k := fixedKernel(t, &clock, &logs)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		io.WriteString(w, `{"type":"error","error":{"type":"authentication_error","message":"The Admin API requires an Admin API key or an organization-scoped API key."}}`)
	}))
	defer server.Close()
	withAnthropicCosts(t, server.URL+"/cost_report")

	addUsageAccount(t, k, "acct-fail", "anthropic", "", "")
	key := "admin-secret-value"
	if _, err := k.SetAccountUsage("acct-fail", UsagePatch{AdminKey: &key}); err != nil {
		t.Fatal(err)
	}
	a, err := k.QueryAccountUsage("acct-fail")
	if err != nil {
		t.Fatal(err)
	}
	want := "The Admin API requires an Admin API key or an organization-scoped API key."
	if a.Usage.Error != want {
		t.Fatalf("usage.error = %q, want %q", a.Usage.Error, want)
	}
	if !a.Ready {
		t.Fatal("a usage failure changed ready")
	}
	if strings.Contains(logs.String(), key) {
		t.Fatalf("the admin key reached the log: %s", logs.String())
	}
	accounts, err := k.Accounts()
	if err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(accounts)
	if strings.Contains(string(body), key) || !strings.Contains(string(body), `"hasAdminKey":true`) {
		t.Fatalf("account list leaked or lost the admin key: %s", body)
	}
}

func TestUnsupportedChannelsRefuseUsageConfiguration(t *testing.T) {
	clock := time.Date(2026, 11, 15, 12, 0, 0, 0, time.UTC)
	k := fixedKernel(t, &clock, nil)
	for _, tc := range []struct {
		id, provider, base string
	}{
		{"acct-deepseek", "deepseek-official", ""},
		{"acct-relay", "openai", "https://relay.example/v1"},
	} {
		addUsageAccount(t, k, tc.id, tc.provider, tc.base, "")
	}
	if _, err := k.AddAccount(AccountInput{ID: "acct-sub", Engine: "codex", Kind: "subscription"}); err != nil {
		t.Fatal(err)
	}
	key := "admin-secret"
	for _, id := range []string{"acct-deepseek", "acct-relay", "acct-sub"} {
		_, err := k.SetAccountUsage(id, UsagePatch{AdminKey: &key})
		if got := AsError(err); got.Code != "INVALID" || got.Message != unsupportedUsage {
			t.Errorf("%s: err = %v, want INVALID %q", id, err, unsupportedUsage)
		}
	}
}

func TestUsageSchedulerQueriesOnlyAccountsThatHaveAKey(t *testing.T) {
	clock := time.Date(2026, 11, 15, 12, 0, 0, 0, time.UTC)
	k := fixedKernel(t, &clock, nil)
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		io.WriteString(w, `{"data":[{"results":[{"amount":{"value":1,"currency":"usd"}}]}],"has_more":false}`)
	}))
	defer server.Close()
	withOpenAICosts(t, server.URL+"/costs")

	addUsageAccount(t, k, "acct-scheduled", "openai", "", "")
	addUsageAccount(t, k, "acct-manual", "openai", "", "")
	key := "admin-secret"
	interval := 1
	if _, err := k.SetAccountUsage("acct-scheduled", UsagePatch{AdminKey: &key, Interval: &interval}); err != nil {
		t.Fatal(err)
	}
	if _, err := k.SetAccountUsage("acct-manual", UsagePatch{Interval: &interval}); err != nil {
		t.Fatal(err)
	}
	k.scheduleUsage()
	deadline := time.Now().Add(3 * time.Second)
	for {
		a, _ := k.Account("acct-scheduled")
		if a.Usage != nil && a.Usage.SpentMonth != nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the scheduler did not query the account with an admin key")
		}
		time.Sleep(10 * time.Millisecond)
	}
	time.Sleep(50 * time.Millisecond)
	if got := calls.Load(); got != 1 {
		t.Fatalf("queried %d accounts, want only the one with an admin key", got)
	}
	a, _ := k.Account("acct-manual")
	if a.Usage != nil {
		t.Fatalf("the unconfigured account gained usage data: %+v", a.Usage)
	}
}

func TestBalancedAccountWithoutAdminKeyStillShowsTheBalance(t *testing.T) {
	clock := time.Date(2026, 11, 15, 12, 0, 0, 0, time.UTC)
	k := fixedKernel(t, &clock, nil)
	addUsageAccount(t, k, "acct-nokey", "openai", "", "")
	balance := 12.5
	a, err := k.SetAccountUsage("acct-nokey", UsagePatch{Balance: OptionalFloat{Set: true, Value: &balance}})
	if err != nil {
		t.Fatal(err)
	}
	if a.Usage == nil || a.Usage.Error != "还没有配置管理密钥" {
		t.Fatalf("usage = %+v", a.Usage)
	}
	near(t, a.Usage.Balance, 12.5, "balance")
	near(t, a.Usage.Remaining, 12.5, "remaining")
	if a.HasAdminKey {
		t.Fatal("hasAdminKey without a key")
	}
	if _, err := k.QueryAccountUsage("acct-nokey"); AsError(err).Code != "INVALID" {
		t.Fatalf("query without a key: %v", err)
	}
}
