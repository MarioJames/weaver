package kernel

import (
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/MarioJames/weaver/internal/quota"
)

const quotaTestToken = "quota-private-test-token"

var quotaTestNow = time.Date(2026, 11, 15, 12, 0, 0, 0, time.UTC)

func quotaCredential(t *testing.T, dir string, expires time.Time) {
	t.Helper()
	data, err := json.Marshal(map[string]any{"claudeAiOauth": map[string]any{
		"accessToken": quotaTestToken, "refreshToken": "quota-private-refresh-token", "expiresAt": expires.UnixMilli(),
	}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".credentials.json"), data, 0600); err != nil {
		t.Fatal(err)
	}
}
func quotaFixture(t *testing.T, handler http.HandlerFunc) (*fixture, string) {
	t.Helper()
	f := newFixture(t)
	f.k.now = func() time.Time { return quotaTestNow }
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	f.k.quotaClient = &quota.Client{HTTP: server.Client(), ClaudeURL: server.URL}
	dir := t.TempDir()
	quotaCredential(t, dir, quotaTestNow.Add(time.Hour))
	_, err := f.k.AddAccount(AccountInput{ID: "subscription", Label: "订阅", Engine: "claude", Kind: "subscription", AuthDir: dir})
	if err != nil {
		t.Fatal(err)
	}
	score := 5.0
	_, err = f.k.SetWorker(WorkerInput{ID: "sub-worker", Engine: "claude", Model: "sonnet", Intelligence: &score, Accounts: []string{"subscription"}})
	if err != nil {
		t.Fatal(err)
	}
	return f, dir
}
func quotaResponse(w http.ResponseWriter, used float64) {
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprintf(w, `{"five_hour":{"utilization":%g,"resets_at":%q},"seven_day":{"utilization":0,"resets_at":%q},"ignored":%q}`,
		used, quotaTestNow.Add(5*time.Hour).Format(time.RFC3339), quotaTestNow.Add(7*24*time.Hour).Format(time.RFC3339), quotaTestToken)
}
func assertQuotaPrivate(t *testing.T, f *fixture) {
	t.Helper()
	rows, err := f.k.db.Query("SELECT quota || quota_error FROM accounts UNION ALL SELECT message FROM events")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var text string
		if err := rows.Scan(&text); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(text, quotaTestToken) || strings.Contains(text, "quota-private-refresh-token") {
			t.Fatal("credential leaked into persisted quota or events")
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	accounts, err := f.k.Accounts()
	if err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(accounts)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), quotaTestToken) {
		t.Fatal("credential leaked into account output")
	}
}
func TestRefreshQuotaSuccessUnsupportedAndPrivacy(t *testing.T) {
	f, _ := quotaFixture(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+quotaTestToken {
			t.Error("missing bearer")
		}
		quotaResponse(w, 70)
	})
	a, err := f.k.RefreshQuota("subscription")
	if err != nil {
		t.Fatal(err)
	}
	if a.Quota == nil || len(a.Quota.Windows) != 2 || a.Quota.CheckedAt != quotaTestNow.UnixMilli() ||
		math.Abs(a.Quota.Factor-0.3) > 1e-9 || a.Quota.Error != "" {
		t.Fatalf("unexpected view: %+v", a.Quota)
	}
	for _, id := range []string{"acct-alpha", "dsh-sub"} {
		if id == "dsh-sub" {
			if _, err := f.k.AddAccount(AccountInput{ID: id, Engine: "dsh", Kind: "subscription"}); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := f.k.RefreshQuota(id); err == nil || AsError(err).Code != "UNSUPPORTED" ||
			AsError(err).Message != "只有 Codex、Claude、OpenCode 的订阅账号有额度窗口" {
			t.Fatalf("unsupported %s: %v", id, err)
		}
	}
	if _, err := f.k.RefreshQuota("missing"); err == nil || AsError(err).Code != "NOT_FOUND" {
		t.Fatal(err)
	}
	assertQuotaPrivate(t, f)
}
func TestRefreshQuotaRenewalPreservesSnapshotAndRouting(t *testing.T) {
	f, dir := quotaFixture(t, func(w http.ResponseWriter, r *http.Request) { quotaResponse(w, 70) })
	before, err := f.k.RefreshQuota("subscription")
	if err != nil {
		t.Fatal(err)
	}
	quotaCredential(t, dir, quotaTestNow.Add(-time.Minute))
	f.k.now = func() time.Time { return quotaTestNow.Add(time.Minute) }
	after, err := f.k.RefreshQuota("subscription")
	if err != nil {
		t.Fatal(err)
	}
	if after.Quota.CheckedAt != before.Quota.CheckedAt || len(after.Quota.Windows) != 2 ||
		after.Quota.Error != "访问令牌已到期，等待引擎下次运行续期" {
		t.Fatalf("%+v", after.Quota)
	}
	m := f.mission()
	p := pkg("renewal")
	p.Worker = "sub-worker"
	id := f.submit(m, p)["renewal"]
	if got := f.state(id); got != StateLaunch {
		t.Fatal(got)
	}
	assertQuotaPrivate(t, f)
}
func TestQuotaProbeFailuresDoNotBlockDispatch(t *testing.T) {
	for _, kind := range []string{"401", "timeout"} {
		t.Run(kind, func(t *testing.T) {
			release := make(chan struct{})
			f, _ := quotaFixture(t, func(w http.ResponseWriter, r *http.Request) {
				if kind == "timeout" {
					<-release
				}
				w.WriteHeader(http.StatusUnauthorized)
				fmt.Fprint(w, quotaTestToken)
			})
			if kind == "timeout" {
				f.k.quotaClient.HTTP.Timeout = 10 * time.Millisecond
			}
			a, err := f.k.RefreshQuota("subscription")
			close(release)
			if err != nil {
				t.Fatal(err)
			}
			if kind == "timeout" && !strings.Contains(a.Quota.Error, "超时") {
				t.Fatal(a.Quota.Error)
			}
			if a.Quota.Error == "" || a.Quota.Factor != 1 || a.Quota.CheckedAt != 0 {
				t.Fatalf("%+v", a.Quota)
			}
			m := f.mission()
			p := pkg("failure")
			p.Worker = "sub-worker"
			id := f.submit(m, p)["failure"]
			if got := f.state(id); got != StateLaunch {
				t.Fatal(got)
			}
			assertQuotaPrivate(t, f)
		})
	}
}
func TestQuotaExhaustionPendingFallbackAndReset(t *testing.T) {
	f, _ := quotaFixture(t, func(w http.ResponseWriter, r *http.Request) { quotaResponse(w, 100) })
	if _, err := f.k.RefreshQuota("subscription"); err != nil {
		t.Fatal(err)
	}
	m := f.mission()
	p := pkg("blocked")
	p.Worker = "sub-worker"
	id := f.submit(m, p)["blocked"]
	blocked, err := f.k.Package(id)
	if err != nil {
		t.Fatal(err)
	}
	if blocked.State != StatePending || !strings.Contains(blocked.Waiting, "额度已用完") || !strings.Contains(blocked.Waiting, "重置") {
		t.Fatalf("%+v", blocked)
	}
	// A refresh failure after the known reset still permits dispatch using the old snapshot.
	f.k.now = func() time.Time { return quotaTestNow.Add(6 * time.Hour) }
	if _, err := f.k.RefreshQuotas("subscription"); err != nil {
		t.Fatal(err)
	}
	if got := f.state(id); got != StateLaunch {
		t.Fatal(got)
	}

	f2, _ := quotaFixture(t, func(w http.ResponseWriter, r *http.Request) { quotaResponse(w, 100) })
	if _, err := f2.k.RefreshQuota("subscription"); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	quotaCredential(t, dir, quotaTestNow.Add(time.Hour))
	if _, err := f2.k.AddAccount(AccountInput{ID: "second", Engine: "claude", Kind: "subscription", AuthDir: dir}); err != nil {
		t.Fatal(err)
	}
	accounts := []string{"subscription", "second"}
	if _, err := f2.k.SetWorker(WorkerInput{ID: "sub-worker", Accounts: accounts}); err != nil {
		t.Fatal(err)
	}
	m2 := f2.mission()
	p2 := pkg("fallback")
	p2.Worker = "sub-worker"
	f2.submit(m2, p2)
	runs := f2.eng.runs()
	if len(runs) != 1 || runs[0].Account.ID != "second" {
		t.Fatalf("%+v", runs)
	}
	assertQuotaPrivate(t, f2)
}
func TestQuotaModelIsolationAndScoring(t *testing.T) {
	now := quotaTestNow
	snap := &quota.Snapshot{Status: "available", Windows: []quota.Window{{Scope: "model", Model: "sonnet", UsedPercent: 100, ResetsAt: now.Add(time.Hour).UnixMilli(), DurationMinutes: 60}}}
	a := candidate("sonnet", 8, 8, 600, 1)
	b := candidate("opus", 8, 8, 600, 1)
	a.Model, b.Model = "claude-sonnet-4", "claude-opus-4"
	shared := a.Accounts[0]
	shared.Snapshot = snap
	a.Accounts, b.Accounts = []*routeAccount{shared}, []*routeAccount{shared}
	r := &routing{Workers: []*routeWorker{a, b}, Now: now}
	chosen, _, _ := r.pick("", "", 7)
	if chosen != b {
		t.Fatal("model window affected other candidate")
	}
	if w, _, why := r.pick("sonnet", "", 7); w != nil || !strings.Contains(why, "额度已用完") {
		t.Fatal(why)
	}
	snap.Windows[0].UsedPercent = 70
	// A shared account's model-specific factor must not overwrite the other route.
	r = &routing{Workers: []*routeWorker{a, b}, Now: now}
	a.Running, b.Running = 0, 0
	chosen, _, note := r.pick("", "", 7)
	if chosen != b || !strings.Contains(note, "额度系数 1.00") {
		t.Fatal(note)
	}
	if quotaView("{broken", 0, "", now).Factor != 1 {
		t.Fatal("malformed cache blocked routing")
	}
}
func TestQuotaRefreshBatchContinuesAndFilters(t *testing.T) {
	f, _ := quotaFixture(t, func(w http.ResponseWriter, r *http.Request) { quotaResponse(w, 25) })
	dir := t.TempDir()
	if _, err := f.k.AddAccount(AccountInput{ID: "bad", Engine: "claude", Kind: "subscription", AuthDir: dir}); err != nil {
		t.Fatal(err)
	}
	accounts, err := f.k.RefreshQuotas("")
	if err != nil {
		t.Fatal(err)
	}
	if len(accounts) != 2 {
		t.Fatalf("got %d accounts", len(accounts))
	}
	for _, a := range accounts {
		if a.ID == "subscription" && a.Quota.CheckedAt == 0 {
			t.Fatal("good account skipped")
		}
		if a.ID == "bad" && a.Quota.Error == "" {
			t.Fatal("bad account did not record error")
		}
	}
	assertQuotaPrivate(t, f)
}

func TestQuotaRefreshIntervalIsConfigurable(t *testing.T) {
	f := newFixture(t)
	if got := f.k.quotaInterval(); got != 5*time.Minute {
		t.Fatalf("default interval = %s, want 5m", got)
	}
	for _, bad := range []string{"0", "-1", "abc", "1.5", "1441"} {
		if err := f.k.SetSetting("quota_refresh_minutes", bad); err == nil {
			t.Fatalf("quota_refresh_minutes=%q accepted", bad)
		}
	}
	if err := f.k.SetSetting("quota_refresh_minutes", "30"); err != nil {
		t.Fatal(err)
	}
	if got := f.k.quotaInterval(); got != 30*time.Minute {
		t.Fatalf("interval = %s, want 30m", got)
	}
}
