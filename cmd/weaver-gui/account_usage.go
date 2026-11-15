package main

import (
	"fmt"
	"math"
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

// priceFields are the four prices of a model, in the order the drawer shows
// them, with the service's field names.
var priceFields = [4]struct{ label, param string }{
	{"输入", "input"},
	{"输出", "output"},
	{"缓存读", "cacheRead"},
	{"缓存写", "cacheWrite"},
}

type usagePanel struct {
	ID             string
	Label          string
	Balance        string
	BalanceInitial string
	BalanceAt      int64
	Alert          string
	Models         []modelPriceRow
	Month          usageTotals
	Err            string
}

// modelPriceRow is one model of the account with its prices as typed.
type modelPriceRow struct {
	modelUsage
	Values [4]string
}

func (p usagePrices) list() [4]*float64 {
	return [4]*float64{p.Input, p.Output, p.CacheRead, p.CacheWrite}
}

func (a *app) openUsage(acc account) {
	p := &usagePanel{ID: acc.ID, Label: accountLabel(acc)}
	p.applyUsage(acc)
	st := accountsFor(a)
	st.usage = p
	st.usageOpen = true
}

// usageSpentCell is the month column: the dollar amount when the runs are
// priced, otherwise their tokens with a hint to fill in prices.
func (a *app) usageSpentCell(c *ui.Context, acc account, width float32) {
	col := ui.Column(c).Gap(1).AlignItems(ui.Start)
	if width > 0 {
		col.Width(width)
	}
	col.Children(func() {
		var m usageTotals
		if acc.Usage != nil {
			m = acc.Usage.Month
		}
		switch {
		case m.Cost != nil:
			display.Text(c, money(*m.Cost), display.TextProps{Strong: true, FontSize: 13})
			note := fmt.Sprintf("%d 次", m.Runs)
			if m.Unpriced > 0 {
				note += fmt.Sprintf(" · %d 次未计价", m.Unpriced)
			}
			display.Text(c, note, display.TextProps{Type: display.TextSecondary, FontSize: 11}).MaxLines(2)
		case m.Runs > 0:
			display.Text(c, tokens(m.InputTokens+m.OutputTokens+m.CacheReadTokens+m.CacheWriteTokens)+" 令牌", display.TextProps{Strong: true, FontSize: 13}).MaxLines(1)
			display.Text(c, fmt.Sprintf("%d 次 · 未填单价", m.Runs), display.TextProps{Type: display.TextSecondary, FontSize: 11}).MaxLines(2)
		default:
			display.Text(c, "本月没有运行", display.TextProps{Type: display.TextSecondary, FontSize: 11}).MaxLines(2)
		}
		a.usageConfigButton(c, acc)
	})
}

func (a *app) usageConfigButton(c *ui.Context, acc account) {
	// Text links carry no horizontal padding so the label starts on the same
	// left edge as the amount above it.
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
		switch {
		case u != nil && u.Remaining != nil:
			text := remainingMoney(*u.Remaining)
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
		case u != nil && u.Balance != nil:
			display.Text(c, "填单价后可估算", display.TextProps{Type: display.TextSecondary, FontSize: 11}).MaxLines(2)
		default:
			display.Text(c, "—", display.TextProps{Type: display.TextSecondary})
		}
	})
}

// money shows a spent amount to the cent; a spend under one cent is not 0.
func money(v float64) string {
	if v > 0 && v < 0.005 {
		return "<$0.01"
	}
	return fmt.Sprintf("$%.2f", v)
}

// remainingMoney rounds down to the cent, so a balance just under the alert
// line never reads as equal to it.
func remainingMoney(v float64) string {
	return fmt.Sprintf("$%.2f", math.Floor(v*100+1e-9)/100)
}

// tokens shortens a token count: 860, 86K, 1.2M.
func tokens(n int64) string {
	switch {
	case n >= 1_000_000:
		return strings.TrimSuffix(fmt.Sprintf("%.1f", float64(n)/1e6), ".0") + "M"
	case n >= 1_000:
		return strings.TrimSuffix(fmt.Sprintf("%.1f", float64(n)/1e3), ".0") + "K"
	}
	return strconv.FormatInt(n, 10)
}

// monthSummary is the drawer's one line about this month's runs.
func monthSummary(m usageTotals) string {
	if m.Runs == 0 {
		return "本月还没有运行记录"
	}
	text := fmt.Sprintf("本月 %d 次运行 · 输入 %s · 输出 %s · 缓存读 %s · 缓存写 %s", m.Runs,
		tokens(m.InputTokens), tokens(m.OutputTokens), tokens(m.CacheReadTokens), tokens(m.CacheWriteTokens))
	if m.Cost != nil {
		text += " · 约 " + money(*m.Cost)
	}
	if m.Unpriced > 0 {
		text += fmt.Sprintf(" · %d 次未计价", m.Unpriced)
	}
	return text
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
		Title: "用量 · " + p.Label,
		Size:  size,
		Footer: func() {
			if action.Button(c, "关闭", action.ButtonProps{}).Clicked() {
				open = false
			}
			a.primaryButton(c, "account:usage.save:"+p.ID, "保存", func() { a.saveUsage(p) })
		},
	}, func() {
		ui.Column(c).Gap(12).Children(func() {
			fieldError(c, p.Err)
			formRow(c, "当前余额", func(label ui.Element) {
				formFieldStack(c, func() {
					ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
						ui.Column(c).Width(120).Children(func() {
							field.Input(c, &p.Balance, field.InputProps{Size: theme.Small, Placeholder: "50.00"}).Label("当前余额").LabelledBy(label)
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
			display.Text(c, "单价按模型填写，单位是美元 / 百万令牌。引擎回报了金额时（Claude）用回报值；其余按所属模型的单价折算，留空的项按 0 计，四项都空的模型只统计令牌。",
				display.TextProps{Type: display.TextSecondary, FontSize: 12})
			if len(p.Models) == 0 {
				display.Text(c, "这个账号还没有候选在用，也没有运行记录；在候选里用上它以后，这里会列出模型。", display.TextProps{Type: display.TextSecondary, FontSize: 12})
			}
			for i := range p.Models {
				a.modelPriceBlock(c, &p.Models[i])
			}
			display.Text(c, monthSummary(p.Month), display.TextProps{Type: display.TextSecondary, FontSize: 12})
		})
	})
	if !open {
		st.usageOpen = false
		st.usage = nil
	}
}

// modelPriceBlock is one model: its name, this month's runs and four prices.
func (a *app) modelPriceBlock(c *ui.Context, m *modelPriceRow) {
	tk := theme.TokensOf(c)
	ui.Column(c.Key("price:"+m.Model)).Padding(10, 12).Gap(8).Radius(tk.BorderRadius).Border(1, tk.BorderSecondary).Children(func() {
		ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
			display.Text(c, m.Model, display.TextProps{Code: true, FontSize: 12}).MaxLines(1)
			ui.Box(c).Grow(1)
			display.Text(c, modelSummary(m.modelUsage), display.TextProps{Type: display.TextSecondary, FontSize: 11}).MaxLines(1)
		})
		ui.Row(c).Gap(8).Children(func() {
			for i, f := range priceFields {
				i, f := i, f
				ui.Column(c).Grow(1).Basis(0).MinWidth(0).Gap(4).Children(func() {
					// The visible caption is short; the field's own name says
					// which model it prices.
					display.Text(c, f.label, display.TextProps{Type: display.TextSecondary, FontSize: 11})
					field.Input(c, &m.Values[i], field.InputProps{Size: theme.Small}).Label(m.Model + " " + f.label + "单价")
				})
			}
		})
	})
}

func modelSummary(m modelUsage) string {
	if m.Runs == 0 {
		return "本月没有运行"
	}
	text := fmt.Sprintf("本月 %d 次", m.Runs)
	if m.Cost != nil {
		text += " · 约 " + money(*m.Cost)
	}
	if m.Unpriced > 0 {
		text += fmt.Sprintf(" · %d 次未计价", m.Unpriced)
	}
	return text
}

func (a *app) saveUsage(p *usagePanel) {
	params := map[string]any{"id": p.ID}
	value := func(text, name, key string) bool {
		v, err := parseMoney(text)
		if err != nil || (v != nil && *v < 0) {
			p.Err = name + "需要不小于 0 的数字"
			return false
		}
		if v == nil {
			params[key] = nil
		} else {
			params[key] = *v
		}
		return true
	}
	// Only a changed balance is sent: sending it stamps a new record time.
	if p.Balance != p.BalanceInitial && !value(p.Balance, "当前余额", "balance") {
		return
	}
	if !value(p.Alert, "低于多少提示", "alertBelow") {
		return
	}
	prices := []map[string]any{}
	for _, m := range p.Models {
		entry := map[string]any{"model": m.Model}
		for i, f := range priceFields {
			v, err := parseMoney(m.Values[i])
			if err != nil || (v != nil && *v < 0) {
				p.Err = m.Model + " 的" + f.label + "单价需要不小于 0 的数字"
				return
			}
			if v != nil {
				entry[f.param] = *v
			}
		}
		prices = append(prices, entry)
	}
	params["prices"] = prices
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
		p.applyUsage(updated)
		a.showToast("用量设置已保存")
	})
}

// applyUsage fills the drawer from the service's view of the account.
func (p *usagePanel) applyUsage(acc account) {
	u := acc.Usage
	if u == nil {
		return
	}
	p.Balance = ""
	if u.Balance != nil {
		p.Balance = fmt.Sprintf("%.2f", *u.Balance)
	}
	p.BalanceInitial = p.Balance
	p.BalanceAt = u.BalanceAt
	p.Alert = ""
	if u.AlertBelow != nil {
		p.Alert = fmt.Sprintf("%g", *u.AlertBelow)
	}
	p.Models = p.Models[:0]
	for _, m := range u.Models {
		row := modelPriceRow{modelUsage: m}
		for i, v := range m.Prices.list() {
			if v != nil {
				row.Values[i] = fmt.Sprintf("%g", *v)
			}
		}
		p.Models = append(p.Models, row)
	}
	p.Month = u.Month
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
