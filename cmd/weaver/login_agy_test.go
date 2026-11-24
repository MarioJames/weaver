package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestLoginAgyBrowserLinkBackupAndRestore(t *testing.T) {
	home := t.TempDir()
	tokDir := filepath.Join(home, ".gemini", "antigravity-cli")
	if err := os.MkdirAll(tokDir, 0o700); err != nil {
		t.Fatal(err)
	}
	tokPath := filepath.Join(tokDir, "antigravity-oauth-token")
	orig := `{"token":{"access_token":"old"}}`
	if err := os.WriteFile(tokPath, []byte(orig), 0o600); err != nil {
		t.Fatal(err)
	}

	// Fake $BROWSER catches the OAuth URL printed by agy.
	caughtFile := filepath.Join(t.TempDir(), "caught.txt")
	browserScript := filepath.Join(t.TempDir(), "browser.sh")
	if err := os.WriteFile(browserScript, []byte("#!/bin/sh\nprintf '%s\\n' \"$1\" > "+caughtFile+"\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("BROWSER", browserScript)

	// Case 1: login cancelled/failed restores the backed-up token.
	failScript := filepath.Join(t.TempDir(), "agy-fail.sh")
	if err := os.WriteFile(failScript, []byte("#!/bin/sh\necho '  https://accounts.google.com/o/oauth2/auth?client_id=test&state=1'\nexit 1\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	_ = w.Close()
	oldStdin := os.Stdin
	os.Stdin = r
	err = loginAgy("acct_agy", []string{failScript}, map[string]string{"HOME": home})
	os.Stdin = oldStdin
	_ = r.Close()
	if err == nil {
		t.Fatal("expected error when agy login fails")
	}
	gotOrig, err := os.ReadFile(tokPath)
	if err != nil || string(gotOrig) != orig {
		t.Fatalf("original token not restored: got=%q err=%v", string(gotOrig), err)
	}
	// Wait briefly for the async browser goroutine to write the caught URL.
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if data, readErr := os.ReadFile(caughtFile); readErr == nil && strings.Contains(string(data), "https://accounts.google.com/o/oauth2/auth") {
			break
		}
		time.Sleep(15 * time.Millisecond)
	}
	if data, readErr := os.ReadFile(caughtFile); readErr != nil || !strings.Contains(string(data), "client_id=test") {
		t.Fatalf("BROWSER did not receive OAuth URL: data=%q err=%v", string(data), readErr)
	}

	// Case 2: successful login writes new token and cleans up backup.
	okScript := filepath.Join(t.TempDir(), "agy-ok.sh")
	if err := os.WriteFile(okScript, []byte("#!/bin/sh\nread code\nprintf '{\"token\":{\"access_token\":\"new-%s\"}}' \"$code\" > \"$HOME/.gemini/antigravity-cli/antigravity-oauth-token\"\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	r2, w2, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	_, _ = w2.WriteString("authcode123\n")
	_ = w2.Close()
	os.Stdin = r2
	err = loginAgy("acct_agy", []string{okScript}, map[string]string{"HOME": home})
	os.Stdin = oldStdin
	_ = r2.Close()
	if err != nil {
		t.Fatalf("loginAgy succeeded case failed: %v", err)
	}
	gotNew, err := os.ReadFile(tokPath)
	if err != nil || !strings.Contains(string(gotNew), "new-authcode123") {
		t.Fatalf("new token not written: got=%q err=%v", string(gotNew), err)
	}
	if _, err := os.Stat(tokPath + ".login-bak"); !os.IsNotExist(err) {
		t.Fatalf("backup file still exists: %v", err)
	}
}
