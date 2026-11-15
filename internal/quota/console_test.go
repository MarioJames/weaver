package quota

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func createConsoleDB(t *testing.T, path string, accountID, orgID, token, origin string, expiry any, refresh string, stateRows int) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = db.Close() })
	if _, err := db.Exec(`CREATE TABLE account (
		id text PRIMARY KEY, email text NOT NULL, url text NOT NULL,
		access_token text NOT NULL, refresh_token text NOT NULL, token_expiry integer,
		time_created integer NOT NULL, time_updated integer NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TABLE account_state (
		id integer PRIMARY KEY, active_account_id text, active_org_id text)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO account (id, email, url, access_token, refresh_token, token_expiry, time_created, time_updated)
		VALUES (?, ?, ?, ?, ?, ?, 1, 1)`, accountID, "fixture@example.invalid", origin, token, refresh, expiry); err != nil {
		t.Fatal(err)
	}
	for index := 0; index < stateRows; index++ {
		if _, err := db.Exec(`INSERT INTO account_state (id, active_account_id, active_org_id) VALUES (?, ?, ?)`, index+1, accountID, orgID); err != nil {
			t.Fatal(err)
		}
	}
	return db
}

func TestOpenCodeConsoleSnapshotAndHeaders(t *testing.T) {
	dir := t.TempDir()
	createConsoleDB(t, filepath.Join(dir, "opencode.db"), "acc_secret", "wrk_secret", "secret-console", "https://opencode.ai/console", testNow.Add(24*time.Hour).UnixMilli(), "refresh-secret", 1)
	writeOpenCodeKey(t, dir, "secret-stale-key")
	body := map[string]any{
		"subscriberUserId": "sub-secret",
		"paymentMethodId":  "pm-secret",
		"access": map[string]any{"meters": map[string]any{
			"fiveHour": map[string]any{"usedMicroCents": "120", "limitMicroCents": "1200", "resetsAt": testNow.Add(2 * time.Hour).Format(time.RFC3339Nano)},
			"week":     map[string]any{"usedMicroCents": "360", "limitMicroCents": "1200", "resetsAt": testNow.Add(3 * 24 * time.Hour).Format(time.RFC3339Nano)},
			"month":    map[string]any{"usedMicroCents": "600", "limitMicroCents": "1200", "resetsAt": testNow.Add(10 * 24 * time.Hour).Format(time.RFC3339Nano)},
		}},
	}
	headers := make(chan http.Header, 1)
	paths := make(chan string, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		headers <- r.Header.Clone()
		paths <- r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(body)
	}))
	defer server.Close()
	client := &Client{
		HTTP:               server.Client(),
		OpenCodeGoURL:      server.URL + "/zen/go/v1/usage",
		OpenCodeConsoleURL: server.URL + "/console/api/go/status",
	}
	snapshot, err := client.Fetch(context.Background(), Source{Engine: "opencode", AuthDir: dir}, testNow)
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	if path := <-paths; path != "/console/api/go/status" {
		t.Errorf("path = %q, want the Console path", path)
	}
	header := <-headers
	if got := header.Get("Authorization"); got != "Bearer secret-console" {
		t.Errorf("Authorization = %q", got)
	}
	if got := header.Get("x-org-id"); got != "wrk_secret" {
		t.Errorf("x-org-id = %q", got)
	}
	if got := header.Get("Accept"); got != "application/json" {
		t.Errorf("Accept = %q", got)
	}
	if snapshot.Status != statusAvailable || len(snapshot.Windows) != 3 {
		t.Fatalf("snapshot = %+v", snapshot)
	}
	wantPercent := []float64{10, 30, 50}
	wantDuration := []int{300, 10080, 43200}
	for index, window := range snapshot.Windows {
		if window.ID != []string{"opencode:rolling", "opencode:weekly", "opencode:monthly"}[index] {
			t.Errorf("window %d id = %q", index, window.ID)
		}
		if window.UsedPercent != wantPercent[index] || window.DurationMinutes != wantDuration[index] || window.Scope != scopeAccount {
			t.Errorf("window %d = %+v", index, window)
		}
	}
	encoded, _ := json.Marshal(snapshot)
	for _, secret := range []string{"secret-console", "secret-stale-key", "sub-secret", "pm-secret", "wrk_secret", "acc_secret", "fixture@example.invalid", "refresh-secret"} {
		if strings.Contains(string(encoded), secret) {
			t.Errorf("snapshot leaked %q: %s", secret, encoded)
		}
	}
}

func TestOpenCodeConsoleCredentialTableWins(t *testing.T) {
	dir := t.TempDir()
	db, err := sql.Open("sqlite", "file:"+filepath.Join(dir, "opencode.db")+"?_pragma=journal_mode(WAL)")
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = db.Close() })
	if _, err := db.Exec(`CREATE TABLE credential (
		id text PRIMARY KEY, integration_id text NOT NULL, label text NOT NULL,
		value text NOT NULL, active integer NOT NULL, time_created integer NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TABLE account_state (
		id integer PRIMARY KEY, active_account_id text, active_org_id text)`); err != nil {
		t.Fatal(err)
	}
	value, _ := json.Marshal(map[string]any{
		"type":     "oauth",
		"access":   "secret-console-table",
		"refresh":  "refresh-secret",
		"expires":  testNow.Add(24 * time.Hour).UnixMilli(),
		"metadata": map[string]any{"orgID": "wrk_table", "server": "https://opencode.ai/console/"},
	})
	if _, err := db.Exec(`INSERT INTO credential (id, integration_id, label, value, active, time_created) VALUES (?, ?, ?, ?, 1, 1)`,
		"cred_1", "opencode", "Console", string(value)); err != nil {
		t.Fatal(err)
	}
	goValue, _ := json.Marshal(map[string]any{"type": "key", "key": "secret-go-table"})
	if _, err := db.Exec(`INSERT INTO credential (id, integration_id, label, value, active, time_created) VALUES (?, ?, ?, ?, 1, 2)`,
		"cred_2", "opencode-go", "Go", string(goValue)); err != nil {
		t.Fatal(err)
	}
	writeOpenCodeKey(t, dir, "secret-auth-file")
	body := map[string]any{"access": map[string]any{"meters": map[string]any{
		"fiveHour": map[string]any{"usedMicroCents": "1", "limitMicroCents": "10", "resetsAt": testNow.Add(time.Hour).Format(time.RFC3339Nano)},
		"week":     map[string]any{"usedMicroCents": "1", "limitMicroCents": "10", "resetsAt": testNow.Add(24 * time.Hour).Format(time.RFC3339Nano)},
		"month":    map[string]any{"usedMicroCents": "1", "limitMicroCents": "10", "resetsAt": testNow.Add(48 * time.Hour).Format(time.RFC3339Nano)},
	}}}
	headers := make(chan http.Header, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		headers <- r.Header.Clone()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(body)
	}))
	defer server.Close()
	client := &Client{HTTP: server.Client(), OpenCodeConsoleURL: server.URL, OpenCodeGoURL: server.URL + "/go"}
	snapshot, err := client.Fetch(context.Background(), Source{Engine: "opencode", AuthDir: dir}, testNow)
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	header := <-headers
	if got := header.Get("Authorization"); got != "Bearer secret-console-table" {
		t.Errorf("Authorization = %q", got)
	}
	if got := header.Get("x-org-id"); got != "wrk_table" {
		t.Errorf("x-org-id = %q", got)
	}
	if snapshot.Status != statusAvailable {
		t.Errorf("status = %q", snapshot.Status)
	}
}

func TestOpenCodeGoKeyFromCredentialTable(t *testing.T) {
	dir := t.TempDir()
	db, err := sql.Open("sqlite", "file:"+filepath.Join(dir, "opencode.db")+"?_pragma=journal_mode(WAL)")
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = db.Close() })
	if _, err := db.Exec(`CREATE TABLE credential (
		id text PRIMARY KEY, integration_id text NOT NULL, label text NOT NULL,
		value text NOT NULL, active integer NOT NULL, time_created integer NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TABLE account_state (
		id integer PRIMARY KEY, active_account_id text, active_org_id text)`); err != nil {
		t.Fatal(err)
	}
	value, _ := json.Marshal(map[string]any{"type": "key", "key": "secret-go-table"})
	if _, err := db.Exec(`INSERT INTO credential (id, integration_id, label, value, active, time_created) VALUES (?, ?, ?, ?, 1, 1)`,
		"cred_go", "opencode-go", "Go", string(value)); err != nil {
		t.Fatal(err)
	}
	writeOpenCodeKey(t, dir, "secret-auth-file")
	body := map[string]any{"usage": map[string]any{
		"rolling": map[string]any{"status": "ok", "percent": 1.0, "resetsAt": testNow.Add(time.Hour).Format(time.RFC3339Nano)},
		"weekly":  map[string]any{"status": "ok", "percent": 2.0, "resetsAt": testNow.Add(24 * time.Hour).Format(time.RFC3339Nano)},
		"monthly": map[string]any{"status": "ok", "percent": 3.0, "resetsAt": testNow.Add(48 * time.Hour).Format(time.RFC3339Nano)},
	}}
	headers := make(chan http.Header, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		headers <- r.Header.Clone()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(body)
	}))
	defer server.Close()
	client := &Client{HTTP: server.Client(), OpenCodeGoURL: server.URL}
	snapshot, err := client.Fetch(context.Background(), Source{Engine: "opencode", AuthDir: dir}, testNow)
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	header := <-headers
	if got := header.Get("Authorization"); got != "Bearer secret-go-table" {
		t.Errorf("Authorization = %q", got)
	}
	if snapshot.Status != statusAvailable {
		t.Errorf("status = %q", snapshot.Status)
	}
}

func TestOpenCodeConsoleClosedWAL(t *testing.T) {
	dir := t.TempDir()
	db := createConsoleDB(t, filepath.Join(dir, "opencode.db"), "acc", "org", "secret-console", "https://opencode.ai/console", testNow.Add(24*time.Hour).UnixMilli(), "r", 1)
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	body := map[string]any{"access": map[string]any{"meters": map[string]any{
		"fiveHour": map[string]any{"usedMicroCents": "1", "limitMicroCents": "10", "resetsAt": testNow.Add(time.Hour).Format(time.RFC3339Nano)},
		"week":     map[string]any{"usedMicroCents": "1", "limitMicroCents": "10", "resetsAt": testNow.Add(24 * time.Hour).Format(time.RFC3339Nano)},
		"month":    map[string]any{"usedMicroCents": "1", "limitMicroCents": "10", "resetsAt": testNow.Add(48 * time.Hour).Format(time.RFC3339Nano)},
	}}}
	server, _ := jsonHandler(t, body)
	client := &Client{HTTP: server.Client(), OpenCodeConsoleURL: server.URL}
	snapshot, err := client.Fetch(context.Background(), Source{Engine: "opencode", AuthDir: dir}, testNow)
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	if snapshot.Status != statusAvailable {
		t.Fatalf("snapshot = %+v", snapshot)
	}
}

func TestOpenCodeGoKeyWhenNoConsoleLogin(t *testing.T) {
	dir := t.TempDir()
	createConsoleDB(t, filepath.Join(dir, "opencode.db"), "acc", "org", "secret-console", "https://opencode.ai/console", testNow.Add(24*time.Hour).UnixMilli(), "r", 0)
	writeOpenCodeKey(t, dir, "secret-auth-file")
	body := map[string]any{"usage": map[string]any{
		"rolling": map[string]any{"status": "ok", "percent": 1.0, "resetsAt": testNow.Add(time.Hour).Format(time.RFC3339Nano)},
		"weekly":  map[string]any{"status": "ok", "percent": 2.0, "resetsAt": testNow.Add(24 * time.Hour).Format(time.RFC3339Nano)},
		"monthly": map[string]any{"status": "ok", "percent": 3.0, "resetsAt": testNow.Add(48 * time.Hour).Format(time.RFC3339Nano)},
	}}
	headers := make(chan http.Header, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		headers <- r.Header.Clone()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(body)
	}))
	defer server.Close()
	client := &Client{HTTP: server.Client(), OpenCodeGoURL: server.URL, OpenCodeConsoleURL: server.URL + "/console"}
	snapshot, err := client.Fetch(context.Background(), Source{Engine: "opencode", AuthDir: dir}, testNow)
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	header := <-headers
	if got := header.Get("Authorization"); got != "Bearer secret-auth-file" {
		t.Errorf("Authorization = %q", got)
	}
	if snapshot.Status != statusAvailable {
		t.Errorf("status = %q", snapshot.Status)
	}
}

func TestOpenCodeCorruptDatabaseFailsClosed(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "opencode.db"), []byte("not a sqlite database"), 0o600); err != nil {
		t.Fatal(err)
	}
	writeOpenCodeKey(t, dir, "secret-other-account")
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests++
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{}`))
	}))
	defer server.Close()
	client := &Client{HTTP: server.Client(), OpenCodeGoURL: server.URL, OpenCodeConsoleURL: server.URL}
	_, err := client.Fetch(context.Background(), Source{Engine: "opencode", AuthDir: dir}, testNow)
	if err == nil {
		t.Fatal("expected an error")
	}
	if got := errKind(t, err); got != kindUnsupported {
		t.Fatalf("kind = %q, want unsupported", got)
	}
	if requests != 0 {
		t.Errorf("requests = %d, want 0", requests)
	}
	if strings.Contains(err.Error(), "secret-other-account") {
		t.Errorf("error leaked the key: %v", err)
	}
}

func TestOpenCodeConsoleUnusableStateDoesNotFallBack(t *testing.T) {
	for name, setup := range map[string]func(t *testing.T, dir string){
		"missing org": func(t *testing.T, dir string) {
			createConsoleDB(t, filepath.Join(dir, "opencode.db"), "acc", "", "secret-console", "https://opencode.ai/console", testNow.Add(24*time.Hour).UnixMilli(), "r", 1)
		},
		"ambiguous state": func(t *testing.T, dir string) {
			createConsoleDB(t, filepath.Join(dir, "opencode.db"), "acc", "org", "secret-console", "https://opencode.ai/console", testNow.Add(24*time.Hour).UnixMilli(), "r", 2)
		},
		"foreign origin": func(t *testing.T, dir string) {
			createConsoleDB(t, filepath.Join(dir, "opencode.db"), "acc", "org", "secret-console", "https://selfhosted.invalid/console", testNow.Add(24*time.Hour).UnixMilli(), "r", 1)
		},
		"expired without refresh": func(t *testing.T, dir string) {
			createConsoleDB(t, filepath.Join(dir, "opencode.db"), "acc", "org", "secret-console", "https://opencode.ai/console", testNow.Add(-time.Hour).UnixMilli(), "", 1)
		},
		"expired with refresh": func(t *testing.T, dir string) {
			createConsoleDB(t, filepath.Join(dir, "opencode.db"), "acc", "org", "secret-console", "https://opencode.ai/console", testNow.Add(-time.Hour).UnixMilli(), "refresh", 1)
		},
	} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			setup(t, dir)
			writeOpenCodeKey(t, dir, "secret-other-account")
			requests := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				requests++
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{}`))
			}))
			defer server.Close()
			client := &Client{HTTP: server.Client(), OpenCodeGoURL: server.URL, OpenCodeConsoleURL: server.URL}
			_, err := client.Fetch(context.Background(), Source{Engine: "opencode", AuthDir: dir}, testNow)
			if err == nil {
				t.Fatal("expected an error")
			}
			if requests != 0 {
				t.Errorf("requests = %d, want 0", requests)
			}
			if strings.Contains(err.Error(), "secret-") {
				t.Errorf("error leaked a credential: %v", err)
			}
			want := kindUnsupported
			if strings.Contains(name, "expired with refresh") {
				want = kindRenewalPending
			} else if strings.Contains(name, "expired without refresh") {
				want = kindUnauthenticated
			}
			if got := errKind(t, err); got != want {
				t.Errorf("kind = %q, want %q (%v)", got, want, err)
			}
		})
	}
}

func TestOpenCodeConsolePartialAndExhausted(t *testing.T) {
	dir := t.TempDir()
	createConsoleDB(t, filepath.Join(dir, "opencode.db"), "acc", "org", "secret-console", "https://opencode.ai/console", testNow.Add(24*time.Hour).UnixMilli(), "r", 1)
	t.Run("missing meter is unknown", func(t *testing.T) {
		server, _ := jsonHandler(t, map[string]any{"access": map[string]any{"meters": map[string]any{
			"fiveHour": map[string]any{"usedMicroCents": "1", "limitMicroCents": "10", "resetsAt": testNow.Add(time.Hour).Format(time.RFC3339Nano)},
			"week":     map[string]any{"usedMicroCents": "1", "limitMicroCents": "10", "resetsAt": testNow.Add(24 * time.Hour).Format(time.RFC3339Nano)},
		}}})
		client := &Client{HTTP: server.Client(), OpenCodeConsoleURL: server.URL}
		snapshot, err := client.Fetch(context.Background(), Source{Engine: "opencode", AuthDir: dir}, testNow)
		if err != nil {
			t.Fatalf("Fetch: %v", err)
		}
		if snapshot.Status != statusUnknown || len(snapshot.Windows) != 0 {
			t.Fatalf("snapshot = %+v", snapshot)
		}
	})
	t.Run("exhausted meter", func(t *testing.T) {
		server, _ := jsonHandler(t, map[string]any{"access": map[string]any{"meters": map[string]any{
			"fiveHour": map[string]any{"usedMicroCents": "10", "limitMicroCents": "10", "resetsAt": testNow.Add(time.Hour).Format(time.RFC3339Nano)},
			"week":     map[string]any{"usedMicroCents": "1", "limitMicroCents": "10", "resetsAt": testNow.Add(24 * time.Hour).Format(time.RFC3339Nano)},
			"month":    map[string]any{"usedMicroCents": "1", "limitMicroCents": "10", "resetsAt": testNow.Add(48 * time.Hour).Format(time.RFC3339Nano)},
		}}})
		client := &Client{HTTP: server.Client(), OpenCodeConsoleURL: server.URL}
		snapshot, err := client.Fetch(context.Background(), Source{Engine: "opencode", AuthDir: dir}, testNow)
		if err != nil {
			t.Fatalf("Fetch: %v", err)
		}
		if snapshot.Status != statusExhausted || len(snapshot.Windows) != 3 {
			t.Fatalf("snapshot = %+v", snapshot)
		}
	})
	t.Run("five hour without reset is zero only when unused", func(t *testing.T) {
		for _, used := range []string{"0", "1"} {
			body := map[string]any{"access": map[string]any{"meters": map[string]any{
				"fiveHour": map[string]any{"usedMicroCents": used, "limitMicroCents": "10"},
				"week":     map[string]any{"usedMicroCents": "1", "limitMicroCents": "10", "resetsAt": testNow.Add(24 * time.Hour).Format(time.RFC3339Nano)},
				"month":    map[string]any{"usedMicroCents": "1", "limitMicroCents": "10", "resetsAt": testNow.Add(48 * time.Hour).Format(time.RFC3339Nano)},
			}}}
			server, _ := jsonHandler(t, body)
			client := &Client{HTTP: server.Client(), OpenCodeConsoleURL: server.URL}
			snapshot, err := client.Fetch(context.Background(), Source{Engine: "opencode", AuthDir: dir}, testNow)
			if err != nil {
				t.Fatalf("Fetch: %v", err)
			}
			if used == "0" {
				if snapshot.Status != statusAvailable || len(snapshot.Windows) != 3 || snapshot.Windows[0].UsedPercent != 0 || snapshot.Windows[0].ResetsAt != 0 {
					t.Errorf("unused rolling window = %+v", snapshot)
				}
			} else if snapshot.Status != statusUnknown {
				t.Errorf("used rolling window without reset: %+v", snapshot)
			}
			server.Close()
		}
	})
}
