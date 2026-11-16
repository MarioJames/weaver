package main

import (
	"fmt"
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
type accountQuota struct {
	Status    string        `json:"status"`
	Windows   []quotaWindow `json:"windows"`
	Detail    string        `json:"detail,omitempty"`
	CheckedAt int64         `json:"checkedAt,omitempty"`
	Error     string        `json:"error,omitempty"`
	Factor    float64       `json:"factor"`
}

func quotaLocalTime(ms int64) string {
	t := time.UnixMilli(ms).Local()
	day := []string{"周日", "周一", "周二", "周三", "周四", "周五", "周六"}[t.Weekday()]
	return day + " " + t.Format("15:04")
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

// quotaUsedCell draws one bar per window. The reset times sit on the same lines
// of the next column, so both cells keep one fixed line height.
func (a *app) quotaUsedCell(c *ui.Context, acc account) {
	tk := theme.TokensOf(c)
	windows := quotaWindows(acc)
	if len(windows) == 0 {
		display.Text(c, "—", display.TextProps{Type: display.TextSecondary})
		return
	}
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
	display.Text(c, "读取于 "+quotaLocalTime(acc.Quota.CheckedAt), display.TextProps{Type: display.TextSecondary, FontSize: 11}).SingleLine()
}

func (a *app) quotaResetCell(c *ui.Context, acc account) {
	windows := quotaWindows(acc)
	if len(windows) == 0 {
		display.Text(c, "—", display.TextProps{Type: display.TextSecondary})
		return
	}
	for i, w := range windows {
		text := "用后开始计时"
		if w.ResetsAt != 0 {
			text = quotaLocalTime(w.ResetsAt)
		}
		ui.Row(c.Key(i)).Height(quotaLineHeight).AlignItems(ui.Center).Children(func() {
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
