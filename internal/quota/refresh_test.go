package quota

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func readJSONFile(t *testing.T, path string) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestCodexProactiveRefreshExpiredAndExpiringSoon(t *testing.T) {
	for _, tc := range []struct {
		name      string
		expiresAt time.Time
	}{
		{"expired", testNow.Add(-time.Minute)},
		{"expiring soon within 15m", testNow.Add(10 * time.Minute)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			oldAccess := testJWT(tc.expiresAt)
			newAccess := testJWT(testNow.Add(10 * 24 * time.Hour))
			writeJSONFile(t, filepath.Join(dir, "auth.json"), map[string]any{
				"OPENAI_API_KEY": nil,
				"auth_mode":      "chatgpt",
				"last_refresh":   "2026-10-01T00:00:00Z",
				"tokens": map[string]any{
					"access_token":  oldAccess,
					"refresh_token": "old-codex-refresh",
					"id_token":      "old-id-token",
					"account_id":    "acct-codex-1",
				},
			})

			var tokenCalls atomic.Int32
			tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				tokenCalls.Add(1)
				if r.Method != http.MethodPost {
					t.Errorf("method = %s, want POST", r.Method)
				}
				if ct := r.Header.Get("Content-Type"); ct != "application/x-www-form-urlencoded" {
					t.Errorf("Content-Type = %q", ct)
				}
				if err := r.ParseForm(); err != nil {
					t.Errorf("ParseForm: %v", err)
				}
				if r.Form.Get("grant_type") != "refresh_token" ||
					r.Form.Get("refresh_token") != "old-codex-refresh" ||
					r.Form.Get("client_id") != codexOAuthClientID ||
					r.Form.Get("scope") != "openid profile email" {
					t.Errorf("unexpected form: %v", r.Form)
				}
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(map[string]any{
					"access_token":  newAccess,
					"refresh_token": "new-codex-refresh",
					"id_token":      "new-id-token",
				})
			}))
			defer tokenServer.Close()

			usageServer, headers := jsonHandler(t, map[string]any{
				"rate_limit": map[string]any{
					"allowed":        true,
					"primary_window": map[string]any{"used_percent": 15.0, "limit_window_seconds": 18000.0},
				},
			})

			client := &Client{HTTP: usageServer.Client(), CodexURL: usageServer.URL, CodexTokenURL: tokenServer.URL}
			snap, err := client.Fetch(context.Background(), Source{Engine: "codex", AuthDir: dir}, testNow)
			if err != nil {
				t.Fatalf("Fetch: %v", err)
			}
			if tokenCalls.Load() != 1 {
				t.Fatalf("tokenCalls = %d, want 1", tokenCalls.Load())
			}
			if got := (<-headers).Get("Authorization"); got != "Bearer "+newAccess {
				t.Fatalf("usage Authorization = %q, want new token", got)
			}
			if snap.Status != statusAvailable || len(snap.Windows) != 1 || snap.Windows[0].UsedPercent != 15 {
				t.Fatalf("snapshot = %+v", snap)
			}

			persisted := readJSONFile(t, filepath.Join(dir, "auth.json"))
			if persisted["auth_mode"] != "chatgpt" || persisted["last_refresh"] != testNow.UTC().Format(time.RFC3339Nano) {
				t.Fatalf("persisted root = %+v", persisted)
			}
			tokens := persisted["tokens"].(map[string]any)
			if tokens["access_token"] != newAccess || tokens["refresh_token"] != "new-codex-refresh" ||
				tokens["id_token"] != "new-id-token" || tokens["account_id"] != "acct-codex-1" {
				t.Fatalf("persisted tokens = %+v", tokens)
			}
			info, err := os.Stat(filepath.Join(dir, "auth.json"))
			if err != nil || info.Mode().Perm() != 0o600 {
				t.Fatalf("auth.json mode = %v, err = %v", info.Mode(), err)
			}
		})
	}
}

func TestClaudeProactiveRefreshPersistsAndPreservesMetadata(t *testing.T) {
	dir := t.TempDir()
	writeJSONFile(t, filepath.Join(dir, ".credentials.json"), map[string]any{
		"claudeAiOauth": map[string]any{
			"accessToken":            "old-claude-access",
			"refreshToken":           "old-claude-refresh",
			"expiresAt":              testNow.Add(-5 * time.Minute).UnixMilli(),
			"refreshTokenExpiresAt":  testNow.Add(30 * 24 * time.Hour).UnixMilli(),
			"scopes":                 []string{"user:inference", "user:profile"},
			"subscriptionType":       "max",
			"subscriptionTypeSource": "oauth",
			"rateLimitTier":          "default_claude_max_5x",
		},
		"otherSection": map[string]any{"keep": true},
	})

	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.Header.Get("Content-Type") != "application/json" {
			t.Errorf("method=%s ct=%s", r.Method, r.Header.Get("Content-Type"))
		}
		var req map[string]any
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Errorf("decode: %v", err)
		}
		if req["grant_type"] != "refresh_token" || req["refresh_token"] != "old-claude-refresh" ||
			req["client_id"] != claudeOAuthClientID || req["scope"] != "user:inference user:profile" {
			t.Errorf("unexpected body: %+v", req)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"access_token":             "new-claude-access",
			"refresh_token":            "new-claude-refresh",
			"expires_in":               28800,
			"refresh_token_expires_in": 2592000,
			"scope":                    "user:inference user:profile user:sessions:claude_code",
		})
	}))
	defer tokenServer.Close()

	usageServer, headers := jsonHandler(t, map[string]any{
		"five_hour": map[string]any{"utilization": 8.0, "resets_at": testNow.Add(5 * time.Hour).Format(time.RFC3339)},
		"seven_day": map[string]any{"utilization": 32.0, "resets_at": testNow.Add(7 * 24 * time.Hour).Format(time.RFC3339)},
	})

	client := &Client{HTTP: usageServer.Client(), ClaudeURL: usageServer.URL, ClaudeTokenURL: tokenServer.URL}
	snap, err := client.Fetch(context.Background(), Source{Engine: "claude", AuthDir: dir}, testNow)
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	if got := (<-headers).Get("Authorization"); got != "Bearer new-claude-access" {
		t.Fatalf("usage Authorization = %q", got)
	}
	if snap.Status != statusAvailable || len(snap.Windows) != 2 {
		t.Fatalf("snapshot = %+v", snap)
	}

	persisted := readJSONFile(t, filepath.Join(dir, ".credentials.json"))
	if persisted["otherSection"] == nil {
		t.Fatalf("lost top-level key: %+v", persisted)
	}
	oauth := persisted["claudeAiOauth"].(map[string]any)
	if oauth["accessToken"] != "new-claude-access" || oauth["refreshToken"] != "new-claude-refresh" {
		t.Fatalf("tokens not updated: %+v", oauth)
	}
	if int64(oauth["expiresAt"].(float64)) != testNow.Add(8*time.Hour).UnixMilli() {
		t.Fatalf("expiresAt = %v", oauth["expiresAt"])
	}
	if int64(oauth["refreshTokenExpiresAt"].(float64)) != testNow.Add(30*24*time.Hour).UnixMilli() {
		t.Fatalf("refreshTokenExpiresAt = %v", oauth["refreshTokenExpiresAt"])
	}
	if oauth["subscriptionType"] != "max" || oauth["rateLimitTier"] != "default_claude_max_5x" {
		t.Fatalf("metadata lost: %+v", oauth)
	}
}

func TestUsage401TriggersSingleRefreshAndRetry(t *testing.T) {
	dir := t.TempDir()
	writeClaudeCredential(t, dir, "revoked-early", testNow.Add(4*time.Hour).UnixMilli(), true)

	var refreshCalls, usageCalls atomic.Int32
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		refreshCalls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "fresh-after-401", "expires_in": 28800})
	}))
	defer tokenServer.Close()

	usageServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := usageCalls.Add(1)
		if r.Header.Get("Authorization") == "Bearer revoked-early" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if n != 2 || r.Header.Get("Authorization") != "Bearer fresh-after-401" {
			t.Errorf("unexpected retry call %d auth=%q", n, r.Header.Get("Authorization"))
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"five_hour": map[string]any{"utilization": 5.0}, "seven_day": map[string]any{"utilization": 10.0}})
	}))
	defer usageServer.Close()

	client := &Client{HTTP: usageServer.Client(), ClaudeURL: usageServer.URL, ClaudeTokenURL: tokenServer.URL}
	snap, err := client.Fetch(context.Background(), Source{Engine: "claude", AuthDir: dir}, testNow)
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	if refreshCalls.Load() != 1 || usageCalls.Load() != 2 || len(snap.Windows) != 2 {
		t.Fatalf("refresh=%d usage=%d snap=%+v", refreshCalls.Load(), usageCalls.Load(), snap)
	}

	// A 403 Forbidden must not spend a refresh token.
	dir403 := t.TempDir()
	writeClaudeCredential(t, dir403, "valid-but-forbidden", testNow.Add(4*time.Hour).UnixMilli(), true)
	var refresh403 atomic.Int32
	tokenServer403 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		refresh403.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	defer tokenServer403.Close()
	usage403 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	}))
	defer usage403.Close()
	client403 := &Client{HTTP: usage403.Client(), ClaudeURL: usage403.URL, ClaudeTokenURL: tokenServer403.URL}
	if _, err := client403.Fetch(context.Background(), Source{Engine: "claude", AuthDir: dir403}, testNow); errKind(t, err) != kindUnauthenticated {
		t.Fatalf("403 err = %v", err)
	}
	if refresh403.Load() != 0 {
		t.Fatalf("403 triggered %d refresh call(s), want 0", refresh403.Load())
	}
}

func TestRefreshFailuresPermanentAndTransient(t *testing.T) {
	t.Run("invalid_grant reports re-login without modifying file or leaking secrets", func(t *testing.T) {
		dir := t.TempDir()
		oldToken := testJWT(testNow.Add(-time.Hour))
		writeCodexCredential(t, dir, oldToken, "acct-secret", true)
		beforeRaw, _ := os.ReadFile(filepath.Join(dir, "auth.json"))

		tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":"invalid_grant","error_description":"refresh-secret leaked echo"}`))
		}))
		defer tokenServer.Close()

		client := &Client{HTTP: tokenServer.Client(), CodexTokenURL: tokenServer.URL}
		_, err := client.Fetch(context.Background(), Source{Engine: "codex", AuthDir: dir}, testNow)
		if err == nil || errKind(t, err) != kindUnauthenticated {
			t.Fatalf("err = %v, want unauthenticated", err)
		}
		if err.Error() != "登录已失效，自动续期失败，请重新登录" {
			t.Fatalf("message = %q", err.Error())
		}
		if strings.Contains(err.Error(), "refresh-secret") {
			t.Fatalf("leaked secret: %v", err)
		}
		afterRaw, _ := os.ReadFile(filepath.Join(dir, "auth.json"))
		if string(beforeRaw) != string(afterRaw) {
			t.Fatal("failed refresh modified auth.json")
		}
	})

	t.Run("transient 500 does not retry POST; expiring-soon falls back to valid token", func(t *testing.T) {
		var calls atomic.Int32
		tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			calls.Add(1)
			w.WriteHeader(http.StatusInternalServerError)
		}))
		defer tokenServer.Close()

		// Expired: returns transient after exactly 1 POST.
		dirExpired := t.TempDir()
		writeClaudeCredential(t, dirExpired, "expired-tok", testNow.Add(-time.Minute).UnixMilli(), true)
		client := &Client{HTTP: tokenServer.Client(), ClaudeTokenURL: tokenServer.URL}
		if _, err := client.Fetch(context.Background(), Source{Engine: "claude", AuthDir: dirExpired}, testNow); errKind(t, err) != kindTransient {
			t.Fatalf("expired 500 err = %v", err)
		}
		if calls.Load() != 1 {
			t.Fatalf("POST retries = %d, want 1", calls.Load())
		}

		// Expiring soon (still valid): falls back to current access token.
		dirSoon := t.TempDir()
		writeClaudeCredential(t, dirSoon, "still-valid-tok", testNow.Add(5*time.Minute).UnixMilli(), true)
		usageServer, headers := jsonHandler(t, map[string]any{"five_hour": map[string]any{"utilization": 22.0}, "seven_day": map[string]any{"utilization": 40.0}})
		client2 := &Client{HTTP: usageServer.Client(), ClaudeURL: usageServer.URL, ClaudeTokenURL: tokenServer.URL}
		snap, err := client2.Fetch(context.Background(), Source{Engine: "claude", AuthDir: dirSoon}, testNow)
		if err != nil {
			t.Fatalf("expiring-soon fallback failed: %v", err)
		}
		if got := (<-headers).Get("Authorization"); got != "Bearer still-valid-tok" || len(snap.Windows) != 2 {
			t.Fatalf("fallback header=%q snap=%+v", got, snap)
		}
	})
}

func TestConcurrentRefreshDeduplicatesUnderAuthDirLock(t *testing.T) {
	dir := t.TempDir()
	writeClaudeCredential(t, dir, "old-tok", testNow.Add(-time.Minute).UnixMilli(), true)

	var tokenCalls atomic.Int32
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		tokenCalls.Add(1)
		time.Sleep(40 * time.Millisecond)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "dedup-new-tok", "refresh_token": "dedup-new-refresh", "expires_in": 28800})
	}))
	defer tokenServer.Close()

	usageServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer dedup-new-tok" {
			t.Errorf("unexpected auth %q", r.Header.Get("Authorization"))
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"five_hour": map[string]any{"utilization": 10.0}, "seven_day": map[string]any{"utilization": 20.0}})
	}))
	defer usageServer.Close()

	client := &Client{HTTP: usageServer.Client(), ClaudeURL: usageServer.URL, ClaudeTokenURL: tokenServer.URL}
	var wg sync.WaitGroup
	errs := make([]error, 4)
	for i := range errs {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			_, errs[idx] = client.Fetch(context.Background(), Source{Engine: "claude", AuthDir: dir}, testNow)
		}(i)
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("goroutine %d err = %v", i, err)
		}
	}
	if got := tokenCalls.Load(); got != 1 {
		t.Fatalf("concurrent tokenCalls = %d, want 1", got)
	}
}

func writeAgyCredential(t *testing.T, authDir, accessToken, refreshToken string, expiry time.Time) string {
	t.Helper()
	dir := filepath.Join(authDir, ".gemini", "antigravity-cli")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	tok := map[string]any{
		"access_token": accessToken,
		"token_type":   "Bearer",
	}
	if refreshToken != "" {
		tok["refresh_token"] = refreshToken
	}
	if !expiry.IsZero() {
		tok["expiry"] = expiry.UTC().Format(time.RFC3339Nano)
	}
	raw, _ := json.Marshal(map[string]any{
		"token":       tok,
		"auth_method": "oauth",
	})
	path := filepath.Join(dir, "antigravity-oauth-token")
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestAgyQuotaFetchPoolScopingAndAutoRefresh(t *testing.T) {
	reset5h := testNow.Add(3 * time.Hour).UTC().Format(time.RFC3339)
	reset7d := testNow.Add(4 * 24 * time.Hour).UTC().Format(time.RFC3339)

	t.Run("fetches loadCodeAssist and retrieveUserQuotaSummary with model pool isolation", func(t *testing.T) {
		dir := t.TempDir()
		writeAgyCredential(t, dir, "agy-valid-tok", "agy-ref", testNow.Add(time.Hour))

		var gotUA, gotProject string
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			gotUA = r.Header.Get("User-Agent")
			w.Header().Set("Content-Type", "application/json")
			switch r.URL.Path {
			case "/load":
				_ = json.NewEncoder(w).Encode(map[string]any{"cloudaicompanionProject": "aicode-consumers"})
			case "/quota":
				var req map[string]any
				_ = json.NewDecoder(r.Body).Decode(&req)
				gotProject, _ = req["project"].(string)
				_ = json.NewEncoder(w).Encode(map[string]any{
					"groups": []any{
						map[string]any{
							"displayName": "Gemini Models",
							"buckets": []any{
								map[string]any{"bucketId": "gemini-5h", "window": "5h", "remainingFraction": 0.8, "resetTime": reset5h},
								map[string]any{"bucketId": "gemini-weekly", "window": "weekly", "remainingFraction": 0.9, "resetTime": reset7d},
							},
						},
						map[string]any{
							"displayName": "Claude and GPT models",
							"buckets": []any{
								map[string]any{"bucketId": "3p-5h", "window": "5h", "remainingFraction": 0.0, "resetTime": reset5h},
								map[string]any{"bucketId": "3p-weekly", "window": "weekly", "remainingFraction": 0.5, "resetTime": reset7d},
							},
						},
					},
				})
			}
		}))
		defer srv.Close()

		client := &Client{
			HTTP:                 srv.Client(),
			AgyLoadCodeAssistURL: srv.URL + "/load",
			AgyQuotaURL:          srv.URL + "/quota",
		}
		snap, err := client.Fetch(context.Background(), Source{Engine: "agy", AuthDir: dir}, testNow)
		if err != nil {
			t.Fatalf("Fetch: %v", err)
		}
		if !strings.HasPrefix(gotUA, "antigravity/cli/") || gotProject != "aicode-consumers" {
			t.Fatalf("ua=%q project=%q", gotUA, gotProject)
		}
		if snap.Status != statusAvailable || len(snap.Windows) != 4 {
			t.Fatalf("snap = %+v", snap)
		}
		// 3p pool is 100% used, but Gemini pool still has 80%/90% left:
		// Gemini models must stay routable while Claude/GPT models are blocked.
		if f := Factor(snap, "gemini-4-neon-xhigh", testNow); f <= 0 {
			t.Fatalf("gemini factor = %v, want > 0", f)
		}
		if f := Factor(snap, "claude-opus-5-5", testNow); f != 0 {
			t.Fatalf("claude factor = %v, want 0", f)
		}
		if f := Factor(snap, "gpt-oss-120b-medium", testNow); f != 0 {
			t.Fatalf("gpt factor = %v, want 0", f)
		}
	})

	t.Run("expired token refreshes automatically and respects SkipRefresh", func(t *testing.T) {
		dir := t.TempDir()
		writeAgyCredential(t, dir, "agy-expired-tok", "agy-ref", testNow.Add(-5*time.Minute))

		var refreshCalls atomic.Int32
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("Authorization") != "Bearer agy-fresh-tok" {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"groups": []any{
					map[string]any{
						"displayName": "Gemini Models",
						"buckets":     []any{map[string]any{"bucketId": "gemini-5h", "window": "5h", "remainingFraction": 1.0, "resetTime": reset5h}},
					},
				},
			})
		}))
		defer srv.Close()

		client := &Client{
			HTTP:        srv.Client(),
			AgyQuotaURL: srv.URL,
			AgyRefreshFunc: func(_ context.Context, authDir string) error {
				refreshCalls.Add(1)
				writeAgyCredential(t, authDir, "agy-fresh-tok", "agy-ref", testNow.Add(time.Hour))
				return nil
			},
		}

		// SkipRefresh returns renewal_pending without touching credentials.
		if _, err := client.Fetch(context.Background(), Source{Engine: "agy", AuthDir: dir, SkipRefresh: true}, testNow); errKind(t, err) != kindRenewalPending {
			t.Fatalf("SkipRefresh err = %v, want renewal_pending", err)
		}
		if refreshCalls.Load() != 0 {
			t.Fatalf("SkipRefresh called refresh %d times", refreshCalls.Load())
		}

		snap, err := client.Fetch(context.Background(), Source{Engine: "agy", AuthDir: dir}, testNow)
		if err != nil {
			t.Fatalf("Fetch after refresh: %v", err)
		}
		if refreshCalls.Load() != 1 || snap.Status != statusAvailable {
			t.Fatalf("calls=%d snap=%+v", refreshCalls.Load(), snap)
		}
	})

	t.Run("401 triggers forced refresh and restores original token on transient failure", func(t *testing.T) {
		dir := t.TempDir()
		tokPath := writeAgyCredential(t, dir, "agy-revoked-tok", "agy-ref", testNow.Add(time.Hour))
		origBytes, _ := os.ReadFile(tokPath)

		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusUnauthorized)
		}))
		defer srv.Close()

		client := &Client{
			HTTP:        srv.Client(),
			AgyQuotaURL: srv.URL,
			AgyRefreshFunc: func(_ context.Context, _ string) error {
				return transient("temporary failure")
			},
		}
		if _, err := client.Fetch(context.Background(), Source{Engine: "agy", AuthDir: dir}, testNow); errKind(t, err) != kindTransient {
			t.Fatalf("err = %v, want transient", err)
		}
		afterBytes, _ := os.ReadFile(tokPath)
		var beforeObj, afterObj map[string]any
		_ = json.Unmarshal(origBytes, &beforeObj)
		_ = json.Unmarshal(afterBytes, &afterObj)
		beforeExp := beforeObj["token"].(map[string]any)["expiry"]
		afterExp := afterObj["token"].(map[string]any)["expiry"]
		if beforeExp != afterExp {
			t.Fatalf("expiry not restored: before=%v after=%v", beforeExp, afterExp)
		}
	})
}
