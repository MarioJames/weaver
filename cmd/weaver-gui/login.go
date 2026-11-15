package main

import (
	"fmt"
	"strings"
	"sync/atomic"

	"github.com/egoist/mygo/plugins/terminal"
	"github.com/egoist/mygo/ui"
	"github.com/lobehub/lobe-mygo/pkg/action"
	"github.com/lobehub/lobe-mygo/pkg/display"
	"github.com/lobehub/lobe-mygo/pkg/feedback"
	"github.com/lobehub/lobe-mygo/pkg/theme"
)

// loginPanel is the accounts page's login dialog: an embedded terminal
// running `weaver account login <id>`, or the degraded command box when the
// native terminal library cannot load. The accounts page only calls
// openLogin, so the dialog can change without touching the table.
type loginPanel struct {
	ID      string
	Label   string
	Ready   bool
	Reason  string
	Command string
	Term    *terminal.Terminal
	// Fallback is the reason the embedded terminal is unavailable; the body
	// then shows the command, a copy button and a manual re-check.
	Fallback     string
	ExitCode     int
	Finished     bool
	CheckStarted bool
	CheckDone    bool
	// closing is set before the terminal is hung up. The exit callback then
	// leaves the account as it was instead of checking it.
	closing atomic.Bool
}

func loginCheckKey(id string) string { return "account:login-check:" + id }

func (a *app) openLogin(acc account) {
	st := accountsFor(a)
	if st.login != nil {
		a.closeLogin(st.login)
	}
	p := &loginPanel{
		ID:      acc.ID,
		Label:   accountLabel(acc),
		Ready:   acc.Ready,
		Reason:  acc.ReadyReason,
		Command: "weaver account login " + acc.ID,
	}
	// Set the panel before starting the program: an exit may come before the
	// first frame draws the terminal.
	st.login = p
	st.loginOpen = true
	if err := a.startLoginTerminal(p); err != nil {
		p.Term = nil
		p.Fallback = err.Error()
	}
}

// closeLogin ends the login process and closes the dialog. It runs with a.mu
// held; the exit callback checks closing before it takes a.mu, so closing a
// terminal that never started cannot deadlock.
func (a *app) closeLogin(p *loginPanel) {
	if p == nil {
		return
	}
	st := accountsFor(a)
	if st.login == p {
		st.loginOpen = false
		st.login = nil
	}
	p.closing.Store(true)
	if p.Term != nil {
		term := p.Term
		p.Term = nil
		term.Close()
	}
}

func (a *app) loginView(c *ui.Context) {
	st := accountsFor(a)
	if !st.loginOpen || st.login == nil {
		return
	}
	p := st.login
	open := true
	width, _ := c.Size()
	modalWidth := float32(720)
	if width > 0 && width-32 < modalWidth {
		modalWidth = width - 32
	}
	feedback.Modal(c, &open, feedback.ModalProps{
		Title:    "登录 " + p.Label,
		Width:    modalWidth,
		NoFooter: true,
	}, func() {
		ui.Column(c).Gap(12).Children(func() {
			ui.Row(c).Gap(8).AlignItems(ui.Center).Wrap().Children(func() {
				a.loginStatus(c, p)
			})
			if p.Term != nil {
				a.loginTerminal(c, p)
			} else {
				a.loginFallback(c, p)
			}
			if p.Finished {
				display.Text(c, "登录命令已结束", display.TextProps{Strong: true})
				if p.ExitCode != 0 {
					display.Text(c, fmt.Sprintf("登录命令没有成功：exit status %d", p.ExitCode), display.TextProps{Type: display.TextDanger})
				}
			}
			fieldError(c, a.errors[loginCheckKey(p.ID)])
			ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
				if p.Term == nil {
					if action.Button(c, "复制命令", action.ButtonProps{Size: theme.Small}).Clicked() {
						c.WriteClipboard(p.Command)
						a.showToast("已复制命令")
					}
					a.button(c, loginCheckKey(p.ID), "我已登录，重新检查", func() {
						a.checkLoginAgain(p)
					})
				}
				ui.Box(c).Grow(1)
				if action.Button(c, "关闭", action.ButtonProps{}).Clicked() {
					a.closeLogin(p)
				}
			})
		})
	})
	if !open || !st.loginOpen {
		a.closeLogin(p)
	}
}

// loginStatus shows the account's current status. It reads the latest
// snapshot so the check that follows the command updates the dialog without
// another copy of the account.
func (a *app) loginStatus(c *ui.Context, p *loginPanel) {
	acc := account{ID: p.ID, Label: p.Label, Ready: p.Ready, ReadyReason: p.Reason}
	for _, item := range a.snapshot.Accounts {
		if item.ID == p.ID {
			acc = item
			break
		}
	}
	if acc.Ready {
		display.Tag(c, "就绪", display.TagProps{Color: display.TagSuccess})
		return
	}
	display.Tag(c, "未就绪", display.TagProps{Color: display.TagWarning})
	reason := strings.TrimSpace(acc.ReadyReason)
	if reason == "" {
		reason = "服务没有给出原因"
	}
	display.Text(c, reason, display.TextProps{Type: display.TextSecondary, FontSize: 12})
}

func (a *app) loginTerminal(c *ui.Context, p *loginPanel) {
	tk := theme.TokensOf(c)
	ui.Column(c).Height(320).Clip().Radius(tk.BorderRadius).Border(1, tk.BorderSecondary).
		Background(tk.BgBase).Children(func() {
		terminal.View(c, p.Term).Fill().AutoFocus()
	})
}

func (a *app) loginFallback(c *ui.Context, p *loginPanel) {
	tk := theme.TokensOf(c)
	ui.Column(c).Padding(12).Gap(8).Radius(tk.BorderRadius).Background(tk.FillTertiary).Children(func() {
		display.Text(c, "内嵌终端不可用："+p.Fallback, display.TextProps{Type: display.TextWarning, FontSize: 12})
		display.Text(c, "在终端里运行：", display.TextProps{})
		ui.Row(c).Padding(10, 12).Radius(tk.BorderRadius).Background(tk.FillSecondary).Children(func() {
			display.Text(c, p.Command, display.TextProps{Code: true})
		})
	})
}

// checkLoginAgain is the degraded box's manual check. As before, a successful
// check closes the dialog and leaves the refreshed table behind it.
func (a *app) checkLoginAgain(p *loginPanel) {
	key := loginCheckKey(p.ID)
	a.action(key, func() (string, error) {
		err := a.client.call("account.check", map[string]string{"id": p.ID}, nil)
		if err == nil {
			a.refresh()
		}
		return "", err
	}, func(_ string, err error) {
		if err == nil {
			st := accountsFor(a)
			if st.login == p {
				st.loginOpen = false
				st.login = nil
			}
			a.showToast("已重新检查")
		}
	})
}
