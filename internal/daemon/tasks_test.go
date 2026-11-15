package daemon

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/MarioJames/weaver/internal/kernel"
	"github.com/MarioJames/weaver/internal/store"
)

func TestMissionOwnerRPC(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	db, err := store.Open(filepath.Join(home, "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err = db.Exec(`INSERT INTO missions(id,title,workspace,created_at) VALUES('m_test','test',?,1)`, home); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(home, ".claude/projects/test/s.jsonl")
	if err = os.MkdirAll(filepath.Dir(p), 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(p, []byte(`{"type":"user","message":{"content":"hello"}}`+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	k := kernel.New(kernel.Options{DB: db, Home: home})
	defer k.Close()
	s := &Server{kernel: k}
	result, err := methods["mission.owner"](s, context.Background(), json.RawMessage(`{"mission":"m_test","engine":"claude","session":"s"}`), nil)
	if err != nil {
		t.Fatal(err)
	}
	m := result.(*kernel.Mission)
	if m.Owner == nil || m.Owner.Engine != "claude" || m.Owner.Session != "s" {
		t.Fatalf("%+v", m)
	}
	items, err := k.SessionItems("claude", "s", 0, 0)
	if err != nil || len(items) != 1 {
		t.Fatalf("%v %v", items, err)
	}
	if _, err = methods["mission.owner"](s, context.Background(), json.RawMessage(`{"mission":"m_test","engine":"other","session":"s"}`), nil); err == nil {
		t.Fatal("invalid owner accepted")
	}
}
