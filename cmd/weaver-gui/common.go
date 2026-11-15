// 后续页面复用 section、statusTag、fieldError、a.confirm 和 a.showToast。
// 它们只构建当前帧，不保留 ui.Element；按钮的异步状态使用 app.action。
package main

import (
	"time"

	"github.com/egoist/mygo/ui"
	"github.com/lobehub/lobe-mygo/pkg/display"
	"github.com/lobehub/lobe-mygo/pkg/lucide"
	"github.com/lobehub/lobe-mygo/pkg/theme"
)

func section(c *ui.Context, title string, body func()) {
	tk := theme.TokensOf(c)
	width, _ := c.Size()
	padding, gap := float32(16), float32(10)
	if width < 900 {
		padding, gap = 14, 8
	}
	ui.Column(c).Padding(padding).Gap(gap).Radius(12).Border(1, tk.BorderSecondary).Children(func() {
		ui.Text(c, title).FontSize(15).FontWeight(600).TextColor(tk.Text)
		ui.Column(c).Gap(gap).Children(body)
	})
}

// fieldError is the one inline error line: an icon and the service's exact
// message, never color alone.
func fieldError(c *ui.Context, message string) {
	if message == "" {
		return
	}
	tk := theme.TokensOf(c)
	ui.Row(c).Gap(6).AlignItems(ui.Start).TextColor(tk.Error).Children(func() {
		ui.Icon(c, lucide.CircleAlert()).FontSize(13).Margin(2, 0, 0, 0).Shrink(0)
		ui.Text(c, message).FontSize(12)
	})
}

func statusTag(c *ui.Context, state string) {
	label, color := "未就绪", display.TagWarning
	switch state {
	case "ready":
		label, color = "就绪", display.TagSuccess
	case "starting":
		label, color = "启动中", display.TagProcessing
	case "failed":
		label, color = "失败", display.TagError
	case "stopped":
		label, color = "已停止", display.TagColor("")
	}
	display.Tag(c, label, display.TagProps{Color: color})
}
func (a *app) button(c *ui.Context, key, label string, clicked func()) {
	text := label
	if a.busy[key] {
		text = label + "中…"
	}
	if ui.Button(c, text).Disabled(a.busy[key]).Clicked() {
		clicked()
	}
}
func (a *app) showToast(message string) {
	a.toast = message
	a.toastUntil = time.Now().Add(8 * time.Second)
}
func (a *app) toastView(c *ui.Context) {
	if a.toast == "" || !time.Now().Before(a.toastUntil) {
		return
	}
	tk := theme.TokensOf(c)
	ui.Overlay(c, func() {
		ui.Row(c).Absolute().Left(0).Right(0).Top(16).Justify(ui.Center).PaddingX(16).Children(func() {
			row := ui.Row(c).Padding(10, 14).Gap(12).Radius(tk.BorderRadiusLG).
				Background(tk.BgElevated).Border(1, tk.BorderSecondary).AlignItems(ui.Center)
			tk.Elevate(row, theme.BoxShadowSecondary)
			row.Children(func() {
				ui.Icon(c, lucide.CircleCheck()).FontSize(15).TextColor(tk.Success).Shrink(0)
				display.Text(c, a.toast, display.TextProps{}).Grow(1)
				b := ui.ButtonBase(c).Label("关闭提示").Size(22, 22).Radius(tk.BorderRadiusSM).Center().
					TextColor(tk.TextTertiary).Cursor(ui.CursorPointer)
				b.Children(func() { ui.Icon(c, lucide.X()).FontSize(13) })
				if b.Clicked() {
					a.toast = ""
				}
			})
		})
	})
	c.After(time.Until(a.toastUntil))
}
func (a *app) confirm(title, body string, action func()) {
	a.confirming = true
	a.confirmTitle = title
	a.confirmBody = body
	a.confirmAction = action
}
func (a *app) confirmView(c *ui.Context) {
	ui.Modal(c, &a.confirming, func() {
		display.Text(c, a.confirmTitle, display.TextProps{Heading: 4})
		display.Text(c, a.confirmBody, display.TextProps{Type: display.TextSecondary})
		ui.Row(c).Gap(12).Justify(ui.End).Children(func() {
			if ui.Button(c, "取消").Clicked() {
				a.confirming = false
			}
			if ui.PrimaryButton(c, "确认移除").Clicked() {
				a.confirming = false
				if a.confirmAction != nil {
					a.confirmAction()
				}
			}
		})
	})
}
func (a *app) serviceUnavailable(c *ui.Context) {
	tk := theme.TokensOf(c)
	ui.Column(c).Fill().AlignItems(ui.Center).Justify(ui.Center).Gap(16).Padding(32).Children(func() {
		ui.Row(c).Size(56, 56).Radius(28).Center().Background(tk.FillTertiary).Children(func() {
			ui.Icon(c, lucide.CircleAlert()).FontSize(28).TextColor(tk.Warning)
		})
		ui.Text(c, "Weaver 服务没有运行").FontSize(21).FontWeight(600).TextColor(tk.Text).TextAlign(ui.Center)
		ui.Text(c, a.reason).FontSize(13).TextColor(tk.TextTertiary).TextAlign(ui.Center).MaxWidth(460)
		if home := a.client.home; home != "" {
			label := "数据目录 " + home
			if _, custom := a.customDataHome(); custom {
				label = "自定义数据目录 " + home
			}
			ui.Text(c, label).FontSize(12).TextColor(tk.TextTertiary).TextAlign(ui.Center).MaxWidth(520)
		}
		a.button(c, "service:start", "启动服务", func() {
			a.action("service:start", func() (string, error) {
				out, err := startServiceFor(a.ctx, a.client.home)
				if err == nil {
					a.refresh()
				}
				return out, err
			}, nil)
		})
		fieldError(c, a.errors["service:start"])
		ui.Text(c, "启动后会自动回到原来的页面。").FontSize(12).TextColor(tk.TextTertiary)
	})
}
