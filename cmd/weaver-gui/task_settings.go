package main

import (
	"github.com/egoist/mygo/ui"
	"github.com/lobehub/lobe-mygo/pkg/display"
	"github.com/lobehub/lobe-mygo/pkg/field"
	"github.com/lobehub/lobe-mygo/pkg/theme"
)

func (a *app) autoArchiveSetting(c *ui.Context) {
	const key = "archive_after_days"
	f := a.fields[key]
	if f == nil {
		f = &settingField{}
		a.fields[key] = f
	}
	if !f.dirty && !a.busy["config:"+key] {
		f.value = a.snapshot.Settings[key]
		if f.value == "" {
			f.value = "7"
		}
	}
	ui.Column(c).Key(key).Gap(2).Children(func() {
		ui.Row(c).Gap(16).AlignItems(ui.Center).Children(func() {
			label := ui.Row(c).Width(130).Height(24).AlignItems(ui.Center).Shrink(0).Children(func() {
				display.Text(c, "自动归档", display.TextProps{Strong: true}).SingleLine()
			})
			ui.Column(c).Width(140).Children(func() {
				selectField := field.Select(c, &f.value, field.SelectProps{Size: theme.Small, Options: []field.SelectOption{
					{Value: "0", Label: "关闭"},
					{Value: "1", Label: "1 天"},
					{Value: "3", Label: "3 天"},
					{Value: "7", Label: "7 天"},
					{Value: "30", Label: "30 天"},
				}}).Label("自动归档").LabelledBy(label).Disabled(a.busy["config:"+key])
				if selectField.Changed() {
					f.dirty = true
					a.saveSetting(key, f.value)
				}
			})
			display.Text(c, "父 Agent 已关闭的任务在这么多天没有活动后归档，未关闭的从不自动归档",
				display.TextProps{Type: display.TextSecondary, FontSize: 12}).Grow(1).Basis(0).MinWidth(0)
		})
		fieldError(c, f.err)
	})
}
