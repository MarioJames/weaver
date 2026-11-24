package main

import (
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/egoist/mygo/ui"
	"github.com/lobehub/lobe-mygo/pkg/display"
	"github.com/lobehub/lobe-mygo/pkg/feedback"
	"github.com/lobehub/lobe-mygo/pkg/theme"
)

type quotaWindow struct {
	Label       string  `json:"label"`
	Model       string  `json:"model,omitempty"`
	UsedPercent float64 `json:"usedPercent"`
	ResetsAt    int64   `json:"resetsAt,omitempty"`
}
type quotaCredits struct {
	HasCredits          bool    `json:"hasCredits"`
	Unlimited           bool    `json:"unlimited,omitempty"`
	OverageLimitReached bool    `json:"overageLimitReached,omitempty"`
	Balance             float64 `json:"balance,omitempty"`
	HasBalance          bool    `json:"hasBalance,omitempty"`
}
type quotaResetCredits struct {
	AvailableCount int   `json:"availableCount"`
	NextExpiresAt  int64 `json:"nextExpiresAt,omitempty"`
}
type accountQuota struct {
	Status       string             `json:"status"`
	Windows      []quotaWindow      `json:"windows"`
	Credits      *quotaCredits      `json:"credits,omitempty"`
	ResetCredits *quotaResetCredits `json:"resetCredits,omitempty"`
	Detail       string             `json:"detail,omitempty"`
	CheckedAt    int64              `json:"checkedAt,omitempty"`
	Error        string             `json:"error,omitempty"`
	Factor       float64            `json:"factor"`
}

func quotaLocalTime(ms int64) string {
	t := time.UnixMilli(ms).Local()
	day := []string{"周日", "周一", "周二", "周三", "周四", "周五", "周六"}[t.Weekday()]
	return day + " " + t.Format("15:04")
}
func quotaExpiryDate(ms int64) string {
	return time.UnixMilli(ms).Local().Format("01-02") + " 到期"
}
func hasQuota(acc account) bool {
	return acc.Kind == "subscription" && (acc.Engine == "codex" || acc.Engine == "claude" || acc.Engine == "opencode")
}

// quotaWindows are the windows of a snapshot that was actually read.
func quotaWindows(acc account) []quotaWindow {
	if !hasQuota(acc) || acc.Quota == nil || acc.Quota.CheckedAt == 0 {
		return nil
	}
	return acc.Quota.Windows
}

func quotaCreditsOf(acc account) *quotaCredits {
	if !hasQuota(acc) || acc.Quota == nil || acc.Quota.CheckedAt == 0 {
		return nil
	}
	return acc.Quota.Credits
}

func quotaResetCreditsOf(acc account) *quotaResetCredits {
	if !hasQuota(acc) || acc.Quota == nil || acc.Quota.CheckedAt == 0 {
		return nil
	}
	return acc.Quota.ResetCredits
}

func hasQuotaData(acc account) bool {
	return len(quotaWindows(acc)) > 0 || quotaCreditsOf(acc) != nil || quotaResetCreditsOf(acc) != nil
}

func formatCreditsBalance(v float64) string {
	if math.IsNaN(v) || math.IsInf(v, 0) || v < 0 {
		return "0"
	}
	rounded := math.Round(v*100) / 100
	whole := int64(rounded)
	frac := int64(math.Round((rounded - float64(whole)) * 100))
	if frac == 100 {
		whole++
		frac = 0
	}
	intPart := formatIntCommas(whole)
	if frac == 0 {
		return intPart
	}
	if frac%10 == 0 {
		return fmt.Sprintf("%s.%d", intPart, frac/10)
	}
	return fmt.Sprintf("%s.%02d", intPart, frac)
}

func formatIntCommas(n int64) string {
	s := fmt.Sprintf("%d", n)
	if len(s) <= 3 {
		return s
	}
	var b strings.Builder
	rem := len(s) % 3
	if rem > 0 {
		b.WriteString(s[:rem])
	}
	for i := rem; i < len(s); i += 3 {
		if b.Len() > 0 {
			b.WriteByte(',')
		}
		b.WriteString(s[i : i+3])
	}
	return b.String()
}

func formatCredits(c *quotaCredits) (value, status string, warn bool) {
	if c == nil {
		return "", "", false
	}
	if c.Unlimited {
		return "无限制", "不限量", false
	}
	if c.HasBalance {
		value = formatCreditsBalance(c.Balance)
		switch {
		case c.OverageLimitReached:
			return value, "已达上限", true
		case c.HasCredits && c.Balance > 0:
			return value, "可用", false
		default:
			return value, "—", false
		}
	}
	if c.HasCredits {
		if c.OverageLimitReached {
			return "有余额", "已达上限", true
		}
		return "有余额", "可用", false
	}
	return "0", "—", false
}

// quotaWindowLabel drops the trailing 「额度」 (the column already says what the
// bars are) and names the model of a model-scoped window, so an account-wide
// 7-day window and a per-model one do not read as duplicates.
func quotaWindowLabel(w quotaWindow) string {
	label := strings.TrimSuffix(w.Label, "额度")
	if w.Model != "" {
		label += " · " + w.Model
	}
	return label
}

const quotaLineHeight = 18

// quotaUsedCell draws one bar per window plus optional Codex credits and reset
// cards. The reset times and statuses sit on the same lines of the next column,
// so both cells keep one fixed line height.
func (a *app) quotaUsedCell(c *ui.Context, acc account) {
	tk := theme.TokensOf(c)
	if !hasQuotaData(acc) {
		display.Text(c, "—", display.TextProps{Type: display.TextSecondary})
		return
	}
	windows := quotaWindows(acc)
	for i, w := range windows {
		color := tk.Primary
		switch {
		case w.UsedPercent >= 90:
			color = tk.Error
		case w.UsedPercent >= 70:
			color = tk.Warning
		}
		line := ui.Row(c.Key(i)).Height(quotaLineHeight).Gap(6).AlignItems(ui.Center)
		line.Children(func() {
			ui.Column(c).Width(72).Children(func() {
				display.Text(c, quotaWindowLabel(w), display.TextProps{Type: display.TextSecondary, FontSize: 11}).SingleLine()
			})
			ui.Column(c).Grow(1).Basis(0).MinWidth(0).Children(func() {
				feedback.Progress(c, float32(w.UsedPercent), feedback.ProgressProps{Size: theme.Middle, Color: color})
			})
			ui.Column(c).Width(30).AlignItems(ui.End).Children(func() {
				display.Text(c, fmt.Sprintf("%.0f%%", w.UsedPercent), display.TextProps{FontSize: 11}).FontFeatures("tnum").SingleLine()
			})
		})
		spoken := w.Label
		if w.Model != "" {
			spoken += "（" + w.Model + "）"
		}
		line.Label(fmt.Sprintf("%s 已用 %.0f%%", spoken, w.UsedPercent))
	}
	if credits := quotaCreditsOf(acc); credits != nil {
		val, status, warn := formatCredits(credits)
		props := display.TextProps{FontSize: 11}
		if warn {
			props.Type = display.TextWarning
		}
		line := ui.Row(c.Key("credits")).Height(quotaLineHeight).Gap(6).AlignItems(ui.Center)
		line.Children(func() {
			ui.Column(c).Width(72).Children(func() {
				display.Text(c, "Credits", display.TextProps{Type: display.TextSecondary, FontSize: 11}).SingleLine()
			})
			ui.Column(c).Grow(1).Basis(0).MinWidth(0).AlignItems(ui.End).Children(func() {
				display.Text(c, val, props).FontFeatures("tnum").SingleLine()
			})
		})
		line.Label(fmt.Sprintf("Credits %s %s", val, status))
	}
	if reset := quotaResetCreditsOf(acc); reset != nil {
		val := fmt.Sprintf("%d 张", reset.AvailableCount)
		line := ui.Row(c.Key("reset-credits")).Height(quotaLineHeight).Gap(6).AlignItems(ui.Center)
		line.Children(func() {
			ui.Column(c).Width(72).Children(func() {
				display.Text(c, "重置卡", display.TextProps{Type: display.TextSecondary, FontSize: 11}).SingleLine()
			})
			ui.Column(c).Grow(1).Basis(0).MinWidth(0).AlignItems(ui.End).Children(func() {
				display.Text(c, val, display.TextProps{FontSize: 11}).FontFeatures("tnum").SingleLine()
			})
		})
		line.Label("重置卡 " + val)
	}
	display.Text(c, "读取于 "+quotaLocalTime(acc.Quota.CheckedAt), display.TextProps{Type: display.TextSecondary, FontSize: 11}).SingleLine()
}

func (a *app) quotaResetCell(c *ui.Context, acc account) {
	if !hasQuotaData(acc) {
		display.Text(c, "—", display.TextProps{Type: display.TextSecondary})
		return
	}
	windows := quotaWindows(acc)
	for i, w := range windows {
		text := "用后开始计时"
		if w.ResetsAt != 0 {
			text = quotaLocalTime(w.ResetsAt)
		}
		ui.Row(c.Key(i)).Height(quotaLineHeight).AlignItems(ui.Center).Children(func() {
			display.Text(c, text, display.TextProps{Type: display.TextSecondary, FontSize: 11}).FontFeatures("tnum").SingleLine()
		})
	}
	if credits := quotaCreditsOf(acc); credits != nil {
		_, status, warn := formatCredits(credits)
		props := display.TextProps{Type: display.TextSecondary, FontSize: 11}
		if warn {
			props.Type = display.TextWarning
		}
		ui.Row(c.Key("credits")).Height(quotaLineHeight).AlignItems(ui.Center).Children(func() {
			display.Text(c, status, props).FontFeatures("tnum").SingleLine()
		})
	}
	if reset := quotaResetCreditsOf(acc); reset != nil {
		text := "—"
		if reset.AvailableCount > 0 && reset.NextExpiresAt != 0 {
			text = quotaExpiryDate(reset.NextExpiresAt)
		}
		ui.Row(c.Key("reset-credits")).Height(quotaLineHeight).AlignItems(ui.Center).Children(func() {
			display.Text(c, text, display.TextProps{Type: display.TextSecondary, FontSize: 11}).FontFeatures("tnum").SingleLine()
		})
	}
}

// accountQuotaError shows why the last read failed; the previous windows stay in the row.
func (a *app) accountQuotaError(c *ui.Context, acc account) {
	if !hasQuota(acc) {
		return
	}
	message := a.errors["account:quota:"+acc.ID]
	if message == "" && acc.Quota != nil {
		message = acc.Quota.Error
	}
	if message != "" {
		ui.Column(c).Padding(0, 12, 10, 12).Children(func() { fieldError(c, "额度："+message) })
	}
}
