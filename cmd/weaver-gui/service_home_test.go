package main

import (
	"context"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
)

// customDataHome makes dir the data directory and points the "default" at a
// different directory for the duration of the test.
func customDataHome(t *testing.T) {
	t.Helper()
	saved := dataHomeDefault
	dataHomeDefault = func() string { return filepath.Join(t.TempDir(), "default-home") }
	t.Cleanup(func() { dataHomeDefault = saved })
}

type commandLog struct {
	mu    sync.Mutex
	calls [][]string
}

func (l *commandLog) run(_ context.Context, name string, args ...string) ([]byte, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	call := append([]string{name}, args...)
	l.calls = append(l.calls, call)
	return []byte("ok"), nil
}

func (l *commandLog) all() [][]string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([][]string(nil), l.calls...)
}

func (l *commandLog) waitFor(t *testing.T, want string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		for _, call := range l.all() {
			if strings.Join(call, " ") == want {
				return
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("没有执行 %q，调用 = %v", want, l.all())
}

func TestStartServiceForCustomDataHomeUsesTransientUnit(t *testing.T) {
	home := filepath.Join(t.TempDir(), "weaver-data")
	customDataHome(t)
	log := &commandLog{}
	saved := runCommand
	runCommand = log.run
	t.Cleanup(func() { runCommand = saved })

	if _, err := startServiceFor(context.Background(), home); err != nil {
		t.Fatal(err)
	}
	calls := log.all()
	if len(calls) != 1 {
		t.Fatalf("调用 %d 次，want 1：%v", len(calls), calls)
	}
	got := calls[0]
	prefix := []string{"systemd-run", "--user", "--unit=" + serviceUnitName(home),
		"--setenv=WEAVER_HOME=" + home}
	if len(got) != len(prefix)+2 {
		t.Fatalf("参数 = %v", got)
	}
	for i := range prefix {
		if got[i] != prefix[i] {
			t.Fatalf("参数[%d] = %q，want %q（全量 %v）", i, got[i], prefix[i], got)
		}
	}
	if filepath.Base(got[len(got)-2]) != "weaver" || got[len(got)-1] != "daemon" {
		t.Fatalf("没有用 weaver daemon 启动：%v", got)
	}
	if unit := serviceUnitName(home); !strings.HasPrefix(unit, "weaver-gui-") || len(unit) > 40 {
		t.Fatalf("单元名不合规：%q", unit)
	}
}

func TestRestartServiceForCustomDataHomeRestartsOnlyThatUnit(t *testing.T) {
	home := filepath.Join(t.TempDir(), "weaver-data")
	customDataHome(t)
	log := &commandLog{}
	saved := runCommand
	runCommand = log.run
	t.Cleanup(func() { runCommand = saved })

	if _, err := restartServiceFor(context.Background(), home); err != nil {
		t.Fatal(err)
	}
	want := "systemctl --user restart " + serviceUnitName(home)
	calls := log.all()
	if len(calls) != 1 || strings.Join(calls[0], " ") != want {
		t.Fatalf("参数 = %v，want %q", calls, want)
	}
	if strings.Contains(strings.Join(calls[0], " "), "weaver.service") {
		t.Fatal("自定义数据目录碰了正式 weaver.service")
	}
}

func TestDefaultDataHomeKeepsSystemService(t *testing.T) {
	home := filepath.Join(t.TempDir(), "weaver-data")
	savedDefault := dataHomeDefault
	dataHomeDefault = func() string { return home }
	t.Cleanup(func() { dataHomeDefault = savedDefault })
	log := &commandLog{}
	saved := runCommand
	runCommand = log.run
	t.Cleanup(func() { runCommand = saved })

	if _, err := startServiceFor(context.Background(), home); err != nil {
		t.Fatal(err)
	}
	if _, err := restartServiceFor(context.Background(), home); err != nil {
		t.Fatal(err)
	}
	calls := log.all()
	if len(calls) != 2 {
		t.Fatalf("调用 = %v", calls)
	}
	if strings.Join(calls[0], " ") != "systemctl --user start weaver.service" {
		t.Fatalf("启动 = %v", calls[0])
	}
	if strings.Join(calls[1], " ") != "systemctl --user restart weaver.service" {
		t.Fatalf("重启 = %v", calls[1])
	}
}

func TestCustomDataDirectorySettings(t *testing.T) {
	f := newAccountService(t)
	a := testApp(t, &f.fakeService)
	customDataHome(t)
	a.mu.Lock()
	a.page = "设置"
	a.mu.Unlock()
	tt := ui.NewTester(a.view, 1280, 900)
	waitFor(t, tt, a, func() bool { return !a.busy["skill:check"] })
	if !tt.HasText("自定义数据目录 " + f.home) {
		t.Fatalf("没有显示自定义数据目录：%q", tt.Texts())
	}
	if tt.HasText("移除用户服务") {
		t.Fatalf("自定义数据目录仍提供移除用户服务：%q", tt.Texts())
	}
	log := &commandLog{}
	saved := runCommand
	runCommand = log.run
	t.Cleanup(func() { runCommand = saved })
	click(t, tt, "重启服务")
	log.waitFor(t, "systemctl --user restart "+serviceUnitName(f.home))
}

func TestCustomDataDirectoryOfflinePageStartsTransientUnit(t *testing.T) {
	f := newFake(t)
	a := testApp(t, f)
	customDataHome(t)
	f.stop()
	a.refresh()
	tt := ui.NewTester(a.view, 1280, 900)
	waitFor(t, tt, a, func() bool { return a.offline })
	if !tt.HasText("自定义数据目录 " + f.home) {
		t.Fatalf("提示页没有显示自定义数据目录：%q", tt.Texts())
	}
	log := &commandLog{}
	saved := runCommand
	runCommand = log.run
	t.Cleanup(func() { runCommand = saved })
	click(t, tt, "启动服务")
	want := "systemd-run --user --unit=" + serviceUnitName(f.home) +
		" --setenv=WEAVER_HOME=" + f.home
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		for _, call := range log.all() {
			joined := strings.Join(call, " ")
			if strings.HasPrefix(joined, want) && strings.HasSuffix(joined, " daemon") {
				if strings.Contains(joined, "weaver.service") {
					t.Fatalf("提示页碰了正式 weaver.service：%q", joined)
				}
				return
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("没有用临时单元启动：%v", log.all())
}

func TestServiceUnitNameIsStableAndDistinct(t *testing.T) {
	a := serviceUnitName("/tmp/weaver-a")
	b := serviceUnitName("/tmp/weaver-b")
	if a != serviceUnitName("/tmp/weaver-a") {
		t.Fatal("同一目录的单元名不稳定")
	}
	if a == b {
		t.Fatalf("不同目录同名：%q", a)
	}
}
