package main

import (
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo/ui"
	"github.com/lobehub/lobe-mygo/pkg/action"
	"github.com/lobehub/lobe-mygo/pkg/choice"
	"github.com/lobehub/lobe-mygo/pkg/display"
	"github.com/lobehub/lobe-mygo/pkg/feedback"
	"github.com/lobehub/lobe-mygo/pkg/field"
	"github.com/lobehub/lobe-mygo/pkg/lucide"
	"github.com/lobehub/lobe-mygo/pkg/overlay"
	"github.com/lobehub/lobe-mygo/pkg/theme"
)

// accountsState is the transient state of the accounts page. The app struct is
// shared with the other pages and cannot grow page fields here, so each app
// keeps its own state value for as long as it lives. Nothing here is shared
// between accounts and every read happens under app.mu, like the snapshot.
type accountsState struct {
	form      *accountForm
	pauseOpen bool
	pause     pauseState
	usageOpen bool
	usage     *usagePanel
	loginOpen bool
	login     *loginPanel
	fetchOpen bool
	fetch     *modelFetch
}

type pauseState struct {
	ID      string
	Label   string
	Minutes string
	Reason  string
	Err     string
}

var accountsStates sync.Map // map[*app]*accountsState

func accountsFor(a *app) *accountsState {
	if v, ok := accountsStates.Load(a); ok {
		return v.(*accountsState)
	}
	v, _ := accountsStates.LoadOrStore(a, &accountsState{})
	return v.(*accountsState)
}

func (a *app) accountsPage(c *ui.Context) {
	w, _ := c.Size()
	st := accountsFor(a)
	a.pageHeader(c, "账号", fmt.Sprintf("%d 个账号", len(a.snapshot.Accounts)), func() {
		a.button(c, "accounts:check-all", "全部检查", func() {
			a.action("accounts:check-all", func() (string, error) {
				err := a.client.call("account.check", map[string]any{}, nil)
				if err == nil {
					a.refresh()
				}
				return "", err
			}, func(_ string, err error) {
				if err == nil {
					a.showToast("已检查全部账号")
				}
			})
		})
		if ui.PrimaryButton(c, "接入账号").Clicked() {
			st.form = newAccountForm()
		}
	})
	fieldError(c, a.errors["accounts:check-all"])
	if len(a.snapshot.Accounts) == 0 {
		stateEmpty(c, lucide.Users(), "还没有账号", "接入 Claude、Codex、opencode 订阅账号或 dsh 渠道后，这里会显示状态、候选和用量。", "接入账号", func() {
			st.form = newAccountForm()
		})
	} else if w < 1090 {
		a.accountCards(c)
	} else {
		a.accountsTable(c)
	}
	a.accountFormView(c)
	a.pauseView(c)
	a.usageView(c)
	a.loginView(c)
	a.modelFetchView(c)
}

type accountColumn struct {
	title  string
	width  float32
	grow   bool
	weight float32
	minW   float32
	align  ui.Align
}

var accountColumns = []accountColumn{
	{title: "账号", grow: true, weight: 3, minW: 130},
	{title: "状态", width: 108},
	{title: "用它的候选", grow: true, weight: 2, minW: 120},
	{title: "本月用量", width: 96},
	{title: "估算剩余", width: 88},
	{title: "启用", width: 36, align: ui.Center},
	{title: "操作", width: 116, align: ui.End},
}

func accountCell(c *ui.Context, i int, body func(cell ui.Element)) ui.Element {
	col := accountColumns[i]
	cell := ui.Column(c).MinWidth(0).Gap(2)
	if col.grow {
		cell.Grow(col.weight).Basis(0).MinWidth(col.minW)
	} else {
		cell.Width(col.width)
	}
	cell.Children(func() { body(cell) })
	return cell
}

func (a *app) accountsTable(c *ui.Context) {
	tk := theme.TokensOf(c)
	ui.Column(c).Border(1, tk.BorderSecondary).Radius(10).Clip().Children(func() {
		ui.Row(c).Padding(10, 12).Gap(8).Background(tk.FillQuaternary).AlignItems(ui.Center).Children(func() {
			for i, col := range accountColumns {
				accountCell(c, i, func(cell ui.Element) {
					row := ui.Row(c).Gap(4).AlignItems(ui.Center)
					switch col.align {
					case ui.Center:
						row.Justify(ui.Center)
					case ui.End:
						row.Justify(ui.End)
					}
					row.Children(func() {
						display.Text(c, col.title, display.TextProps{Type: display.TextSecondary, Strong: true, FontSize: 12}).SingleLine()
					})
				})
			}
		})
		ui.Box(c).Height(1).AlignSelf(ui.Stretch).Background(tk.Split)
		for i, acc := range a.snapshot.Accounts {
			a.accountRow(c, acc, i < len(a.snapshot.Accounts)-1)
		}
	})
}

func (a *app) accountRow(c *ui.Context, acc account, divider bool) {
	tk := theme.TokensOf(c)
	label := accountLabel(acc)
	root := ui.Column(c).Key("account:" + acc.ID)
	open := ui.Local(root, "more", func() bool { return false })
	root.Children(func() {
		row := ui.Row(c).Padding(12).Gap(8).AlignItems(ui.Start)
		if row.Hovered() {
			row.Background(tk.FillQuaternary)
		}
		row.Children(func() {
			accountCell(c, 0, func(cell ui.Element) {
				display.Text(c, label, display.TextProps{Strong: true}).MaxLines(2)
				display.Text(c, accountSubline(acc), display.TextProps{Type: display.TextSecondary, FontSize: 11}).MaxLines(1)
			})
			accountCell(c, 1, func(cell ui.Element) {
				ui.Column(c).Gap(3).AlignItems(ui.Start).Children(func() { a.accountStatus(c, acc) })
			})
			accountCell(c, 2, func(cell ui.Element) {
				a.accountCandidates(c, acc)
			})
			if acc.Kind == "api" {
				accountCell(c, 3, func(cell ui.Element) { a.usageSpentCell(c, acc, 0) })
				accountCell(c, 4, func(cell ui.Element) { a.usageRemainingCell(c, acc, 0) })
			} else {
				accountCell(c, 3, func(cell ui.Element) {
					display.Text(c, "—", display.TextProps{Type: display.TextSecondary})
				})
				accountCell(c, 4, func(cell ui.Element) {
					display.Text(c, "—", display.TextProps{Type: display.TextSecondary})
				})
			}
			accountCell(c, 5, func(cell ui.Element) {
				on := acc.Enabled
				sw := choice.Switch(c, &on, choice.SwitchProps{Size: theme.Small}).Label("启用 " + label)
				key := "account:enabled:" + acc.ID
				sw.Disabled(a.busy[key])
				if sw.Changed() {
					a.write(key, "account.set", map[string]any{"id": acc.ID, "enabled": on})
				}
			})
			accountCell(c, 6, func(cell ui.Element) {
				ui.Row(c).Justify(ui.End).Children(func() { a.accountActions(c, acc, open) })
			})
		})
		a.accountRowErrors(c, acc)
		if divider {
			ui.Box(c).Height(1).AlignSelf(ui.Stretch).Background(tk.Split)
		}
	})
}

func (a *app) accountRowErrors(c *ui.Context, acc account) {
	for _, key := range accountErrorKeys(acc.ID) {
		if message := a.errors[key]; message != "" {
			ui.Column(c).Padding(0, 12, 10, 12).Children(func() { fieldError(c, message) })
		}
	}
}

func (a *app) accountCards(c *ui.Context) {
	tk := theme.TokensOf(c)
	ui.Column(c).Gap(12).Children(func() {
		for _, acc := range a.snapshot.Accounts {
			acc := acc
			label := accountLabel(acc)
			root := ui.Column(c).Key("account:" + acc.ID)
			open := ui.Local(root, "more", func() bool { return false })
			root.Children(func() {
				card := ui.Column(c).Padding(14).Gap(8).Radius(12).Border(1, tk.BorderSecondary)
				if card.Hovered() {
					card.Background(tk.FillQuaternary)
				}
				card.Children(func() {
					ui.Row(c).Gap(12).AlignItems(ui.Center).Children(func() {
						ui.Column(c).Grow(1).Basis(0).MinWidth(0).Gap(2).Children(func() {
							display.Text(c, label, display.TextProps{Strong: true}).MaxLines(2)
							display.Text(c, accountSubline(acc), display.TextProps{Type: display.TextSecondary, FontSize: 11}).MaxLines(1)
						})
						on := acc.Enabled
						sw := choice.Switch(c, &on, choice.SwitchProps{Size: theme.Small}).Label("启用 " + label)
						key := "account:enabled:" + acc.ID
						sw.Disabled(a.busy[key])
						if sw.Changed() {
							a.write(key, "account.set", map[string]any{"id": acc.ID, "enabled": on})
						}
					})
					ui.Column(c).Gap(3).AlignItems(ui.Start).Children(func() { a.accountStatus(c, acc) })
					if acc.Kind == "api" {
						ui.Row(c).Gap(28).Children(func() {
							ui.Column(c).Grow(1).Basis(0).Children(func() { a.usageSpentCell(c, acc, 0) })
							ui.Column(c).Grow(1).Basis(0).Children(func() { a.usageRemainingCell(c, acc, 0) })
						})
					}
					ui.Row(c).Gap(8).AlignItems(ui.Start).Children(func() {
						display.Text(c, "用它的候选", display.TextProps{Type: display.TextSecondary, FontSize: 11}).Width(72).Padding(1, 0, 0, 0)
						ui.Column(c).Grow(1).Basis(0).MinWidth(0).Children(func() { a.accountCandidates(c, acc) })
					})
					ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
						a.accountActions(c, acc, open)
						ui.Box(c).Grow(1)
					})
				})
				a.accountRowErrors(c, acc)
			})
		}
	})
}

func (a *app) accountCandidates(c *ui.Context, acc account) {
	ids := a.candidatesUsing(acc.ID)
	if len(ids) == 0 {
		display.Tag(c, "没有候选在用", display.TagProps{Color: display.TagError, Size: theme.Small}).AlignSelf(ui.Start)
		return
	}
	for _, id := range ids {
		display.Text(c, id, display.TextProps{Code: true, FontSize: 11, Type: display.TextSecondary}).MaxLines(1)
	}
}

func accountErrorKeys(id string) []string {
	return []string{
		"account:check:" + id,
		"account:resume:" + id,
		"account:enabled:" + id,
		"account:remove:" + id,
		"account:pause:" + id,
	}
}

func (a *app) accountStatus(c *ui.Context, acc account) {
	now := time.Now()
	switch {
	case !acc.Enabled:
		display.Tag(c, "已停用", display.TagProps{})
	case acc.PausedUntil > now.UnixMilli():
		display.Text(c, pauseLabel(acc), display.TextProps{Type: display.TextWarning, Strong: true, FontSize: 12})
		display.Text(c, pauseDetail(acc, now), display.TextProps{FontSize: 11})
	default:
		if acc.Ready {
			display.Tag(c, "就绪", display.TagProps{Color: display.TagSuccess})
			return
		}
		reason := strings.TrimSpace(acc.ReadyReason)
		if reason == "" {
			reason = "服务没有给出原因"
		}
		display.Text(c, "未就绪："+reason, display.TextProps{Type: display.TextWarning, FontSize: 12})
	}
}

func pauseLabel(acc account) string {
	return "已暂停到 " + time.UnixMilli(acc.PausedUntil).Format("01-02 15:04")
}

func pauseDetail(acc account, now time.Time) string {
	until := time.UnixMilli(acc.PausedUntil)
	left := until.Sub(now)
	if left < 0 {
		left = 0
	}
	reason := strings.TrimSpace(acc.PauseReason)
	detail := fmt.Sprintf("还剩 %s", countdown(left))
	if reason != "" {
		detail += "：" + reason
	}
	return detail
}

func countdown(d time.Duration) string {
	seconds := int(d.Seconds())
	if seconds < 60 {
		return fmt.Sprintf("%d 秒", seconds)
	}
	minutes := seconds / 60
	if minutes < 60 {
		return fmt.Sprintf("%d 分 %d 秒", minutes, seconds%60)
	}
	hours := minutes / 60
	return fmt.Sprintf("%d 小时 %d 分", hours, minutes%60)
}

func accountLabel(acc account) string {
	if strings.TrimSpace(acc.Label) != "" {
		return acc.Label
	}
	return "未命名账号"
}

func accountSubline(acc account) string {
	parts := []string{acc.Engine, kindLabel(acc.Kind)}
	if acc.Provider != "" {
		parts = append(parts, acc.Provider)
	}
	if acc.Resident != "" {
		parts = append(parts, residentLabel(acc.Resident))
	}
	return strings.Join(parts, " · ")
}

func kindLabel(kind string) string {
	if kind == "subscription" {
		return "订阅"
	}
	return "API"
}

func residentLabel(state string) string {
	switch state {
	case "ready":
		return "常驻就绪"
	case "starting":
		return "常驻启动中"
	case "failed":
		return "常驻失败"
	case "stopped":
		return "常驻已停止"
	}
	if state == "" {
		return ""
	}
	return "常驻" + state
}

func (a *app) candidatesUsing(id string) []string {
	var ids []string
	for _, w := range a.snapshot.Workers {
		for _, accountID := range w.Accounts {
			if accountID == id {
				ids = append(ids, w.ID)
				break
			}
		}
	}
	return ids
}

func (a *app) accountActions(c *ui.Context, acc account, open *bool) {
	label := accountLabel(acc)
	ui.Row(c).Gap(4).AlignItems(ui.Center).Children(func() {
		a.rowButton(c, "account:check:"+acc.ID, "检查", "检查 "+label, func() {
			a.action("account:check:"+acc.ID, func() (string, error) {
				err := a.client.call("account.check", map[string]string{"id": acc.ID}, nil)
				if err == nil {
					a.refresh()
				}
				return "", err
			}, nil)
		})
		a.rowButton(c, "account:edit:"+acc.ID, "编辑", "编辑 "+label, func() { a.openEdit(acc) })

		items := []overlay.MenuItem{}
		if acc.Kind == "subscription" {
			items = append(items, overlay.MenuItem{Key: "login", Label: "登录 " + label, Icon: lucide.LogIn()})
		}
		if acc.PausedUntil > time.Now().UnixMilli() {
			items = append(items, overlay.MenuItem{Key: "resume", Label: "恢复 " + label, Icon: lucide.Play()})
		} else {
			items = append(items, overlay.MenuItem{Key: "pause", Label: "暂停 " + label, Icon: lucide.Pause()})
		}
		items = append(items, overlay.MenuItem{Divider: true})
		items = append(items, overlay.MenuItem{Key: "delete", Label: "删除 " + label, Icon: lucide.Trash2(), Danger: true})

		chosen := overlay.DropdownMenu(c, open, overlay.DropdownMenuProps{Items: items}, func(t ui.Element) {
			action.StyleActionIcon(c, t, lucide.Ellipsis(), action.ActionIconProps{Size: theme.Small, Title: "更多操作 " + label})
		})
		switch chosen {
		case "login":
			a.openLogin(acc)
		case "pause":
			a.openPause(acc)
		case "resume":
			a.write("account:resume:"+acc.ID, "account.resume", map[string]string{"id": acc.ID})
		case "delete":
			a.confirmDelete(acc)
		}
	})
}

func (a *app) rowButton(c *ui.Context, key, text, label string, clicked func()) {
	b := action.Button(c, text, action.ButtonProps{Size: theme.Small})
	b.Label(label).Disabled(a.busy[key])
	if b.Clicked() {
		clicked()
	}
}

func (a *app) confirmDelete(acc account) {
	label := accountLabel(acc)
	ids := a.candidatesUsing(acc.ID)
	body := "凭据目录会留在磁盘上。"
	if len(ids) == 0 {
		body += "这个账号没有候选在用。"
	} else {
		body += "删除后，这些候选会解绑这个账号：" + strings.Join(ids, "、") + "。"
	}
	a.confirm("删除 "+label, body, func() {
		key := "account:remove:" + acc.ID
		a.action(key, func() (string, error) {
			err := a.client.call("account.remove", map[string]string{"id": acc.ID}, nil)
			if err == nil {
				a.refresh()
			}
			return "", err
		}, func(_ string, err error) {
			if err == nil {
				a.showToast("已删除 " + label)
			}
		})
	})
}

func (a *app) openPause(acc account) {
	st := accountsFor(a)
	st.pause = pauseState{ID: acc.ID, Label: accountLabel(acc), Minutes: "30"}
	st.pauseOpen = true
}

func (a *app) pauseView(c *ui.Context) {
	st := accountsFor(a)
	if !st.pauseOpen && st.pause.ID == "" {
		return
	}
	p := &st.pause
	open := st.pauseOpen
	ok := feedback.Modal(c, &open, feedback.ModalProps{
		Title:      "暂停 " + p.Label,
		OkText:     "暂停",
		CancelText: "取消",
	}, func() {
		ui.Column(c).Gap(10).Children(func() {
			ui.Row(c).Gap(12).AlignItems(ui.Center).Children(func() {
				display.Text(c, "时长", display.TextProps{Strong: true}).Width(72)
				field.Select(c, &p.Minutes, field.SelectProps{Size: theme.Small, Options: []field.SelectOption{
					{Value: "15", Label: "15 分钟"},
					{Value: "30", Label: "30 分钟"},
					{Value: "60", Label: "1 小时"},
					{Value: "120", Label: "2 小时"},
					{Value: "1440", Label: "24 小时"},
				}}).Label("暂停时长")
			})
			ui.Row(c).Gap(12).AlignItems(ui.Center).Children(func() {
				display.Text(c, "原因", display.TextProps{Strong: true}).Width(72)
				field.Input(c, &p.Reason, field.InputProps{Placeholder: "例如：额度用完，等充值"}).Label("暂停原因")
			})
			fieldError(c, p.Err)
		})
	})
	if !ok {
		if !open {
			st.pauseOpen = false
			st.pause.ID = ""
		}
		return
	}
	if strings.TrimSpace(p.Reason) == "" {
		p.Err = "原因必填"
		return
	}
	minutes := 30
	fmt.Sscan(p.Minutes, &minutes)
	id, reason := p.ID, strings.TrimSpace(p.Reason)
	st.pauseOpen = false
	st.pause.ID = ""
	a.action("account:pause:"+id, func() (string, error) {
		params := map[string]any{"id": id, "forMs": int64(minutes) * 60 * 1000, "reason": reason}
		err := a.client.call("account.pause", params, nil)
		if err == nil {
			a.refresh()
		}
		return "", err
	}, nil)
}
