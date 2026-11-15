// 表单排版的唯一来源：账号抽屉、用量面板、候选编辑器都走 formRow / formHelp。
// 标签列固定宽度、与第一行控件垂直居中；帮助文字在控件下方，字号和颜色一致。
package main

import (
	"github.com/egoist/mygo/ui"
	"github.com/lobehub/lobe-mygo/pkg/display"
	"github.com/lobehub/lobe-mygo/pkg/theme"
)

const formLabelWidth float32 = 104

// formRow puts label in a fixed column and body in the control column. The
// label is centered on the first control row (24 DIPs, the small field size),
// so labels and inputs share a baseline even when help text follows.
func formRow(c *ui.Context, label string, body func(label ui.Element)) {
	ui.Row(c).Gap(14).AlignItems(ui.Start).Children(func() {
		labelEl := ui.Row(c).Width(formLabelWidth).Height(24).AlignItems(ui.Center).Shrink(0).Children(func() {
			display.Text(c, label, display.TextProps{Strong: true}).SingleLine()
		})
		ui.Column(c).Grow(1).Basis(0).MinWidth(0).Children(func() { body(labelEl) })
	})
}

// formHelp is the single help-text style under a control.
func formHelp(c *ui.Context, text string) {
	if text == "" {
		return
	}
	display.Text(c, text, display.TextProps{Type: display.TextSecondary, FontSize: 12}).Padding(5, 0, 0, 0)
}

// formFieldStack is a control followed by its help text.
func formFieldStack(c *ui.Context, body func()) {
	ui.Column(c).Gap(2).Children(body)
}

// formDivider separates groups inside one scrolling form.
func formDivider(c *ui.Context) {
	tk := theme.TokensOf(c)
	ui.Box(c).Height(1).AlignSelf(ui.Stretch).Background(tk.Split).Margin(8, 0)
}

// formGroupHeader names a group inside a long drawer form.
func formGroupHeader(c *ui.Context, title string) {
	tk := theme.TokensOf(c)
	ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
		ui.Text(c, title).FontSize(13).FontWeight(600).TextColor(tk.Text)
		ui.Box(c).Grow(1).Height(1).Background(tk.Split)
	})
}

func (a *app) primaryButton(c *ui.Context, key, label string, clicked func()) {
	text := label
	if a.busy[key] {
		text = label + "中…"
	}
	b := ui.PrimaryButton(c, text)
	b.Disabled(a.busy[key])
	if b.Clicked() {
		clicked()
	}
}
