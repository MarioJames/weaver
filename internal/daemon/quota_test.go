package daemon

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/MarioJames/weaver/internal/kernel"
	"github.com/MarioJames/weaver/internal/quota"
	"github.com/MarioJames/weaver/internal/store"
)

func TestAccountQuotaMethod(t *testing.T) {
	home := t.TempDir()
	db, err := store.Open(filepath.Join(home, "weaver.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"five_hour":{"utilization":25},"seven_day":{"utilization":50}}`)
	}))
	defer server.Close()
	k := kernel.New(kernel.Options{DB: db, Home: home, QuotaClient: &quota.Client{ClaudeURL: server.URL, HTTP: server.Client()}})
	defer k.Close()
	credential, err := json.Marshal(map[string]any{"claudeAiOauth": map[string]any{"accessToken": "daemon-quota-private-token", "expiresAt": time.Now().Add(time.Hour).UnixMilli()}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".credentials.json"), credential, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := k.AddAccount(kernel.AccountInput{ID: "sub", Engine: "claude", Kind: "subscription", AuthDir: home}); err != nil {
		t.Fatal(err)
	}
	if _, err := k.AddAccount(kernel.AccountInput{ID: "api", Engine: "codex", Kind: "api", APIKey: "api-private-key"}); err != nil {
		t.Fatal(err)
	}
	s := &Server{kernel: k}
	for _, params := range []string{`{}`, `{"id":"sub"}`} {
		result, err := methods["account.quota"](s, context.Background(), json.RawMessage(params), nil)
		if err != nil {
			t.Fatal(err)
		}
		accounts, ok := result.([]*kernel.Account)
		if !ok || len(accounts) != 1 || accounts[0].ID != "sub" || accounts[0].Quota == nil || len(accounts[0].Quota.Windows) != 2 {
			t.Fatalf("unexpected result: %+v", result)
		}
		raw, err := json.Marshal(result)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(raw), "private-token") || strings.Contains(string(raw), "api-private-key") {
			t.Fatal("secret leaked")
		}
	}
	if _, err := methods["account.quota"](s, context.Background(), json.RawMessage(`{"id":"api"}`), nil); err == nil || kernel.AsError(err).Code != "UNSUPPORTED" {
		t.Fatal(err)
	}
}
