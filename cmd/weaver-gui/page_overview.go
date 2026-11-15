package main

import (
	"fmt"
	"time"

	"github.com/egoist/mygo/ui"
	"github.com/lobehub/lobe-mygo/pkg/lucide"
	"github.com/lobehub/lobe-mygo/pkg/theme"
)

func (s snapshot) availableCounts() (accounts, workers int) {
	for _, a := range s.Accounts {
		if a.Enabled && a.Ready && a.PausedUntil <= time.Now().UnixMilli() {
			accounts++
		}
	}
	for _, w := range s.Workers {
		if w.Enabled && w.Available {
			workers++
		}
	}
	return
}
func (s snapshot) warnings() []string {
	used := map[string]bool{}
	positive := false
	for _, w := range s.Workers {
		for _, id := range w.Accounts {
			used[id] = true
		}
		if w.Weight > 0 {
			positive = true
		}
	}
	var warnings []string
	unused := 0
	for _, a := range s.Accounts {
		if !used[a.ID] {
			unused++
		}
		if !a.Ready {
			warnings = append(warnings, a.Label+" 未就绪")
		}
		if a.Usage != nil && a.Usage.Low {
			threshold := 0.0
			if a.Usage.AlertBelow != nil {
				threshold = *a.Usage.AlertBelow
			}
			warnings = append(warnings, fmt.Sprintf("%s 估算剩余低于 $%g", a.Label, threshold))
		}
	}
	if unused > 0 {
		warnings = append([]string{fmt.Sprintf("%d 个账号没有候选在用", unused)}, warnings...)
	}
	if !positive {
		warnings = append(warnings, "没有权重大于 0 的候选")
	}
	return warnings
}

func (a *app) overviewPage(c *ui.Context) {
	s := a.snapshot
	uptime := time.Since(time.UnixMilli(s.StartedAt))
	if uptime < 0 {
		uptime = 0
	}
	a.pageHeader(c, "概览", fmt.Sprintf("版本 %s · 运行时长 %d 小时 %d 分钟", s.Version, int(uptime.Hours()), int(uptime.Minutes())%60), nil)

	ac, wc := s.availableCounts()
	ui.Row(c).FillWidth().Gap(12).Wrap().Children(func() {
		metrics := []struct{ label, value string }{
			{"并行占用", fmt.Sprintf("%d / %d", s.Overview.Active, s.Overview.Capacity)},
			{"开放的主任务", fmt.Sprint(s.Overview.Missions)},
			{"定时器", fmt.Sprint(s.Overview.Timers)},
			{"可用账号", fmt.Sprintf("%d / %d", ac, len(s.Accounts))},
			{"可用候选", fmt.Sprintf("%d / %d", wc, len(s.Workers))},
		}
		for _, metric := range metrics {
			a.metricCard(c, metric.label, metric.value)
		}
	})

	section(c, "要注意", func() {
		warnings := s.warnings()
		if len(warnings) == 0 {
			ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
				ui.Icon(c, lucide.CircleCheck()).FontSize(15).TextColor(theme.TokensOf(c).Success)
				ui.Text(c, "没有要注意的事项").FontSize(13).TextColor(theme.TokensOf(c).TextSecondary)
			})
			return
		}
		for _, warning := range warnings {
			ui.Row(c).Gap(8).AlignItems(ui.Start).Children(func() {
				ui.Icon(c, lucide.CircleAlert()).FontSize(14).TextColor(theme.TokensOf(c).Warning).Margin(2, 0, 0, 0).Shrink(0)
				ui.Text(c, warning).FontSize(13).TextColor(theme.TokensOf(c).TextSecondary)
			})
		}
	})
}

func (a *app) metricCard(c *ui.Context, label, value string) {
	tk := theme.TokensOf(c)
	ui.Column(c).Grow(1).Basis(148).MinWidth(148).Padding(16).Gap(8).Radius(12).
		Background(tk.FillTertiary).Children(func() {
		ui.Text(c, label).FontSize(12).TextColor(tk.TextTertiary).SingleLine()
		ui.Text(c, value).FontSize(26).FontWeight(600).TextColor(tk.Text).FontFeatures("tnum").SingleLine()
	})
}
