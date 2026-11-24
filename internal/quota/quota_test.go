package quota

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

var testNow = time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC)

func testJWT(expires time.Time) string {
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none"}`))
	claims := base64.RawURLEncoding.EncodeToString([]byte(fmt.Sprintf(`{"exp":%d}`, expires.Unix())))
	return header + "." + claims + ".signature"
}

func writeJSONFile(t *testing.T, path string, value any) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	body, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, body, 0o600); err != nil {
		t.Fatal(err)
	}
}

func writeCodexCredential(t *testing.T, dir, token, accountID string, refresh bool) {
	t.Helper()
	tokens := map[string]any{"access_token": token, "account_id": accountID}
	if refresh {
		tokens["refresh_token"] = "refresh-secret"
	}
	writeJSONFile(t, filepath.Join(dir, "auth.json"), map[string]any{"auth_mode": "chatgpt", "tokens": tokens})
}

func writeClaudeCredential(t *testing.T, dir, token string, expiresAt int64, refresh bool) {
	t.Helper()
	oauth := map[string]any{"accessToken": token, "expiresAt": expiresAt}
	if refresh {
		oauth["refreshToken"] = "refresh-secret"
	}
	writeJSONFile(t, filepath.Join(dir, ".credentials.json"), map[string]any{"claudeAiOauth": oauth})
}

func writeOpenCodeKey(t *testing.T, dir, key string) {
	t.Helper()
	writeJSONFile(t, filepath.Join(dir, "data", "opencode", "auth.json"), map[string]any{
		"opencode-go": map[string]any{"type": "api", "key": key},
	})
}

func jsonHandler(t *testing.T, body any) (*httptest.Server, <-chan http.Header) {
	t.Helper()
	headers := make(chan http.Header, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		headers <- r.Header.Clone()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(body)
	}))
	t.Cleanup(server.Close)
	return server, headers
}

func errKind(t *testing.T, err error) string {
	t.Helper()
	quotaErr, ok := err.(*Error)
	if !ok {
		t.Fatalf("error type = %T, want *quota.Error", err)
	}
	return quotaErr.Kind
}

type offlineTransport struct{ calls int }

func (o *offlineTransport) RoundTrip(*http.Request) (*http.Response, error) {
	o.calls++
	return nil, fmt.Errorf("test network disabled")
}

// offlineClient fails the test if credential validation lets any HTTP request
// through. Tests that do exercise HTTP use httptest instead.
func offlineClient() (*Client, *offlineTransport) {
	transport := &offlineTransport{}
	return &Client{HTTP: &http.Client{Transport: transport}}, transport
}

func TestCodexSnapshotAndHeaders(t *testing.T) {
	dir := t.TempDir()
	token := testJWT(testNow.Add(24 * time.Hour))
	writeCodexCredential(t, dir, token, "acct-secret", true)
	reset := testNow.Add(5 * time.Hour).Unix()
	body := map[string]any{
		"rate_limit": map[string]any{
			"allowed":        true,
			"limit_reached":  false,
			"primary_window": map[string]any{"used_percent": 25.0, "reset_at": float64(reset), "limit_window_seconds": 18000.0},
			"secondary_window": map[string]any{
				"used_percent": 60.0, "reset_at": float64(testNow.Add(7 * 24 * time.Hour).Unix()), "limit_window_seconds": 604800.0,
			},
		},
		"email": "private@example.invalid",
	}
	server, headers := jsonHandler(t, body)
	client := &Client{HTTP: server.Client(), CodexURL: server.URL}
	snapshot, err := client.Fetch(context.Background(), Source{Engine: "codex", AuthDir: dir}, testNow)
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	header := <-headers
	if got := header.Get("Authorization"); got != "Bearer "+token {
		t.Errorf("Authorization = %q", got)
	}
	if got := header.Get("ChatGPT-Account-Id"); got != "acct-secret" {
		t.Errorf("ChatGPT-Account-Id = %q", got)
	}
	if got := header.Get("User-Agent"); got != "codex-cli" {
		t.Errorf("User-Agent = %q", got)
	}
	if got := header.Get("Accept"); got != "application/json" {
		t.Errorf("Accept = %q", got)
	}
	if snapshot.Status != statusAvailable {
		t.Fatalf("status = %q, want available", snapshot.Status)
	}
	if len(snapshot.Windows) != 2 {
		t.Fatalf("windows = %d, want 2", len(snapshot.Windows))
	}
	first, second := snapshot.Windows[0], snapshot.Windows[1]
	if first.ID != "codex:account:primary_window" || first.Label != "5 小时额度" || first.Scope != scopeAccount {
		t.Errorf("first window = %+v", first)
	}
	if first.UsedPercent != 25 || first.ResetsAt != reset*1000 || first.DurationMinutes != 300 {
		t.Errorf("first values = %+v", first)
	}
	if second.ID != "codex:account:secondary_window" || second.Label != "7 天额度" || second.DurationMinutes != 10080 {
		t.Errorf("second window = %+v", second)
	}
	encoded, _ := json.Marshal(snapshot)
	for _, secret := range []string{token, "acct-secret", "private@example.invalid", "refresh-secret"} {
		if strings.Contains(string(encoded), secret) {
			t.Errorf("snapshot leaked %q: %s", secret, encoded)
		}
	}
}

func TestClaudeLimitsAndLegacy(t *testing.T) {
	t.Run("authoritative limits", func(t *testing.T) {
		dir := t.TempDir()
		writeClaudeCredential(t, dir, "secret-claude", testNow.Add(24*time.Hour).UnixMilli(), true)
		body := map[string]any{
			"limits": []any{
				map[string]any{"kind": "session", "percent": 12.0, "resets_at": testNow.Add(2 * time.Hour).Format(time.RFC3339Nano)},
				map[string]any{"kind": "weekly_all", "percent": 40.0, "resets_at": testNow.Add(3 * 24 * time.Hour).Format(time.RFC3339Nano)},
				map[string]any{"kind": "weekly_scoped", "percent": 70.0, "scope": map[string]any{"model": map[string]any{"id": "claude-opus-4"}}},
			},
			"five_hour":   map[string]any{"utilization": 99.0, "resets_at": testNow.Add(time.Hour).Format(time.RFC3339Nano)},
			"extra_usage": map[string]any{"is_enabled": true, "monthly_limit": 2000.0, "used_credits": 600.0},
		}
		server, headers := jsonHandler(t, body)
		client := &Client{HTTP: server.Client(), ClaudeURL: server.URL}
		snapshot, err := client.Fetch(context.Background(), Source{Engine: "claude", AuthDir: dir}, testNow)
		if err != nil {
			t.Fatalf("Fetch: %v", err)
		}
		header := <-headers
		if got := header.Get("Authorization"); got != "Bearer secret-claude" {
			t.Errorf("Authorization = %q", got)
		}
		if got := header.Get("anthropic-beta"); got != "oauth-2025-04-20" {
			t.Errorf("anthropic-beta = %q", got)
		}
		if got := header.Get("Accept"); got != "application/json" {
			t.Errorf("Accept = %q", got)
		}
		if snapshot.Status != statusAvailable || len(snapshot.Windows) != 4 {
			t.Fatalf("snapshot = %+v", snapshot)
		}
		ids := make(map[string]Window)
		for _, window := range snapshot.Windows {
			ids[window.ID] = window
		}
		for _, missing := range []string{"claude:five_hour", "claude:seven_day"} {
			if _, ok := ids[missing]; ok {
				t.Errorf("legacy window %q must not be used when limits is authoritative", missing)
			}
		}
		if got := ids["claude:session:0"]; got.Label != "5 小时额度" || got.DurationMinutes != 300 || got.UsedPercent != 12 {
			t.Errorf("session window = %+v", got)
		}
		if got := ids["claude:weekly_scoped:claude-opus-4"]; got.Scope != scopeModel || got.Model != "claude-opus-4" || got.DurationMinutes != 10080 {
			t.Errorf("model window = %+v", got)
		}
		if got := ids["claude:extra_usage:monthly"]; got.Label != "月度额度" || got.UsedPercent != 30 || got.Scope != scopeAccount {
			t.Errorf("extra usage window = %+v", got)
		}
	})

	t.Run("legacy windows", func(t *testing.T) {
		dir := t.TempDir()
		writeClaudeCredential(t, dir, "secret-claude", testNow.Add(24*time.Hour).UnixMilli(), false)
		body := map[string]any{
			"five_hour":        map[string]any{"utilization": 15.0, "resets_at": testNow.Add(2 * time.Hour).Format(time.RFC3339Nano)},
			"seven_day":        map[string]any{"utilization": 20.0, "resets_at": testNow.Add(3 * 24 * time.Hour).Format(time.RFC3339Nano)},
			"seven_day_sonnet": map[string]any{"utilization": 5.0, "resets_at": testNow.Add(3 * 24 * time.Hour).Format(time.RFC3339Nano)},
			"extra_usage":      map[string]any{"is_enabled": false, "monthly_limit": 2000.0, "used_credits": 2000.0},
		}
		server, _ := jsonHandler(t, body)
		client := &Client{HTTP: server.Client(), ClaudeURL: server.URL}
		snapshot, err := client.Fetch(context.Background(), Source{Engine: "claude", AuthDir: dir}, testNow)
		if err != nil {
			t.Fatalf("Fetch: %v", err)
		}
		if snapshot.Status != statusAvailable || len(snapshot.Windows) != 3 {
			t.Fatalf("snapshot = %+v", snapshot)
		}
		if got := snapshot.Windows[0]; got.ID != "claude:five_hour" || got.Label != "5 小时额度" || got.DurationMinutes != 300 {
			t.Errorf("five hour = %+v", got)
		}
		if got := snapshot.Windows[1]; got.ID != "claude:seven_day" || got.Label != "7 天额度" || got.DurationMinutes != 10080 {
			t.Errorf("seven day = %+v", got)
		}
		if got := snapshot.Windows[2]; got.Scope != scopeModel || got.Model != "sonnet" || got.ID != "claude:seven_day_sonnet" {
			t.Errorf("sonnet = %+v", got)
		}
	})
}

func TestOpenCodeGoKeySnapshotAndHeaders(t *testing.T) {
	dir := t.TempDir()
	writeOpenCodeKey(t, dir, "secret-go")
	body := map[string]any{"usage": map[string]any{
		"rolling": map[string]any{"status": "ok", "percent": 1.0, "resetsAt": testNow.Add(2 * time.Hour).Format(time.RFC3339Nano)},
		"weekly":  map[string]any{"status": "ok", "percent": 25.0, "resetsAt": testNow.Add(3 * 24 * time.Hour).Format(time.RFC3339Nano)},
		"monthly": map[string]any{"status": "ok", "percent": 29.0, "resetsAt": testNow.Add(10 * 24 * time.Hour).Format(time.RFC3339Nano)},
	}}
	headers := make(chan http.Header, 1)
	paths := make(chan string, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		headers <- r.Header.Clone()
		paths <- r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(body)
	}))
	defer server.Close()
	client := &Client{HTTP: server.Client(), OpenCodeGoURL: server.URL + "/zen/go/v1/usage"}
	snapshot, err := client.Fetch(context.Background(), Source{Engine: "opencode", AuthDir: dir}, testNow)
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	if path := <-paths; path != "/zen/go/v1/usage" {
		t.Errorf("path = %q", path)
	}
	header := <-headers
	if got := header.Get("Authorization"); got != "Bearer secret-go" {
		t.Errorf("Authorization = %q", got)
	}
	if got := header.Get("Accept"); got != "application/json" {
		t.Errorf("Accept = %q", got)
	}
	if got := header.Get("ChatGPT-Account-Id"); got != "" {
		t.Errorf("unexpected ChatGPT-Account-Id %q", got)
	}
	if got := header.Get("anthropic-beta"); got != "" {
		t.Errorf("unexpected anthropic-beta %q", got)
	}
	if snapshot.Status != statusAvailable || len(snapshot.Windows) != 3 {
		t.Fatalf("snapshot = %+v", snapshot)
	}
	want := []struct {
		id       string
		label    string
		percent  float64
		duration int
	}{
		{"opencode:rolling", "5 小时额度", 1, 300},
		{"opencode:weekly", "7 天额度", 25, 10080},
		{"opencode:monthly", "每月额度", 29, 43200},
	}
	for index, expected := range want {
		got := snapshot.Windows[index]
		if got.ID != expected.id || got.Label != expected.label || got.UsedPercent != expected.percent || got.DurationMinutes != expected.duration || got.Scope != scopeAccount {
			t.Errorf("window %d = %+v, want %+v", index, got, expected)
		}
	}
}

func TestOpenCodeGoPartialAndExhausted(t *testing.T) {
	dir := t.TempDir()
	writeOpenCodeKey(t, dir, "secret-go")
	t.Run("missing window is unknown", func(t *testing.T) {
		server, _ := jsonHandler(t, map[string]any{"usage": map[string]any{
			"rolling": map[string]any{"status": "ok", "percent": 1.0, "resetsAt": testNow.Add(2 * time.Hour).Format(time.RFC3339Nano)},
			"weekly":  map[string]any{"status": "ok", "percent": 25.0, "resetsAt": testNow.Add(3 * 24 * time.Hour).Format(time.RFC3339Nano)},
		}})
		client := &Client{HTTP: server.Client(), OpenCodeGoURL: server.URL}
		snapshot, err := client.Fetch(context.Background(), Source{Engine: "opencode", AuthDir: dir}, testNow)
		if err != nil {
			t.Fatalf("Fetch: %v", err)
		}
		if snapshot.Status != statusUnknown || len(snapshot.Windows) != 0 {
			t.Fatalf("snapshot = %+v", snapshot)
		}
	})
	t.Run("rate limited is exhausted", func(t *testing.T) {
		server, _ := jsonHandler(t, map[string]any{"usage": map[string]any{
			"rolling": map[string]any{"status": "rate-limited", "percent": 100.0, "resetsAt": testNow.Add(2 * time.Hour).Format(time.RFC3339Nano)},
			"weekly":  map[string]any{"status": "ok", "percent": 25.0, "resetsAt": testNow.Add(3 * 24 * time.Hour).Format(time.RFC3339Nano)},
			"monthly": map[string]any{"status": "ok", "percent": 29.0, "resetsAt": testNow.Add(10 * 24 * time.Hour).Format(time.RFC3339Nano)},
		}})
		client := &Client{HTTP: server.Client(), OpenCodeGoURL: server.URL}
		snapshot, err := client.Fetch(context.Background(), Source{Engine: "opencode", AuthDir: dir}, testNow)
		if err != nil {
			t.Fatalf("Fetch: %v", err)
		}
		if snapshot.Status != statusExhausted || len(snapshot.Windows) != 3 {
			t.Fatalf("snapshot = %+v", snapshot)
		}
	})
}

func TestIncompleteAccountWindowsDoNotBecomeAvailable(t *testing.T) {
	t.Run("codex drops the unparseable window", func(t *testing.T) {
		dir := t.TempDir()
		writeCodexCredential(t, dir, testJWT(testNow.Add(24*time.Hour)), "acct", false)
		server, _ := jsonHandler(t, map[string]any{"rate_limit": map[string]any{
			"allowed":          true,
			"primary_window":   map[string]any{"used_percent": 12.0},
			"secondary_window": map[string]any{"used_percent": nil},
		}})
		client := &Client{HTTP: server.Client(), CodexURL: server.URL}
		snapshot, err := client.Fetch(context.Background(), Source{Engine: "codex", AuthDir: dir}, testNow)
		if err != nil {
			t.Fatalf("Fetch: %v", err)
		}
		if snapshot.Status != statusUnknown || len(snapshot.Windows) != 1 || snapshot.Windows[0].UsedPercent != 12 {
			t.Fatalf("snapshot = %+v", snapshot)
		}
	})

	t.Run("claude keeps only the parseable account window", func(t *testing.T) {
		dir := t.TempDir()
		writeClaudeCredential(t, dir, "secret-claude", testNow.Add(24*time.Hour).UnixMilli(), false)
		server, _ := jsonHandler(t, map[string]any{"limits": []any{
			map[string]any{"kind": "session", "percent": nil},
			map[string]any{"kind": "weekly_all", "percent": 10.0},
		}})
		client := &Client{HTTP: server.Client(), ClaudeURL: server.URL}
		snapshot, err := client.Fetch(context.Background(), Source{Engine: "claude", AuthDir: dir}, testNow)
		if err != nil {
			t.Fatalf("Fetch: %v", err)
		}
		if snapshot.Status != statusUnknown || len(snapshot.Windows) != 1 || snapshot.Windows[0].ID != "claude:weekly_all:1" {
			t.Fatalf("snapshot = %+v", snapshot)
		}
	})

	t.Run("codex server restriction is exhausted", func(t *testing.T) {
		dir := t.TempDir()
		writeCodexCredential(t, dir, testJWT(testNow.Add(24*time.Hour)), "acct", false)
		server, _ := jsonHandler(t, map[string]any{
			"rate_limit":    map[string]any{"allowed": true, "primary_window": map[string]any{"used_percent": 10.0}},
			"spend_control": map[string]any{"reached": true},
		})
		client := &Client{HTTP: server.Client(), CodexURL: server.URL}
		snapshot, err := client.Fetch(context.Background(), Source{Engine: "codex", AuthDir: dir}, testNow)
		if err != nil {
			t.Fatalf("Fetch: %v", err)
		}
		if snapshot.Status != statusExhausted {
			t.Fatalf("status = %q, want exhausted", snapshot.Status)
		}
	})
}

func TestExpiredCredentialsRenewalVersusLogout(t *testing.T) {
	codex := func(t *testing.T, refresh, skipRefresh bool) error {
		dir := t.TempDir()
		writeCodexCredential(t, dir, testJWT(testNow.Add(-time.Second)), "acct", refresh)
		client, transport := offlineClient()
		_, err := client.Fetch(context.Background(), Source{Engine: "codex", AuthDir: dir, SkipRefresh: skipRefresh}, testNow)
		if transport.calls != 0 {
			t.Errorf("expired codex credential made %d HTTP request(s)", transport.calls)
		}
		return err
	}
	claude := func(t *testing.T, refresh, skipRefresh bool) error {
		dir := t.TempDir()
		writeClaudeCredential(t, dir, "secret-claude", testNow.Add(-time.Millisecond).UnixMilli(), refresh)
		client, transport := offlineClient()
		_, err := client.Fetch(context.Background(), Source{Engine: "claude", AuthDir: dir, SkipRefresh: skipRefresh}, testNow)
		if transport.calls != 0 {
			t.Errorf("expired claude credential made %d HTTP request(s)", transport.calls)
		}
		return err
	}
	for _, tc := range []struct {
		name        string
		renew       func(*testing.T, bool, bool) error
		refresh     bool
		skipRefresh bool
		want        string
	}{
		{"codex renewable skipped", codex, true, true, kindRenewalPending},
		{"codex expired without refresh token", codex, false, false, kindUnauthenticated},
		{"claude renewable skipped", claude, true, true, kindRenewalPending},
		{"claude expired without refresh token", claude, false, false, kindUnauthenticated},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.renew(t, tc.refresh, tc.skipRefresh)
			if err == nil {
				t.Fatal("expected an error")
			}
			if got := errKind(t, err); got != tc.want {
				t.Fatalf("kind = %q, want %q (%v)", got, tc.want, err)
			}
			for _, secret := range []string{"secret-claude", "refresh-secret", "signature"} {
				if strings.Contains(err.Error(), secret) {
					t.Errorf("error leaked %q: %v", secret, err)
				}
			}
		})
	}
}

func TestHTTPFailures(t *testing.T) {
	dir := t.TempDir()
	token := testJWT(testNow.Add(24 * time.Hour))
	writeCodexCredential(t, dir, token, "acct-secret", false)
	tests := []struct {
		name        string
		status      int
		contentType string
		body        string
		wantKind    string
	}{
		{"401", http.StatusUnauthorized, "application/json", `{}`, kindUnauthenticated},
		{"429", http.StatusTooManyRequests, "application/json", `{}`, kindTransient},
		{"500", http.StatusInternalServerError, "text/plain", token, kindTransient},
		{"not json", http.StatusOK, "text/html", "not json", kindUpstream},
		{"invalid json", http.StatusOK, "application/json", `{invalid`, kindUpstream},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", tc.contentType)
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer server.Close()
			client := &Client{HTTP: server.Client(), CodexURL: server.URL}
			_, err := client.Fetch(context.Background(), Source{Engine: "codex", AuthDir: dir}, testNow)
			if err == nil {
				t.Fatal("expected an error")
			}
			if got := errKind(t, err); got != tc.wantKind {
				t.Fatalf("kind = %q, want %q (%v)", got, tc.wantKind, err)
			}
			if strings.Contains(err.Error(), token) {
				t.Errorf("error leaked the token: %v", err)
			}
		})
	}
}

func TestNonObjectResponseIsUnknown(t *testing.T) {
	dir := t.TempDir()
	writeCodexCredential(t, dir, testJWT(testNow.Add(24*time.Hour)), "acct", false)
	server, _ := jsonHandler(t, []any{1, 2, 3})
	client := &Client{HTTP: server.Client(), CodexURL: server.URL}
	snapshot, err := client.Fetch(context.Background(), Source{Engine: "codex", AuthDir: dir}, testNow)
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	if snapshot.Status != statusUnknown || len(snapshot.Windows) != 0 {
		t.Fatalf("snapshot = %+v", snapshot)
	}
}

func TestCredentialFileFailures(t *testing.T) {
	t.Run("missing files", func(t *testing.T) {
		empty := t.TempDir()
		cases := []struct {
			engine string
			want   string
		}{
			{"codex", kindUnauthenticated},
			{"claude", kindUnauthenticated},
			{"opencode", kindUnsupported},
			{"other", kindUnsupported},
		}
		for _, tc := range cases {
			client, transport := offlineClient()
			_, err := client.Fetch(context.Background(), Source{Engine: tc.engine, AuthDir: empty}, testNow)
			if err == nil {
				t.Fatalf("%s: expected an error", tc.engine)
			}
			if got := errKind(t, err); got != tc.want {
				t.Errorf("%s: kind = %q, want %q", tc.engine, got, tc.want)
			}
			if transport.calls != 0 {
				t.Errorf("%s: made %d HTTP request(s)", tc.engine, transport.calls)
			}
		}
	})

	t.Run("symlink is rejected without a request", func(t *testing.T) {
		root := t.TempDir()
		target := filepath.Join(root, "target.json")
		writeJSONFile(t, target, map[string]any{
			"auth_mode": "chatgpt",
			"tokens":    map[string]any{"access_token": testJWT(testNow.Add(time.Hour)), "account_id": "acct"},
		})
		dir := filepath.Join(root, "codex")
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(target, filepath.Join(dir, "auth.json")); err != nil {
			t.Fatal(err)
		}
		requests := 0
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			requests++
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{}`))
		}))
		defer server.Close()
		client := &Client{HTTP: server.Client(), CodexURL: server.URL}
		_, err := client.Fetch(context.Background(), Source{Engine: "codex", AuthDir: dir}, testNow)
		if err == nil || errKind(t, err) != kindUnsupported {
			t.Fatalf("error = %v, want unsupported", err)
		}
		if requests != 0 {
			t.Errorf("requests = %d, want 0", requests)
		}
	})

	t.Run("oversized and malformed files", func(t *testing.T) {
		for name, content := range map[string]string{
			"oversized": strings.Repeat(" ", maxCredentialBytes+1),
			"malformed": "{not json",
		} {
			t.Run(name, func(t *testing.T) {
				dir := t.TempDir()
				if err := os.WriteFile(filepath.Join(dir, "auth.json"), []byte(content), 0o600); err != nil {
					t.Fatal(err)
				}
				client, transport := offlineClient()
				_, err := client.Fetch(context.Background(), Source{Engine: "codex", AuthDir: dir}, testNow)
				if err == nil || errKind(t, err) != kindUnsupported {
					t.Fatalf("error = %v, want unsupported", err)
				}
				if transport.calls != 0 {
					t.Errorf("made %d HTTP request(s)", transport.calls)
				}
			})
		}
	})

	t.Run("relative auth directory", func(t *testing.T) {
		client, transport := offlineClient()
		_, err := client.Fetch(context.Background(), Source{Engine: "codex", AuthDir: "relative"}, testNow)
		if err == nil || errKind(t, err) != kindUnsupported {
			t.Fatalf("error = %v, want unsupported", err)
		}
		if transport.calls != 0 {
			t.Errorf("made %d HTTP request(s)", transport.calls)
		}
	})
}

func TestCodexRedactsEchoedCredential(t *testing.T) {
	dir := t.TempDir()
	const accountID = "acct-secret"
	writeCodexCredential(t, dir, testJWT(testNow.Add(24*time.Hour)), accountID, false)
	body := map[string]any{
		"rate_limit": map[string]any{
			"allowed":        true,
			"primary_window": map[string]any{"used_percent": 10.0},
		},
		"additional_rate_limits": []any{
			map[string]any{"normal_model_slug": accountID, "rate_limit": map[string]any{
				"primary_window": map[string]any{"used_percent": 30.0},
			}},
		},
	}
	server, _ := jsonHandler(t, body)
	client := &Client{HTTP: server.Client(), CodexURL: server.URL}
	snapshot, err := client.Fetch(context.Background(), Source{Engine: "codex", AuthDir: dir}, testNow)
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	encoded, _ := json.Marshal(snapshot)
	if strings.Contains(string(encoded), accountID) {
		t.Fatalf("snapshot leaked the account id: %s", encoded)
	}
	if len(snapshot.Windows) != 2 {
		t.Fatalf("windows = %+v", snapshot.Windows)
	}
	modelWindow := snapshot.Windows[1]
	if modelWindow.Scope != scopeUnknown || modelWindow.Model != "" || !strings.Contains(modelWindow.ID, "redacted") {
		t.Errorf("redacted window = %+v", modelWindow)
	}
}

func TestOpenCodeEntitlementError(t *testing.T) {
	dir := t.TempDir()
	writeOpenCodeKey(t, dir, "secret-go")
	for _, tc := range []struct {
		name   string
		body   string
		status int
		want   string
	}{
		{"entitlement", `{"error":{"type":"EntitlementError","message":"secret"}}`, http.StatusForbidden, kindUnsupported},
		{"other 403", `{"error":{"type":"OtherError"}}`, http.StatusForbidden, kindUpstream},
		{"401", `{}`, http.StatusUnauthorized, kindUnauthenticated},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer server.Close()
			client := &Client{HTTP: server.Client(), OpenCodeGoURL: server.URL}
			_, err := client.Fetch(context.Background(), Source{Engine: "opencode", AuthDir: dir}, testNow)
			if err == nil {
				t.Fatal("expected an error")
			}
			if got := errKind(t, err); got != tc.want {
				t.Fatalf("kind = %q, want %q (%v)", got, tc.want, err)
			}
			if strings.Contains(err.Error(), "secret") {
				t.Errorf("error leaked the response body: %v", err)
			}
		})
	}
}

func TestDefaultEndpoints(t *testing.T) {
	client := &Client{}
	if got := client.codexURL(); got != "https://chatgpt.com/backend-api/wham/usage" {
		t.Errorf("codex URL = %q", got)
	}
	if got := client.codexTokenURL(); got != "https://auth.openai.com/oauth/token" {
		t.Errorf("codex token URL = %q", got)
	}
	if got := client.claudeURL(); got != "https://api.anthropic.com/api/oauth/usage" {
		t.Errorf("claude URL = %q", got)
	}
	if got := client.claudeTokenURL(); got != "https://platform.claude.com/v1/oauth/token" {
		t.Errorf("claude token URL = %q", got)
	}
	if got := client.openCodeGoURL(); got != "https://opencode.ai/zen/go/v1/usage" {
		t.Errorf("opencode Go URL = %q", got)
	}
	if got := client.openCodeConsoleURL(); got != "https://opencode.ai/console/api/go/status" {
		t.Errorf("opencode Console URL = %q", got)
	}
	if client.httpClient().Timeout != 15*time.Second {
		t.Errorf("default timeout = %v", client.httpClient().Timeout)
	}
}

// A dropped connection is common on long links; one blip must not surface as
// a failed read, while a rate limit must not be hit again in the same round.
func TestTransientNetworkFailureIsRetriedButRateLimitIsNot(t *testing.T) {
	dir := t.TempDir()
	writeClaudeCredential(t, dir, "secret-claude", testNow.Add(24*time.Hour).UnixMilli(), true)
	body := map[string]any{"limits": []any{map[string]any{"kind": "session", "percent": 12.0}, map[string]any{"kind": "weekly_all", "percent": 40.0}}}

	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls++
		if calls == 1 {
			conn, _, err := w.(http.Hijacker).Hijack()
			if err == nil {
				conn.Close()
			}
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(body)
	}))
	defer server.Close()
	client := &Client{HTTP: server.Client(), ClaudeURL: server.URL}
	snapshot, err := client.Fetch(context.Background(), Source{Engine: "claude", AuthDir: dir}, testNow)
	if err != nil {
		t.Fatalf("Fetch after one dropped connection: %v", err)
	}
	if len(snapshot.Windows) != 2 {
		t.Fatalf("windows = %+v", snapshot.Windows)
	}

	limited := 0
	server429 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		limited++
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer server429.Close()
	client = &Client{HTTP: server429.Client(), ClaudeURL: server429.URL}
	if _, err := client.Fetch(context.Background(), Source{Engine: "claude", AuthDir: dir}, testNow); errKind(t, err) != kindTransient {
		t.Fatalf("429: %v", err)
	}
	if limited != 1 {
		t.Fatalf("rate-limited endpoint was called %d times in one read", limited)
	}
}
