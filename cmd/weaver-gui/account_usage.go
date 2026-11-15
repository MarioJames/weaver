package main

import (
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/egoist/mygo/ui"
	"github.com/lobehub/lobe-mygo/pkg/action"
	"github.com/lobehub/lobe-mygo/pkg/display"
	"github.com/lobehub/lobe-mygo/pkg/feedback"
	"github.com/lobehub/lobe-mygo/pkg/field"
	"github.com/lobehub/lobe-mygo/pkg/theme"
)

type usagePanel struct {
	ID             string
	Label          string
	AdminKey       string
	HasAdminKey    bool
	Balance        string
	BalanceInitial string
	BalanceAt      int64
	Alert          string
	Interval       int
	Supported      bool
	Err            string
}

func (a *app) openUsage(acc account) {
	p := &usagePanel{ID: acc.ID, Label: accountLabel(acc), HasAdminKey: acc.HasAdminKey, Interval: 300, Supported: true}
	if u := acc.Usage; u != nil {
		p.Supported = u.Supported
		p.Interval = u.Interval
		if p.Interval == 0 {
			p.Interval = 300
		}
		if u.Balance != nil {
			p.Balance = fmt.Sprintf("%.2f", *u.Balance)
			p.BalanceInitial = p.Balance
		}
		p.BalanceAt = u.BalanceAt
		if u.AlertBelow != nil {
			p.Alert = fmt.Sprintf("%g", *u.AlertBelow)
		}
	}
	st := accountsFor(a)
	st.usage = p
	st.usageOpen = true
}

func (a *app) usageSpentCell(c *ui.Context, acc account, width float32) {
	col := ui.Column(c).Gap(1).AlignItems(ui.Start)
	if width > 0 {
		col.Width(width)
	}
	col.Children(func() {
		u := acc.Usage
		if u == nil {
			display.Text(c, "未配置用量查询", display.TextProps{Type: display.TextSecondary, FontSize: 11}).MaxLines(2)
			a.usageConfigButton(c, acc)
			return
		}
		if u.SpentMonth != nil {
			display.Text(c, money(*u.SpentMonth), display.TextProps{Strong: true, FontSize: 13})
		} else {
			display.Text(c, "—", display.TextProps{Type: display.TextSecondary})
		}
		if u.CheckedAt > 0 {
			display.Text(c, updatedAgo(u.CheckedAt), display.TextProps{Type: display.TextSecondary, FontSize: 11}).MaxLines(1)
		}
		a.usageConfigButton(c, acc)
	})
}

func (a *app) usageConfigButton(c *ui.Context, acc account) {
	// Text links carry no horizontal padding so the label starts on the same
	// left edge as the amount and update text above it.
	b := action.Button(c, "配置", action.ButtonProps{Variant: action.Text, Size: theme.Small}).PaddingX(0)
	b.Label("配置用量 " + accountLabel(acc))
	if b.Clicked() {
		a.openUsage(acc)
	}
}

func (a *app) usageRemainingCell(c *ui.Context, acc account, width float32) {
	col := ui.Column(c).Gap(1).AlignItems(ui.Start)
	if width > 0 {
		col.Width(width)
	}
	col.Children(func() {
		u := acc.Usage
		if u == nil {
			display.Text(c, "—", display.TextProps{Type: display.TextSecondary})
			return
		}
		if u.Remaining != nil {
			text := money(*u.Remaining)
			if u.Low {
				threshold := 0.0
				if u.AlertBelow != nil {
					threshold = *u.AlertBelow
				}
				text += fmt.Sprintf(" · 低于 $%g", threshold)
				display.Text(c, text, display.TextProps{Type: display.TextDanger, FontSize: 12}).MaxLines(2)
			} else {
				display.Text(c, text, display.TextProps{FontSize: 12}).MaxLines(1)
			}
			display.Text(c, "估算", display.TextProps{Type: display.TextSecondary, FontSize: 11})
			return
		}
		display.Text(c, "—", display.TextProps{Type: display.TextSecondary})
	})
}

func money(v float64) string {
	return fmt.Sprintf("$%.2f", v)
}

func updatedAgo(ms int64) string {
	if ms <= 0 {
		return "尚未更新"
	}
	d := time.Since(time.UnixMilli(ms))
	if d < time.Minute {
		return "刚刚更新"
	}
	minutes := int(d.Minutes())
	if minutes < 60 {
		return fmt.Sprintf("%d 分钟前更新", minutes)
	}
	hours := minutes / 60
	if hours < 24 {
		return fmt.Sprintf("%d 小时前更新", hours)
	}
	return fmt.Sprintf("%d 天前更新", hours/24)
}

func (a *app) usageView(c *ui.Context) {
	st := accountsFor(a)
	if !st.usageOpen || st.usage == nil {
		return
	}
	p := st.usage
	open := true
	width, _ := c.Size()
	size := float32(480)
	if width > 0 && width-24 < size {
		size = width - 24
	}
	feedback.Drawer(c, &open, feedback.DrawerProps{
		Title: "用量查询 · " + p.Label,
		Size:  size,
		Footer: func() {
			a.button(c, "account:usage.query:"+p.ID, "立即查询", func() { a.queryUsage(p) })
			if action.Button(c, "关闭", action.ButtonProps{}).Clicked() {
				open = false
			}
			a.primaryButton(c, "account:usage.save:"+p.ID, "保存", func() { a.saveUsage(p) })
		},
	}, func() {
		ui.Column(c).Gap(12).Children(func() {
			fieldError(c, p.Err)
			if !p.Supported {
				display.Text(c, "这个渠道暂不支持用量查询（只支持 OpenAI、Anthropic 官方）", display.TextProps{Type: display.TextSecondary, FontSize: 12})
			}
			formRow(c, "管理密钥", func(label ui.Element) {
				formFieldStack(c, func() {
					field.InputPassword(c, &p.AdminKey, field.InputProps{Size: theme.Small}).Label("管理密钥").LabelledBy(label)
					if p.HasAdminKey {
						formHelp(c, "已设置，留空表示不改")
					}
					formHelp(c, "只用来查消费，保存后不再显示。OpenAI 在组织设置的 Admin keys 里创建。")
				})
			})
			formRow(c, "当前充值余额", func(label ui.Element) {
				formFieldStack(c, func() {
					ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
						ui.Column(c).Width(120).Children(func() {
							field.Input(c, &p.Balance, field.InputProps{Size: theme.Small, Placeholder: "50.00"}).Label("当前充值余额").LabelledBy(label)
						})
						help := "充值后在这里重填"
						if p.BalanceAt > 0 {
							help = "记录于 " + time.UnixMilli(p.BalanceAt).Format("01-02 15:04")
						}
						display.Text(c, help, display.TextProps{Type: display.TextSecondary, FontSize: 12})
					})
				})
			})
			formRow(c, "低于多少提示", func(label ui.Element) {
				ui.Column(c).Width(120).Children(func() {
					field.Input(c, &p.Alert, field.InputProps{Size: theme.Small, Placeholder: "5"}).Label("低于多少提示").LabelledBy(label)
				})
			})
			formRow(c, "自动查询", func(label ui.Element) {
				current := strconv.Itoa(p.Interval)
				ui.Column(c).Width(140).Children(func() {
					sel := field.Select(c, &current, field.SelectProps{Size: theme.Small, Options: intervalOptions(p.Interval)}).Label("自动查询").LabelledBy(label)
					if sel.Changed() {
						if n, err := strconv.Atoi(current); err == nil {
							p.Interval = n
						}
					}
				})
			})
		})
	})
	if !open {
		st.usageOpen = false
		st.usage = nil
	}
}

func intervalOptions(current int) []field.SelectOption {
	options := []field.SelectOption{
		{Value: "0", Label: "手动"},
		{Value: "60", Label: "每 1 分钟"},
		{Value: "300", Label: "每 5 分钟"},
		{Value: "900", Label: "每 15 分钟"},
		{Value: "3600", Label: "每 60 分钟"},
	}
	for _, option := range options {
		if option.Value == strconv.Itoa(current) {
			return options
		}
	}
	return append(options, field.SelectOption{Value: strconv.Itoa(current), Label: fmt.Sprintf("每 %d 秒", current)})
}

func (a *app) queryUsage(p *usagePanel) {
	var updated account
	a.action("account:usage.query:"+p.ID, func() (string, error) {
		err := a.client.call("account.usage", map[string]string{"id": p.ID}, &updated)
		if err == nil {
			a.refresh()
		}
		return "", err
	}, func(_ string, err error) {
		if accountsFor(a).usage != p {
			return
		}
		if err != nil {
			p.Err = err.Error()
			return
		}
		p.Err = ""
		p.applyUsage(updated)
		if updated.Usage != nil && updated.Usage.Error != "" {
			p.Err = updated.Usage.Error
		}
	})
}

func (a *app) saveUsage(p *usagePanel) {
	params := map[string]any{"id": p.ID, "interval": p.Interval}
	adminKey := p.AdminKey
	if adminKey != "" {
		params["adminKey"] = adminKey
	}
	balance, err := parseMoney(p.Balance)
	if err != nil {
		p.Err = "当前充值余额需要数字"
		return
	}
	if balance != nil && p.Balance != p.BalanceInitial {
		params["balance"] = *balance
	} else if balance == nil && p.BalanceInitial != "" {
		params["balance"] = nil
	}
	alert, err := parseMoney(p.Alert)
	if err != nil {
		p.Err = "低于多少提示需要数字"
		return
	}
	if alert != nil {
		params["alertBelow"] = *alert
	}
	if p.Alert == "" {
		params["alertBelow"] = nil
	}
	balanceText := p.Balance
	var updated account
	a.action("account:usage.save:"+p.ID, func() (string, error) {
		err := a.client.call("account.usage.set", params, &updated)
		if err == nil {
			a.refresh()
		}
		return "", err
	}, func(_ string, err error) {
		if accountsFor(a).usage != p {
			return
		}
		if err != nil {
			p.Err = err.Error()
			return
		}
		p.Err = ""
		if adminKey != "" {
			p.HasAdminKey = true
			p.AdminKey = ""
		}
		p.BalanceInitial = balanceText
		p.applyUsage(updated)
		if updated.Usage != nil && updated.Usage.Error != "" {
			p.Err = updated.Usage.Error
		}
		a.showToast("用量查询已保存")
	})
}

func (p *usagePanel) applyUsage(acc account) {
	u := acc.Usage
	if u == nil {
		return
	}
	p.Supported = u.Supported
	p.Interval = u.Interval
	if u.Balance != nil {
		p.Balance = fmt.Sprintf("%.2f", *u.Balance)
	}
	p.BalanceAt = u.BalanceAt
	if u.AlertBelow != nil {
		p.Alert = fmt.Sprintf("%g", *u.AlertBelow)
	}
}

func parseMoney(text string) (*float64, error) {
	text = strings.TrimSpace(strings.ReplaceAll(strings.TrimSpace(text), ",", ""))
	text = strings.TrimPrefix(text, "$")
	if text == "" {
		return nil, nil
	}
	value, err := strconv.ParseFloat(text, 64)
	if err != nil {
		return nil, err
	}
	return &value, nil
}
