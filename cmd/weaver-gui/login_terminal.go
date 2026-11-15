package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"

	"github.com/egoist/mygo/plugins/terminal"
)

// loginLoadLibrary is a variable so tests can exercise the degraded command
// box without a native terminal library. Production code keeps the default.
var loginLoadLibrary = terminal.Load

// startLoginTerminal runs `weaver account login <id>` in a pseudo-terminal.
// The caller sets the panel and its open flag first, so an exit that comes
// before the first frame still finds the panel. A non-nil error means the
// caller must show the degraded command box instead.
func (a *app) startLoginTerminal(p *loginPanel) error {
	if err := loginLoadLibrary(); err != nil {
		return fmt.Errorf("无法加载终端库：%w", err)
	}
	weaver, err := resolveWeaverCommand()
	if err != nil {
		return err
	}
	term, err := terminal.New(terminal.Options{
		Command: []string{weaver, "account", "login", p.ID},
		Cursor:  terminal.CursorBar,
		NoBlink: true,
		OnExit:  func(code int) { a.loginCommandExited(p, code) },
	})
	if err != nil {
		return fmt.Errorf("无法启动内嵌终端：%w", err)
	}
	p.Term = term
	a.wg.Add(1)
	go func() {
		defer a.wg.Done()
		select {
		case <-a.ctx.Done():
			// 应用退出时也结束登录命令，避免留下子进程。
			p.closing.Store(true)
			term.Close()
		case <-term.Done():
		}
	}()
	return nil
}

// resolveWeaverCommand prefers a weaver beside this executable, then PATH.
func resolveWeaverCommand() (string, error) {
	names := []string{"weaver"}
	if runtime.GOOS == "windows" {
		names = []string{"weaver.exe", "weaver"}
	}
	if exe, err := os.Executable(); err == nil {
		dir := filepath.Dir(exe)
		for _, name := range names {
			path := filepath.Join(dir, name)
			info, err := os.Stat(path)
			if err != nil || info.IsDir() {
				continue
			}
			if runtime.GOOS == "windows" || info.Mode()&0o111 != 0 {
				return path, nil
			}
		}
	}
	for _, name := range names {
		if path, err := exec.LookPath(name); err == nil {
			return path, nil
		}
	}
	return "", fmt.Errorf("找不到 weaver 命令：请把 weaver 放在应用同目录，或加进 PATH")
}

// loginCommandExited marks the command finished and checks the account once.
// It runs on a goroutine of the terminal, so every UI field is changed under
// a.mu. Closing the dialog first sets p.closing, and this then does nothing:
// a login that the user stopped must not turn ready behind their back.
func (a *app) loginCommandExited(p *loginPanel, code int) {
	if p.closing.Load() {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.ctx.Err() != nil || p.closing.Load() {
		return
	}
	p.Finished = true
	p.ExitCode = code

	st := accountsFor(a)
	if st.login != p || !st.loginOpen || p.CheckStarted {
		a.notify()
		return
	}
	p.CheckStarted = true
	a.action(loginCheckKey(p.ID), func() (string, error) {
		err := a.client.call("account.check", map[string]string{"id": p.ID}, nil)
		if err == nil {
			a.refresh()
		}
		return "", err
	}, func(_ string, _ error) {
		p.CheckDone = true
	})
	a.notify()
}
