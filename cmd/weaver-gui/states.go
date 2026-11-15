// 状态组件：空态、加载中、错误在任务、账号、候选三页共用同一套外观。
// 空态用 display.Empty，加载中用骨架，区域级错误用 feedback.Result，
// 行内错误用 fieldError（common.go）的图标加文字样式。
package main

import (
	"github.com/egoist/mygo/ui"
	"github.com/lobehub/lobe-mygo/pkg/action"
	"github.com/lobehub/lobe-mygo/pkg/display"
	"github.com/lobehub/lobe-mygo/pkg/feedback"
	"github.com/lobehub/lobe-mygo/pkg/theme"
)

// stateEmpty is the one empty state used by the list pages. It always offers
// the first useful action instead of ending at "暂无数据".
func stateEmpty(c *ui.Context, icon *ui.SVG, title, description, actionLabel string, clicked func()) {
	ui.Column(c).FillWidth().Padding(24, 8).Children(func() {
		display.Empty(c, display.EmptyProps{
			Icon:        icon,
			Title:       title,
			Description: description,
			Action: func() {
				if actionLabel == "" {
					return
				}
				b := action.Button(c, actionLabel, action.ButtonProps{})
				if b.Clicked() && clicked != nil {
					clicked()
				}
			},
		})
	})
}

// stateLoading holds a list's place with the same skeleton in every page.
func stateLoading(c *ui.Context, label string) {
	tk := theme.TokensOf(c)
	ui.Column(c).FillWidth().Gap(18).Padding(8, 0).Children(func() {
		if label != "" {
			ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
				display.Skeleton(c, display.SkeletonProps{Width: 120, Height: 14})
				ui.Text(c, label).FontSize(13).TextColor(tk.TextTertiary)
			})
		}
		for i := 0; i < 4; i++ {
			ui.Row(c).Gap(12).AlignItems(ui.Center).Children(func() {
				display.SkeletonAvatar(c, 30, display.AvatarCircle, display.SkeletonFade)
				ui.Column(c).Grow(1).Gap(8).Children(func() {
					display.Skeleton(c, display.SkeletonProps{Width: 180, Height: 14})
					display.Skeleton(c, display.SkeletonProps{Height: 11})
				})
			})
		}
	})
}

// stateError is the one region-level failure used by the list pages. retry is
// the only recovery action; a nil retry only explains the failure.
func stateError(c *ui.Context, title, detail string, retry func()) {
	ui.Column(c).FillWidth().Padding(24, 8).Children(func() {
		feedback.Result(c, feedback.ResultProps{
			Status:   feedback.ResultError,
			Title:    title,
			SubTitle: detail,
			Extra: func() {
				if retry == nil {
					return
				}
				if action.Button(c, "重新读取", action.ButtonProps{}).Clicked() {
					retry()
				}
			},
		})
	})
}

// inlineError is the compact error banner for a failed action inside a page.
func inlineError(c *ui.Context, title, detail string) {
	feedback.Alert(c, title, feedback.AlertProps{
		Type:        feedback.Error,
		Description: detail,
		Selectable:  true,
	})
}
