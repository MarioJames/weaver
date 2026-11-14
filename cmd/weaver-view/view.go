package main

import (
	"fmt"
	"strings"

	"github.com/egoist/mygo/ui"
	"github.com/lobehub/lobe-mygo/pkg/display"
	"github.com/lobehub/lobe-mygo/pkg/field"
	"github.com/lobehub/lobe-mygo/pkg/layout"
	"github.com/lobehub/lobe-mygo/pkg/theme"
)

var stateColors = [...]display.TagColor{"", display.TagProcessing, display.TagInfo, display.TagWarning, display.TagSuccess, display.TagError, ""}

func (a *app) view(c *ui.Context) {
	theme.Apply(c)
	tk := theme.TokensOf(c)
	ui.Row(c).Fill().AlignItems(ui.Stretch).Background(tk.BgLayout).Children(func() {
		a.sidebar(c)
		a.detail(c)
	})
}

func (a *app) sidebar(c *ui.Context) {
	tk := theme.TokensOf(c)
	ui.Column(c).Width(300).Padding(16, 12).Gap(6).Children(func() {
		display.Text(c, "主任务", display.TextProps{Heading: 5}).Padding(0, 8, 8, 8)
		for i, m := range a.missions {
			n := m.counts()
			row := layout.Block(c, layout.BlockProps{Variant: layout.BlockBorderless, Clickable: true}).Padding(8, 10).Gap(2)
			if i == a.selected {
				row.Background(tk.FillSecondary)
			}
			row.Children(func() {
				display.Text(c, m.Title, display.TextProps{Strong: i == a.selected, Rows: 1})
				display.Text(c, fmt.Sprintf("运行中 %d · 待结论 %d · 已采纳 %d", n[stateRunning], n[stateAwaiting], n[stateAccepted]), display.TextProps{Type: display.TextSecondary, FontSize: 12})
			})
			if row.Clicked() {
				a.selected = i
			}
		}
	})
}

func (a *app) detail(c *ui.Context) {
	tk := theme.TokensOf(c)
	m := a.missions[a.selected]
	rows := m.Packages
	if q := strings.TrimSpace(a.query); q != "" {
		rows = nil
		for _, p := range m.Packages {
			if strings.Contains(p.Title, q) {
				rows = append(rows, p)
			}
		}
	}
	ui.Column(c).Grow(1).Basis(0).MinWidth(0).Padding(16, 20).Gap(12).Background(tk.BgContainer).Children(func() {
		display.Text(c, m.Title, display.TextProps{Heading: 4})
		n := m.counts()
		ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
			for s := range stateLabels {
				display.Tag(c, fmt.Sprintf("%s %d", stateLabels[s], n[s]), display.TagProps{Color: stateColors[s]})
			}
		})
		field.SearchBar(c, &a.query, field.SearchBarProps{Placeholder: "搜索工作包"})
		ui.List(c, nil, len(rows), func(i int) {
			p := rows[i]
			ui.Row(c).Padding(8, 4).Gap(12).AlignItems(ui.Center).Children(func() {
				ui.Row(c).Width(64).Children(func() {
					display.Tag(c, p.State.String(), display.TagProps{Color: stateColors[p.State]})
				})
				display.Text(c, p.Title, display.TextProps{Rows: 1}).Grow(1).Basis(0).MinWidth(0)
				if p.Attempt > 1 {
					display.Text(c, fmt.Sprintf("第 %d 次尝试", p.Attempt), display.TextProps{Type: display.TextSecondary, FontSize: 12})
				}
				display.Text(c, p.Engine, display.TextProps{Type: display.TextSecondary, FontSize: 12})
				display.Text(c, fmt.Sprintf("%d 分钟", p.Minutes), display.TextProps{Type: display.TextSecondary, FontSize: 12}).Width(56)
			})
		}).Grow(1).Basis(0).MinHeight(0).Children(func() {
			if len(rows) == 0 {
				display.Text(c, "没有匹配的工作包", display.TextProps{Type: display.TextSecondary}).Padding(12)
			}
		})
	})
}
