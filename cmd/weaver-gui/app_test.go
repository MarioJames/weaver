package main

import (
	"context"
	"encoding/json"
	"fmt"
	"image/png"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/MarioJames/weaver/internal/rpc"
	"github.com/egoist/mygo/ui"
)

type fakeService struct {
	mu       sync.Mutex
	home     string
	data     snapshot
	listener net.Listener
	wg       sync.WaitGroup
}

func fixture(home string) snapshot {
	s := snapshot{Version: "2.0.0", PID: 386116, StartedAt: time.Now().Add(-5 * time.Hour).UnixMilli(), Home: home, Settings: map[string]string{"max_parallel": "32", "stall_seconds": "300", "quota_refresh_minutes": "5", "resident": "on", "standby": "on"}, Overview: overview{Capacity: 32, Missions: 2, Timers: 3}}
	labels := []string{"Claude 5x Max", "ChatGPT Pro 5x", "opencode no••@gmail.com", "opencode im••@gmail.com / Default", "dsh deepseek-official", "OpenAI API（dsh）", "Anthropic API（dsh）"}
	for i, label := range labels {
		engine, kind := "dsh", "api"
		if i == 0 {
			engine, kind = "claude", "subscription"
		}
		if i == 1 {
			engine, kind = "codex", "subscription"
		}
		if i == 2 || i == 3 {
			engine, kind = "opencode", "subscription"
		}
		s.Accounts = append(s.Accounts, account{ID: fmt.Sprintf("a%d", i), Label: label, Engine: engine, Kind: kind, Enabled: i != 3, Ready: i != 3})
	}
	for i, id := range []string{"a0", "a1", "a2", "a2", "a5", "a6"} {
		s.Workers = append(s.Workers, worker{ID: fmt.Sprintf("w%d", i), Accounts: []string{id}, Enabled: true, Available: true, Intelligence: 1})
	}
	s.Residents = []resident{{AccountID: "a2", State: "ready", Port: 45571, Sessions: 0}}
	return s
}
func newFake(t *testing.T) *fakeService {
	t.Helper()
	dir := t.TempDir()
	f := &fakeService{home: dir, data: fixture(dir)}
	f.start(t)
	t.Cleanup(f.stop)
	return f
}
func (f *fakeService) start(t *testing.T) {
	t.Helper()
	listener, err := net.Listen("unix", rpc.SocketPath(f.home))
	if err != nil {
		t.Fatal(err)
	}
	f.listener = listener
	f.wg.Add(1)
	go func() {
		defer f.wg.Done()
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			f.wg.Add(1)
			go func() {
				defer f.wg.Done()
				defer conn.Close()
				conn.SetDeadline(time.Now().Add(time.Second))
				var req rpc.Request
				if json.NewDecoder(conn).Decode(&req) != nil {
					return
				}
				f.respond(conn, req)
			}()
		}
	}()
}
func (f *fakeService) stop() {
	if f.listener != nil {
		f.listener.Close()
		f.wg.Wait()
		f.listener = nil
	}
	os.Remove(rpc.SocketPath(f.home))
}
func (f *fakeService) respond(conn net.Conn, req rpc.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var result any
	var failure *rpc.Error
	switch req.Method {
	case "status":
		result = f.data
	case "engine.list":
		result = f.data.Residents
	case "config.set":
		var p struct{ Key, Value string }
		json.Unmarshal(req.Params, &p)
		if p.Key == "stall_seconds" && p.Value == "0" {
			failure = &rpc.Error{Code: "INVALID", Message: "stall_seconds 需要正整数"}
		} else {
			f.data.Settings[p.Key] = p.Value
			if p.Key == "max_parallel" {
				fmt.Sscan(p.Value, &f.data.Overview.Capacity)
			}
			result = f.data.Settings
		}
	case "engine.stop", "engine.start":
		var p struct{ Account string }
		json.Unmarshal(req.Params, &p)
		if req.Method == "engine.stop" {
			var remaining []resident
			for _, r := range f.data.Residents {
				if r.AccountID != p.Account {
					remaining = append(remaining, r)
				}
			}
			f.data.Residents = remaining
		} else {
			f.data.Residents = append(f.data.Residents, resident{AccountID: p.Account, State: "ready", Port: 45571})
		}
		result = f.data.Residents
	case "backup":
		result = map[string]string{"path": filepath.Join(f.home, "backups", "weaver.db")}
	default:
		failure = &rpc.Error{Code: "NOT_FOUND", Message: "未知方法"}
	}
	body, _ := json.Marshal(result)
	json.NewEncoder(conn).Encode(rpc.Response{OK: failure == nil, Result: body, Error: failure})
}
func testApp(t *testing.T, f *fakeService) *app {
	t.Helper()
	t.Setenv("WEAVER_HOME", f.home)
	t.Setenv("HOME", t.TempDir())
	saved := runCommand
	runCommand = func(_ context.Context, name string, args ...string) ([]byte, error) {
		return []byte("技能内容\n"), nil
	}
	// The fake service's temporary home stands in for the default data
	// directory, so the existing tests exercise the weaver.service path.
	savedDefault := dataHomeDefault
	dataHomeDefault = func() string { return f.home }
	a := newApp()
	a.refresh()
	t.Cleanup(func() { a.close(); a.wg.Wait(); runCommand = saved; dataHomeDefault = savedDefault })
	return a
}
func waitFor(t *testing.T, tt *ui.Tester, a *app, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		tt.Frame()
		a.mu.Lock()
		ok := condition()
		a.mu.Unlock()
		if ok {
			tt.Frame()
			return
		}
		// Socket IO and background goroutines use wall time; the tester clock only
		// advances animations and timers. Yield through a short timer between frames.
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("等待异步结果超时，页面文本：%q", tt.Texts())
}
func click(t *testing.T, tt *ui.Tester, label string) {
	t.Helper()
	if err := tt.Click(label); err != nil {
		t.Fatal(err)
	}
	tt.Advance(time.Second)
}
func edit(t *testing.T, tt *ui.Tester, label, value string, submit bool) {
	t.Helper()
	click(t, tt, label)
	tt.Key(ui.Ctrl, ui.KeyA)
	tt.Type(value)
	if submit {
		tt.Key(0, ui.KeyEnter)
	}
}
func TestOverview(t *testing.T) {
	f := newFake(t)
	a := testApp(t, f)
	tt := ui.NewTester(a.view, 1280, 820)
	for _, text := range []string{"0 / 32", "2", "3", "6 / 7", "6 / 6", "2 个账号没有候选在用", "opencode im••@gmail.com / Default 未就绪"} {
		if !tt.HasText(text) {
			t.Errorf("缺少 %q，页面 %q", text, tt.Texts())
		}
	}
	f.mu.Lock()
	for i := range f.data.Workers {
		f.data.Workers[i].Intelligence = 0
	}
	alertBelow := 5.0
	f.data.Accounts[0].Usage = &usage{Low: true, AlertBelow: &alertBelow}
	f.mu.Unlock()
	a.refresh()
	tt.Frame()
	if !tt.HasText("没有能力分大于 0 的候选") || !tt.HasText("Claude 5x Max 估算剩余低于 $5") {
		t.Fatalf("缺少告警：%q", tt.Texts())
	}
}
func TestSettingsSaveAndRejection(t *testing.T) {
	f := newFake(t)
	a := testApp(t, f)
	tt := ui.NewTester(a.view, 1280, 820)
	click(t, tt, "设置")
	edit(t, tt, "全局并行上限", "16", true)
	waitFor(t, tt, a, func() bool { return !a.busy["config:max_parallel"] && a.snapshot.Settings["max_parallel"] == "16" })
	click(t, tt, "概览")
	if !tt.HasText("0 / 16") {
		t.Fatal(tt.Texts())
	}
	click(t, tt, "设置")
	edit(t, tt, "卡住判定", "0", true)
	waitFor(t, tt, a, func() bool { return a.fields["stall_seconds"].err != "" && !a.busy["config:stall_seconds"] })
	if !tt.HasText("stall_seconds 需要正整数") {
		t.Fatal(tt.Texts())
	}
	a.mu.Lock()
	got := a.fields["stall_seconds"].value
	a.mu.Unlock()
	if got != "300" {
		t.Fatalf("拒绝后未恢复：%s", got)
	}
	f.mu.Lock()
	stored := f.data.Settings["stall_seconds"]
	f.mu.Unlock()
	if stored != "300" {
		t.Fatal(stored)
	}
	edit(t, tt, "卡住判定", "600", false)
	click(t, tt, "全局并行上限")
	waitFor(t, tt, a, func() bool { return a.snapshot.Settings["stall_seconds"] == "600" })
	click(t, tt, "claude 待命")
	waitFor(t, tt, a, func() bool { return a.snapshot.Settings["standby"] == "off" })
	edit(t, tt, "额度刷新间隔", "30", true)
	waitFor(t, tt, a, func() bool {
		return !a.busy["config:quota_refresh_minutes"] && a.snapshot.Settings["quota_refresh_minutes"] == "30"
	})
}
func TestEngineStopStart(t *testing.T) {
	f := newFake(t)
	a := testApp(t, f)
	tt := ui.NewTester(a.view, 1280, 820)
	click(t, tt, "设置")
	click(t, tt, "停止")
	waitFor(t, tt, a, func() bool { return len(a.snapshot.Residents) == 0 && !a.busy["engine:a2"] })
	if !tt.HasText("启动") {
		t.Fatal(tt.Texts())
	}
	click(t, tt, "启动")
	waitFor(t, tt, a, func() bool { return len(a.snapshot.Residents) == 1 && !a.busy["engine:a2"] })
	if !tt.HasText("就绪") || !tt.HasText("停止") {
		t.Fatal(tt.Texts())
	}
}
func TestUnavailableRecoversPage(t *testing.T) {
	f := newFake(t)
	a := testApp(t, f)
	tt := ui.NewTester(a.view, 1280, 820)
	click(t, tt, "候选")
	a.start()
	waitFor(t, tt, a, func() bool { return a.loaded })
	f.stop()
	waitFor(t, tt, a, func() bool { return a.offline })
	if !tt.HasText("Weaver 服务没有运行") || tt.HasText("即将提供") {
		t.Fatal(tt.Texts())
	}
	var commandMu sync.Mutex
	var calls []string
	runCommand = func(_ context.Context, name string, args ...string) ([]byte, error) {
		commandMu.Lock()
		defer commandMu.Unlock()
		calls = append(calls, filepath.Base(name)+" "+strings.Join(args, " "))
		return nil, nil
	}
	click(t, tt, "启动服务")
	waitFor(t, tt, a, func() bool { return !a.busy["service:start"] })
	f.start(t)
	waitFor(t, tt, a, func() bool { return !a.offline })
	if !tt.HasText("新建候选") {
		t.Fatal(tt.Texts())
	}
	a.mu.Lock()
	page := a.page
	a.mu.Unlock()
	if page != "候选" {
		t.Fatal(page)
	}
	commandMu.Lock()
	defer commandMu.Unlock()
	if len(calls) != 1 || calls[0] != "systemctl --user start weaver.service" {
		t.Fatal(calls)
	}
}
func TestExternalCommandFailuresAndInstallFallback(t *testing.T) {
	f := newFake(t)
	a := testApp(t, f)
	runCommand = func(_ context.Context, name string, args ...string) ([]byte, error) {
		if name == "systemctl" {
			return []byte("Failed to start weaver.service: Unit weaver.service not found."), fmt.Errorf("exit 5")
		}
		if strings.Join(args, " ") != "service install" {
			t.Errorf("unexpected args %q", args)
		}
		return []byte("已安装"), nil
	}
	if _, err := startService(context.Background()); err != nil {
		t.Fatal(err)
	}
	runCommand = func(_ context.Context, name string, args ...string) ([]byte, error) {
		return []byte("命令错误详情"), fmt.Errorf("exit 1")
	}
	a.mu.Lock()
	a.page = "设置"
	a.mu.Unlock()
	tt := ui.NewTester(a.view, 1280, 820)
	click(t, tt, "重启服务")
	waitFor(t, tt, a, func() bool { return !a.busy["service:restart"] && a.errors["service:restart"] != "" })
	if !tt.HasText("命令错误详情") {
		t.Fatal(tt.Texts())
	}
}
func TestResponsiveNavigation(t *testing.T) {
	f := newFake(t)
	a := testApp(t, f)
	tt := ui.NewTester(a.view, 800, 820)
	nav, ok := tt.Find("设置")
	if !ok {
		t.Fatal("缺少设置导航")
	}
	content, ok := tt.Find("并行占用")
	if !ok {
		t.Fatal("缺少概览")
	}
	if nav.Y >= content.Y {
		t.Fatalf("窄窗口导航没有移到顶部：%+v %+v", nav, content)
	}
	click(t, tt, "设置")
	edit(t, tt, "全局并行上限", "16", true)
	waitFor(t, tt, a, func() bool { return a.snapshot.Settings["max_parallel"] == "16" })
}
func TestScreenshots(t *testing.T) {
	dir := os.Getenv("WEAVER_GUI_SCREENSHOTS")
	if dir == "" {
		t.Skip("未设置截图目录")
	}
	f := newFake(t)
	a := testApp(t, f)
	tt := ui.NewTester(a.view, 1280, 820)
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	for _, page := range []string{"概览", "设置"} {
		click(t, tt, page)
		if page == "设置" {
			waitFor(t, tt, a, func() bool { return !a.busy["skill:check"] })
		}
		name := "overview.png"
		if page == "设置" {
			name = "settings.png"
		}
		file, err := os.Create(filepath.Join(dir, name))
		if err != nil {
			t.Fatal(err)
		}
		err = png.Encode(file, tt.Image())
		file.Close()
		if err != nil {
			t.Fatal(err)
		}
	}
}

func TestSkillInstallAndBackup(t *testing.T) {
	f := newFake(t)
	a := testApp(t, f)
	skillPath := filepath.Join(os.Getenv("HOME"), ".agents", "skills", "agents-weaver", "SKILL.md")
	runCommand = func(_ context.Context, name string, args ...string) ([]byte, error) {
		if strings.Join(args, " ") == "skill install" {
			if err := os.MkdirAll(filepath.Dir(skillPath), 0755); err != nil {
				return nil, err
			}
			if err := os.WriteFile(skillPath, []byte("技能内容\n"), 0644); err != nil {
				return nil, err
			}
		}
		return []byte("技能内容\n"), nil
	}
	tt := ui.NewTester(a.view, 1280, 820)
	click(t, tt, "设置")
	waitFor(t, tt, a, func() bool { return !a.busy["skill:check"] && a.skillState == "未安装" })
	click(t, tt, "安装")
	waitFor(t, tt, a, func() bool { return !a.busy["skill:install"] && !a.busy["skill:check"] && a.skillState == "已安装" })
	if err := os.WriteFile(skillPath, []byte("旧版技能"), 0644); err != nil {
		t.Fatal(err)
	}
	a.mu.Lock()
	a.checkSkill()
	a.mu.Unlock()
	waitFor(t, tt, a, func() bool { return !a.busy["skill:check"] && a.skillState == "需要更新" })
	click(t, tt, "立即备份")
	waitFor(t, tt, a, func() bool { return !a.busy["backup"] && strings.Contains(a.toast, "backups") })
	if !tt.HasText(filepath.Join(f.home, "backups", "weaver.db")) {
		t.Fatal(tt.Texts())
	}
}

func TestUninstallConfirmationAndBusyButton(t *testing.T) {
	f := newFake(t)
	a := testApp(t, f)
	entered := make(chan string, 1)
	release := make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	t.Cleanup(unblock)
	runCommand = func(ctx context.Context, name string, args ...string) ([]byte, error) {
		entered <- strings.Join(args, " ")
		select {
		case <-release:
			return nil, nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	a.mu.Lock()
	a.page = "设置"
	a.mu.Unlock()
	tt := ui.NewTester(a.view, 1280, 820)
	click(t, tt, "移除用户服务")
	select {
	case <-entered:
		t.Fatal("确认前执行了移除命令")
	default:
	}
	click(t, tt, "取消")
	click(t, tt, "移除用户服务")
	click(t, tt, "确认移除")
	select {
	case args := <-entered:
		if args != "service uninstall" {
			t.Fatal(args)
		}
	case <-time.After(time.Second):
		t.Fatal("没有调用卸载命令")
	}
	tt.Frame()
	if !tt.HasText("移除用户服务中…") {
		t.Fatal(tt.Texts())
	}
	if err := tt.Click("移除用户服务中…"); err == nil {
		// Disabled controls can be hit-tested, but cannot run the command again.
		select {
		case <-entered:
			t.Fatal("执行中按钮重复提交")
		default:
		}
	}
	unblock()
	waitFor(t, tt, a, func() bool { return !a.busy["service:uninstall"] })
}
