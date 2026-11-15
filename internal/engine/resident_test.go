package engine

import (
	"log/slog"
	"net"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestResidentUnitIsScopedToCanonicalHome(t *testing.T) {
	home := t.TempDir()
	a := NewResident(nil, slog.New(slog.DiscardHandler), home, noStore{})
	b := NewResident(nil, slog.New(slog.DiscardHandler), t.TempDir(), noStore{})
	alias := filepath.Join(t.TempDir(), "alias")
	if err := os.Symlink(home, alias); err != nil {
		t.Fatal(err)
	}
	same := NewResident(nil, slog.New(slog.DiscardHandler), alias+"/./", noStore{})
	if a.residentUnit("acct") == b.residentUnit("acct") {
		t.Fatal("different homes share a unit")
	}
	if a.residentUnit("acct") != same.residentUnit("acct") {
		t.Fatal("equivalent homes have different units")
	}
	for _, id := range []string{"acct", "a/b 中文", strings.Repeat("long", 100)} {
		unit := a.residentUnit(id)
		if len(unit+".scope") > 255 || !regexp.MustCompile(`^[A-Za-z0-9_.-]+$`).MatchString(unit) {
			t.Fatalf("invalid unit %q", unit)
		}
	}
}

type residentRecords struct {
	noStore
	records []ResidentRecord
	deleted []string
}

func (s *residentRecords) Residents() ([]ResidentRecord, error) { return s.records, nil }
func (s *residentRecords) DeleteResident(id string) error {
	s.deleted = append(s.deleted, id)
	return nil
}

func TestResidentResumeKeepsLegacyRecordUnit(t *testing.T) {
	f := newFakeOpencode(t)
	u, err := url.Parse(f.server.URL)
	if err != nil {
		t.Fatal(err)
	}
	_, port, err := net.SplitHostPort(u.Host)
	if err != nil {
		t.Fatal(err)
	}
	n, err := strconv.Atoi(port)
	if err != nil {
		t.Fatal(err)
	}
	home := t.TempDir()
	rec := ResidentRecord{AccountID: "acct", Unit: unitFor("oc-acct"), Port: n, Dir: filepath.Join(home, "residents", "acct")}
	store := &residentRecords{records: []ResidentRecord{rec}}
	r := NewResident(nil, slog.New(slog.DiscardHandler), home, store)
	r.Resume(func(id string) (Account, error) { return Account{ID: id}, nil })
	status := r.Status()
	if len(status) != 1 || status[0].State != "ready" || status[0].Unit != rec.Unit {
		t.Fatalf("resume = %+v", status)
	}
	// Ensure the event follower is cancelled before the HTTP server is closed.
	srv := r.servers["acct"]
	deadline := time.Now().Add(time.Second)
	for {
		srv.mu.Lock()
		cancel := srv.cancel
		srv.mu.Unlock()
		if cancel != nil {
			t.Cleanup(cancel)
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("event follower did not start")
		}
		time.Sleep(time.Millisecond)
	}
}

func TestResidentStartOnlyStopsItsOwnUnit(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "opencode")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\nexit 1\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", filepath.Dir(bin)+":"+os.Getenv("PATH"))
	r := NewResident(nil, slog.New(slog.DiscardHandler), t.TempDir(), noStore{})
	other := NewResident(nil, slog.New(slog.DiscardHandler), t.TempDir(), noStore{})
	var stopped []string
	r.command = func(name string, args ...string) *exec.Cmd {
		if name == "systemctl" && len(args) > 2 && args[1] == "kill" {
			stopped = append(stopped, args[len(args)-1])
		}
		if name == "systemd-run" {
			return exec.Command("/bin/false")
		}
		return exec.Command("/bin/true") // inactive, so stopScope does not wait
	}
	srv := newServer(Account{ID: "acct", Kind: "api"}, ResidentRecord{AccountID: "acct", Unit: other.residentUnit("acct")})
	r.start(srv)
	if len(stopped) != 1 || stopped[0] != r.residentUnit("acct")+".scope" {
		t.Fatalf("stopped = %v", stopped)
	}
	if srv.state != "down" {
		t.Fatalf("start state = %s", srv.state)
	}
}

func TestResidentResumeDoesNotStopForeignRecord(t *testing.T) {
	home := t.TempDir()
	other := NewResident(nil, slog.New(slog.DiscardHandler), t.TempDir(), noStore{})
	for _, unit := range []string{other.residentUnit("acct"), unitFor("oc-acct")} {
		t.Run(unit, func(t *testing.T) {
			store := &residentRecords{records: []ResidentRecord{{AccountID: "acct", Unit: unit, Dir: filepath.Join(other.home, "residents", "acct")}}}
			r := NewResident(nil, slog.New(slog.DiscardHandler), home, store)
			r.command = func(name string, args ...string) *exec.Cmd {
				t.Fatalf("foreign record invoked %s %v", name, args)
				return nil
			}
			r.Resume(func(id string) (Account, error) { return Account{ID: id}, nil })
			if len(r.Status()) != 0 || len(store.deleted) != 1 {
				t.Fatalf("foreign record not dropped: %+v", r.Status())
			}
		})
	}
}

func TestLegacyResidentStopChecksLiveScopeDirectory(t *testing.T) {
	// The test process is a live member of its current cgroup; use its cwd as
	// the expected server directory without starting or stopping a real scope.
	home := t.TempDir()
	dir := filepath.Join(home, "residents", "acct")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	t.Chdir(dir)
	data, err := os.ReadFile("/proc/self/cgroup")
	if err != nil {
		t.Fatal(err)
	}
	group := ""
	for _, line := range strings.Split(string(data), "\n") {
		if value, ok := strings.CutPrefix(line, "0::"); ok {
			group = value
		}
	}
	if group == "" || group == "/" {
		t.Skip("live scope ownership requires a non-root unified cgroup")
	}
	if _, err := os.ReadFile(filepath.Join("/sys/fs/cgroup", group, "cgroup.procs")); err != nil {
		t.Skipf("cgroup membership is not visible: %v", err)
	}
	r := NewResident(nil, slog.New(slog.DiscardHandler), home, noStore{})
	var stopped []string
	r.command = func(name string, args ...string) *exec.Cmd {
		if name != "systemctl" {
			t.Fatalf("unexpected command %s", name)
		}
		if args[1] == "show" {
			cmd := exec.Command("/bin/echo", group)
			return cmd
		}
		if args[1] == "kill" {
			stopped = append(stopped, args[len(args)-1])
		}
		return exec.Command("/bin/true")
	}
	legacy := ResidentRecord{AccountID: "acct", Unit: unitFor("oc-acct"), Dir: dir}
	r.stopRecord(legacy)
	if len(stopped) != 1 || stopped[0] != legacy.Unit+".scope" {
		t.Fatalf("legacy scope not stopped: %v", stopped)
	}
	// A copied record still points at a valid local directory, but a reused
	// legacy scope has no live process there. Do not stop it on this evidence.
	t.Chdir(home)
	r.stopRecord(legacy)
	if len(stopped) != 1 {
		t.Fatalf("reused legacy scope stopped: %v", stopped)
	}
}
