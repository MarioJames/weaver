package main

import (
	"context"
	"encoding/json"
	"errors"
	"image/png"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/MarioJames/weaver/internal/rpc"
	"github.com/egoist/mygo/plugins/terminal"
	"github.com/egoist/mygo/ui"
)

// loginService is a fake service with just the calls the login dialog makes.
// A check flips the first account to ready, which lets the test see the status
// change without any real sign-in.
type loginService struct {
	fakeService
	checks       int
	checkIDs     []string
	readyOnCheck bool
}

func newLoginService(t *testing.T) *loginService {
	t.Helper()
	dir := t.TempDir()
	s := &loginService{fakeService: fakeService{home: dir, data: fixture(dir)}, readyOnCheck: true}
	s.data.Accounts[0].ID = "import_e6f3c04da52965f2b7c02668"
	s.data.Accounts[0].Ready = false
	s.data.Accounts[0].ReadyReason = "凭据已过期"
	for i := 1; i < len(s.data.Accounts); i++ {
		s.data.Accounts[i].Enabled = true
		s.data.Accounts[i].Ready = true
		s.data.Accounts[i].ReadyReason = ""
	}
	listener, err := net.Listen("unix", rpc.SocketPath(dir))
	if err != nil {
		t.Fatal(err)
	}
	s.listener = listener
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			s.wg.Add(1)
			go func() {
				defer s.wg.Done()
				defer conn.Close()
				conn.SetDeadline(time.Now().Add(time.Second))
				var req rpc.Request
				if json.NewDecoder(conn).Decode(&req) != nil {
					return
				}
				s.respond(conn, req)
			}()
		}
	}()
	t.Cleanup(s.stop)
	return s
}

func (s *loginService) respond(conn net.Conn, req rpc.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var result any
	var failure *rpc.Error
	switch req.Method {
	case "status":
		result = s.data
	case "account.list":
		result = s.data.Accounts
	case "account.check":
		var p struct{ ID string }
		json.Unmarshal(req.Params, &p)
		s.checks++
		s.checkIDs = append(s.checkIDs, p.ID)
		if p.ID == "" {
			result = s.data.Accounts
			break
		}
		var acc *account
		for i := range s.data.Accounts {
			if s.data.Accounts[i].ID == p.ID {
				acc = &s.data.Accounts[i]
				break
			}
		}
		if acc == nil {
			failure = &rpc.Error{Code: "NOT_FOUND", Message: "账号不存在"}
			break
		}
		if s.readyOnCheck {
			acc.Ready = true
			acc.ReadyReason = ""
		}
		result = acc
	default:
		failure = &rpc.Error{Code: "NOT_FOUND", Message: "未知方法"}
	}
	body, _ := json.Marshal(result)
	json.NewEncoder(conn).Encode(rpc.Response{OK: failure == nil, Result: body, Error: failure})
}

func loginTestOpen(t *testing.T, s *loginService) (*app, *ui.Tester) {
	t.Helper()
	a := testApp(t, &s.fakeService)
	tt := ui.NewTester(a.view, 1280, 900)
	click(t, tt, "账号")
	return a, tt
}

func requireLoginTerminal(t *testing.T) {
	t.Helper()
	if err := terminal.Load(); err != nil {
		t.Skipf("内嵌终端不可用：%v", err)
	}
	path, err := terminal.LibraryPath()
	if err != nil {
		t.Skipf("内嵌终端不可用：%v", err)
	}
	if info, err := os.Stat(path); err == nil {
		t.Logf("libghostty-vt: %s（%d 字节）", path, info.Size())
	}
}

// installFakeWeaver puts a substitute weaver first in PATH. It never signs in
// to a real account; the script only records its arguments and pid, prints a
// line, then sleeps.
func installFakeWeaver(t *testing.T, body string) {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "weaver")
	script := "#!/bin/sh\n" + body + "\n"
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

func readLoginPID(t *testing.T, path string) int {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	pid, _ := strconv.Atoi(strings.TrimSpace(string(data)))
	return pid
}

func loginProcessAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

func stubLoginLibraryFailure(t *testing.T) {
	t.Helper()
	saved := loginLoadLibrary
	loginLoadLibrary = func() error { return errors.New("测试：终端库不可用") }
	t.Cleanup(func() { loginLoadLibrary = saved })
}

func TestLoginTerminalAutoCheck(t *testing.T) {
	requireLoginTerminal(t)
	s := newLoginService(t)
	argsFile := filepath.Join(t.TempDir(), "args")
	pidFile := filepath.Join(t.TempDir(), "pid")
	finishFile := filepath.Join(t.TempDir(), "finish")
	t.Setenv("LOGIN_ARGS_FILE", argsFile)
	t.Setenv("LOGIN_PID_FILE", pidFile)
	t.Setenv("LOGIN_FINISH_FILE", finishFile)
	installFakeWeaver(t, `
printf '%s\n' "$@" > "$LOGIN_ARGS_FILE"
echo "在账号 import_e6f3c04da52965f2b7c02668 的认证目录里运行：claude …"
echo $$ > "$LOGIN_PID_FILE"
while [ ! -e "$LOGIN_FINISH_FILE" ]; do sleep 0.05; done
exit 0
`)
	a, tt := loginTestOpen(t, s)
	readyBefore := countText(tt, "就绪")

	openAccountMore(t, tt, "Claude 5x Max")
	click(t, tt, "登录 Claude 5x Max")
	if !tt.HasText("登录 Claude 5x Max") {
		t.Fatalf("登录框没有标题：%q", tt.Texts())
	}
	if countText(tt, "未就绪") != 1 || !tt.HasText("凭据已过期") {
		t.Fatalf("登录框没有显示当前状态：%q", tt.Texts())
	}
	waitFor(t, tt, a, func() bool {
		p := accountsFor(a).login
		return p != nil && p.Term != nil && strings.Contains(p.Term.Text(), "在账号")
	})

	args, err := os.ReadFile(argsFile)
	if err != nil {
		t.Fatalf("替身命令没有收到参数：%v", err)
	}
	if got := strings.Fields(string(args)); len(got) != 3 || got[0] != "account" || got[1] != "login" || got[2] != "import_e6f3c04da52965f2b7c02668" {
		t.Fatalf("替身命令参数不对：%q", got)
	}

	if err := os.WriteFile(finishFile, []byte("1"), 0o644); err != nil {
		t.Fatal(err)
	}
	waitFor(t, tt, a, func() bool {
		p := accountsFor(a).login
		return p != nil && p.Finished && p.CheckDone
	})
	s.mu.Lock()
	checks, ids := s.checks, append([]string(nil), s.checkIDs...)
	s.mu.Unlock()
	if checks != 1 || len(ids) != 1 || ids[0] != "import_e6f3c04da52965f2b7c02668" {
		t.Fatalf("退出后没有自动检查：checks=%d ids=%v", checks, ids)
	}
	a.mu.Lock()
	ready := false
	for _, acc := range a.snapshot.Accounts {
		if acc.ID == "import_e6f3c04da52965f2b7c02668" {
			ready = acc.Ready
		}
	}
	a.mu.Unlock()
	if !ready {
		t.Fatal("检查后账号没有变成就绪")
	}
	if !tt.HasText("登录命令已结束") {
		t.Fatalf("登录框没有显示命令结束：%q", tt.Texts())
	}
	if countText(tt, "未就绪") != 0 {
		t.Fatalf("检查后登录框仍显示未就绪：%q", tt.Texts())
	}
	if countText(tt, "就绪") <= readyBefore {
		t.Fatalf("检查后没有出现新的就绪状态：%q", tt.Texts())
	}
	click(t, tt, "关闭")
	if accountsFor(a).loginOpen || accountsFor(a).login != nil {
		t.Fatal("关闭后登录框仍然打开")
	}
}

func TestLoginCloseEndsCommand(t *testing.T) {
	requireLoginTerminal(t)
	s := newLoginService(t)
	pidFile := filepath.Join(t.TempDir(), "pid")
	t.Setenv("LOGIN_PID_FILE", pidFile)
	installFakeWeaver(t, `
echo "在账号 import_e6f3c04da52965f2b7c02668 的认证目录里运行：claude …"
echo $$ > "$LOGIN_PID_FILE"
exec sleep 60
`)
	a, tt := loginTestOpen(t, s)
	openAccountMore(t, tt, "Claude 5x Max")
	click(t, tt, "登录 Claude 5x Max")
	waitFor(t, tt, a, func() bool {
		p := accountsFor(a).login
		return p != nil && p.Term != nil && readLoginPID(t, pidFile) != 0 &&
			strings.Contains(p.Term.Text(), "在账号")
	})
	pid := readLoginPID(t, pidFile)
	if !loginProcessAlive(pid) {
		t.Fatalf("替身登录进程没有启动：%d", pid)
	}

	click(t, tt, "关闭")
	waitFor(t, tt, a, func() bool { return !loginProcessAlive(pid) })
	a.mu.Lock()
	open := accountsFor(a).loginOpen
	login := accountsFor(a).login
	ready := false
	for _, acc := range a.snapshot.Accounts {
		if acc.ID == "import_e6f3c04da52965f2b7c02668" {
			ready = acc.Ready
		}
	}
	a.mu.Unlock()
	if open || login != nil {
		t.Fatal("关闭后登录框仍然打开")
	}
	if ready {
		t.Fatal("中途关闭登录框后账号却被标成就绪")
	}
	s.mu.Lock()
	checks := s.checks
	s.mu.Unlock()
	if checks != 0 {
		t.Fatalf("中途关闭不应检查账号：checks=%d", checks)
	}

	// A closed login can be opened again.
	openAccountMore(t, tt, "Claude 5x Max")
	click(t, tt, "登录 Claude 5x Max")
	waitFor(t, tt, a, func() bool {
		p := accountsFor(a).login
		next := readLoginPID(t, pidFile)
		return p != nil && p.Term != nil && next != 0 && next != pid
	})
	next := readLoginPID(t, pidFile)
	click(t, tt, "关闭")
	waitFor(t, tt, a, func() bool { return !loginProcessAlive(next) })
}

func TestLoginFallbackWhenTerminalLibraryFails(t *testing.T) {
	s := newLoginService(t)
	stubLoginLibraryFailure(t)
	a, tt := loginTestOpen(t, s)
	openAccountMore(t, tt, "Claude 5x Max")
	click(t, tt, "登录 Claude 5x Max")
	if !tt.HasText("内嵌终端不可用：无法加载终端库：测试：终端库不可用") {
		t.Fatalf("降级框没有说明原因：%q", tt.Texts())
	}
	if !tt.HasText("在终端里运行：") || !tt.HasText("weaver account login import_e6f3c04da52965f2b7c02668") {
		t.Fatalf("降级框没有命令：%q", tt.Texts())
	}
	if !tt.HasText("复制命令") || !tt.HasText("我已登录，重新检查") || !tt.HasText("关闭") {
		t.Fatalf("降级框缺少按钮：%q", tt.Texts())
	}
	a.mu.Lock()
	p := accountsFor(a).login
	a.mu.Unlock()
	if p == nil || p.Term != nil {
		t.Fatal("降级框不应启动终端")
	}
	time.Sleep(200 * time.Millisecond)
	s.mu.Lock()
	checks := s.checks
	s.mu.Unlock()
	if checks != 0 {
		t.Fatalf("降级框不应自动检查：checks=%d", checks)
	}

	click(t, tt, "我已登录，重新检查")
	waitFor(t, tt, a, func() bool {
		return accountsFor(a).login == nil && !accountsFor(a).loginOpen
	})
	s.mu.Lock()
	checks = s.checks
	s.mu.Unlock()
	if checks != 1 {
		t.Fatalf("手动重新检查没有调用 account.check：checks=%d", checks)
	}
}

func TestLoginScreenshot(t *testing.T) {
	dir := os.Getenv("WEAVER_LOGIN_SCREENSHOTS")
	if dir == "" {
		t.Skip("未设置截图目录")
	}
	requireLoginTerminal(t)
	s := newLoginService(t)
	pidFile := filepath.Join(t.TempDir(), "pid")
	t.Setenv("LOGIN_PID_FILE", pidFile)
	installFakeWeaver(t, `
echo "在账号 import_e6f3c04da52965f2b7c02668 的认证目录里运行：claude …"
echo "（Claude 的登录流程，在这个框里交互）"
echo $$ > "$LOGIN_PID_FILE"
exec sleep 30
`)
	a, tt := loginTestOpen(t, s)
	openAccountMore(t, tt, "Claude 5x Max")
	click(t, tt, "登录 Claude 5x Max")
	waitFor(t, tt, a, func() bool {
		p := accountsFor(a).login
		return p != nil && p.Term != nil && strings.Contains(p.Term.Text(), "（Claude 的登录流程")
	})
	tt.Advance(time.Second)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	file, err := os.Create(filepath.Join(dir, "login.png"))
	if err != nil {
		t.Fatal(err)
	}
	err = png.Encode(file, tt.Image())
	file.Close()
	if err != nil {
		t.Fatal(err)
	}
	pid := readLoginPID(t, pidFile)
	click(t, tt, "关闭")
	waitFor(t, tt, a, func() bool { return !loginProcessAlive(pid) })
}

// TestLoginLinkIsOfferedNotOpened covers A9–A12: the sign-in command's
// attempt to open a browser, through $BROWSER or xdg-open on PATH, lands in
// the dialog instead; the user opens or copies it, and closing the dialog
// removes the catcher.
func TestLoginLinkIsOfferedNotOpened(t *testing.T) {
	requireLoginTerminal(t)
	s := newLoginService(t)
	step := filepath.Join(t.TempDir(), "step")
	t.Setenv("LOGIN_STEP_FILE", step)
	installFakeWeaver(t, `
echo "Opening browser to sign in…"
while [ ! -e "$LOGIN_STEP_FILE" ]; do sleep 0.05; done
"$BROWSER" 'https://claude.com/cai/oauth/authorize?code=true&state=one'
while [ "$(cat "$LOGIN_STEP_FILE")" != 2 ]; do sleep 0.05; done
xdg-open 'https://auth.openai.com/oauth/authorize?state=two'
sleep 30
`)

	a, tt := loginTestOpen(t, s)
	// testApp stubs runCommand; record the browser call on top of it.
	var openedMu sync.Mutex
	var opened []string
	runCommand = func(_ context.Context, name string, args ...string) ([]byte, error) {
		openedMu.Lock()
		defer openedMu.Unlock()
		opened = append(opened, name+" "+strings.Join(args, " "))
		return nil, nil
	}
	openAccountMore(t, tt, "Claude 5x Max")
	click(t, tt, "登录 Claude 5x Max")
	waitFor(t, tt, a, func() bool {
		p := accountsFor(a).login
		return p != nil && p.Term != nil && strings.Contains(p.Term.Text(), "Opening browser")
	})
	if !tt.HasText("等待登录命令给出链接…") {
		t.Fatalf("链接出来前没有等待提示：%q", tt.Texts())
	}
	p := accountsFor(a).login
	dir := p.linkDir

	first := "https://claude.com/cai/oauth/authorize?code=true&state=one"
	os.WriteFile(step, []byte("1"), 0o644)
	waitFor(t, tt, a, func() bool { return p.Link == first })
	if !tt.HasText(first) || !tt.HasText("在浏览器打开") {
		t.Fatalf("弹窗没有显示链接：%q", tt.Texts())
	}
	click(t, tt, "复制链接")
	if tt.Clipboard() != first || !tt.HasText("已复制链接") {
		t.Fatalf("剪贴板 %q，提示 %q", tt.Clipboard(), tt.Texts())
	}

	second := "https://auth.openai.com/oauth/authorize?state=two"
	os.WriteFile(step, []byte("2"), 0o644)
	waitFor(t, tt, a, func() bool { return p.Link == second })
	click(t, tt, "在浏览器打开")
	waitFor(t, tt, a, func() bool {
		openedMu.Lock()
		defer openedMu.Unlock()
		return len(opened) > 0
	})
	openedMu.Lock()
	if len(opened) != 1 || opened[0] != "xdg-open "+second {
		t.Fatalf("打开浏览器的调用不对：%q", opened)
	}
	openedMu.Unlock()

	click(t, tt, "关闭")
	waitFor(t, tt, a, func() bool {
		_, err := os.Stat(dir)
		return os.IsNotExist(err)
	})
}
