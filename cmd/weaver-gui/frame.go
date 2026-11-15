// 应用外框：左侧导航照 Lobe MyGo desktop 示例的 sidebar/navitem 做，
// 窄窗口（<900）时导航收到内容上方；每页标题区由 pageHeader 统一。
package main

import (
	"github.com/egoist/mygo/ui"
	"github.com/lobehub/lobe-mygo/pkg/display"
	"github.com/lobehub/lobe-mygo/pkg/lucide"
	"github.com/lobehub/lobe-mygo/pkg/theme"
)

var navPages = []struct {
	name string
	icon func() *ui.SVG
}{
	{"概览", lucide.House},
	{"任务", lucide.ListTodo},
	{"账号", lucide.Users},
	{"候选", lucide.Bot},
	{"设置", lucide.Settings},
}

func pageIcon(page string) *ui.SVG {
	for _, p := range navPages {
		if p.name == page {
			return p.icon()
		}
	}
	return lucide.House()
}

// navItem is the sidebar row: an icon and a label, with a resting, hover and
// selected surface taken from the theme. It reports a click, as the desktop
// example's navItem does.
func navItem(c *ui.Context, icon *ui.SVG, label string, active, compact bool) bool {
	tk := theme.TokensOf(c)
	height := float32(36)
	padX, gap, glyph, fontSize := float32(6), float32(8), float32(18), tk.FontSize
	iconBox := float32(26)
	if compact {
		height, padX, gap, glyph, fontSize = 32, 8, 5, 16, 13
		iconBox = 20
	}
	row := ui.ButtonBase(c).Label(label).Row().Height(height).PaddingX(padX).Gap(gap).
		AlignItems(ui.Center).Justify(ui.Start).Radius(tk.BorderRadius).Cursor(ui.CursorPointer)
	hovered := row.Hovered()
	text, glyphColor := tk.TextSecondary, tk.TextTertiary
	switch {
	case active && hovered:
		row.Background(tk.FillSecondary)
	case active, hovered:
		row.Background(tk.FillTertiary)
	}
	if active {
		text, glyphColor = tk.Text, tk.Text
	}
	row.Children(func() {
		ui.Row(c).Size(iconBox, iconBox).Shrink(0).Center().TextColor(glyphColor).Children(func() {
			ui.Icon(c, icon).FontSize(glyph)
		})
		ui.Text(c, label).FontSize(fontSize).TextColor(text).SingleLine()
	})
	return row.Clicked()
}

// navigation draws the sidebar, or the top bar under 900 DIPs.
func (a *app) navigation(c *ui.Context, compact bool) {
	if compact {
		ui.Row(c).FillWidth().Shrink(0).Padding(4, 6).Gap(4).AlignItems(ui.Center).Children(func() {
			brand(c, compact)
			ui.Box(c).Width(4)
			for _, page := range navPages {
				if navItem(c.Key("nav:"+page.name), page.icon(), page.name, a.page == page.name, true) {
					a.navigateTo(page.name)
				}
			}
		})
		return
	}
	ui.Column(c).Width(212).Shrink(0).Padding(4).Children(func() {
		ui.Column(c).Padding(8, 8, 12, 8).Children(func() { brand(c, false) })
		ui.Column(c).Gap(2).Children(func() {
			for _, page := range navPages {
				if navItem(c.Key("nav:"+page.name), page.icon(), page.name, a.page == page.name, false) {
					a.navigateTo(page.name)
				}
			}
		})
		ui.Box(c).Grow(1)
		if a.loaded && a.snapshot.Version != "" {
			display.Text(c, "版本 "+a.snapshot.Version, display.TextProps{Type: display.TextSecondary, FontSize: 11}).Padding(12, 8)
		}
	})
}

func (a *app) navigateTo(page string) {
	a.page = page
	if page == "设置" && !a.skillChecked {
		a.checkSkill()
	}
}

// pageHeader is the one title area: a 24 DIP title, a 13 DIP subtitle and the
// page's actions, aligned to the same baseline on every page.
func (a *app) pageHeader(c *ui.Context, title, subtitle string, actions func()) {
	tk := theme.TokensOf(c)
	width, _ := c.Size()
	titleSize := float32(24)
	subtitleSize := float32(13)
	if width < 900 {
		titleSize, subtitleSize = 21, 12
	}
	ui.Row(c).FillWidth().Gap(16).AlignItems(ui.Center).Children(func() {
		ui.Column(c).Grow(1).Basis(0).MinWidth(0).Gap(3).Children(func() {
			ui.Text(c, title).FontSize(titleSize).FontWeight(600).TextColor(tk.Text).SingleLine()
			if subtitle != "" {
				ui.Text(c, subtitle).FontSize(subtitleSize).TextColor(tk.TextTertiary).SingleLine()
			}
		})
		if actions != nil {
			ui.Row(c).Gap(8).AlignItems(ui.Center).Shrink(0).Wrap().Children(actions)
		}
	})
}
