package main

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/egoist/mygo/ui"
	"github.com/lobehub/lobe-mygo/pkg/action"
	"github.com/lobehub/lobe-mygo/pkg/choice"
	"github.com/lobehub/lobe-mygo/pkg/display"
	"github.com/lobehub/lobe-mygo/pkg/field"
	"github.com/lobehub/lobe-mygo/pkg/lucide"
	"github.com/lobehub/lobe-mygo/pkg/theme"
)

func (a *app) workersPage(c *ui.Context) {
	root := ui.Column(c).Key("workers-page")
	state := ui.Local(root, "workers", func() workerPageState { return workerPageState{} })
	root.Children(func() {
		a.pageHeader(c, "候选", fmt.Sprintf("%d 个候选", len(a.snapshot.Workers)), func() {
			if ui.PrimaryButton(c, "新建候选").Clicked() {
				state.open(a, nil)
			}
		})
		width, _ := c.Size()
		switch {
		case len(a.snapshot.Workers) == 0:
			stateEmpty(c, lucide.Bot(), "还没有候选", "候选决定一个包交给哪个引擎、模型和账号。先从已在用的账号建一个。", "新建候选", func() {
				state.open(a, nil)
			})
		default:
			a.workerShares(c)
			if width < 1080 {
				a.workerCards(c, state)
			} else {
				a.workerTable(c, state)
			}
		}
	})
	state.drawer(a, c)
}

func (a *app) workerTable(c *ui.Context, state *workerPageState) {
	tk := theme.TokensOf(c)
	ui.Column(c).Border(1, tk.BorderSecondary).Radius(10).Clip().Children(func() {
		ui.Row(c).Padding(10, 12).Gap(12).Background(tk.FillQuaternary).AlignItems(ui.Center).Children(func() {
			for i, label := range []string{"候选", "权重", "账号", "在跑", "启用", "操作"} {
				workerCell(c, i, func() {
					display.Text(c, label, display.TextProps{Type: display.TextSecondary, Strong: true, FontSize: 12})
				})
			}
		})
		ui.Box(c).Height(1).AlignSelf(ui.Stretch).Background(tk.Split)
		for i, w := range a.snapshot.Workers {
			a.workerRow(c.Key(w.ID), w, state, i < len(a.snapshot.Workers)-1)
		}
	})
}

func workerCell(c *ui.Context, i int, body func()) {
	sizes := []float32{0, 76, 210, 44, 52, 114}
	e := ui.Column(c).MinWidth(0)
	if i == 0 {
		e.Grow(1).Basis(0).MinWidth(160)
	} else {
		e.Width(sizes[i])
	}
	e.Children(body)
}

func (a *app) workerShares(c *ui.Context) {
	total, zero := 0, 0
	for _, w := range a.snapshot.Workers {
		if w.Enabled && w.Weight > 0 {
			total += w.Weight
		}
		if w.Weight == 0 {
			zero++
		}
	}
	if total == 0 {
		inlineError(c, "没有权重大于 0 的候选", "没有指定候选的包不会被派发。给至少一个候选设置大于 0 的权重。")
	}
	section(c, "没有指定候选的包，按权重这样分：", func() {
		tk := theme.TokensOf(c)
		if total > 0 {
			segments := 0
			ui.Row(c).Height(34).Radius(8).Background(tk.FillSecondary).Clip().Children(func() {
				for _, w := range a.snapshot.Workers {
					if !w.Enabled || w.Weight <= 0 {
						continue
					}
					color := tk.Primary
					textColor := tk.PrimaryForeground
					if segments%2 == 1 {
						color = tk.FillSecondary
						textColor = tk.Text
					}
					segments++
					ui.Column(c.Key(w.ID)).Grow(float32(w.Weight)).Basis(0).MinWidth(0).Background(color).Justify(ui.Center).Padding(8).Children(func() {
						display.Text(c, fmt.Sprintf("%s %.0f%%", w.ID, 100*float64(w.Weight)/float64(total)), display.TextProps{FontSize: 12}).TextColor(textColor).SingleLine()
					})
				}
			})
		}
		display.Text(c, fmt.Sprintf("其余 %d 个权重为 0：只在包指定它时使用", zero), display.TextProps{Type: display.TextSecondary, FontSize: 12})
		for _, w := range a.snapshot.Workers {
			if !w.Available && w.Reason != "" {
				fieldError(c, w.ID+"："+w.Reason)
			}
		}
	})
}

func (a *app) workerRow(c *ui.Context, w worker, s *workerPageState, divider bool) {
	tk := theme.TokensOf(c)
	key := "worker:" + w.ID
	ui.Column(c).Gap(4).Children(func() {
		row := ui.Row(c).Gap(12).AlignItems(ui.Center).Padding(10, 12)
		if row.Hovered() {
			row.Background(tk.FillQuaternary)
		}
		row.Children(func() {
			workerCell(c, 0, func() {
				display.Text(c, w.ID, display.TextProps{Strong: true}).MaxLines(1)
				display.Text(c, strings.Join([]string{w.Engine, w.Model, w.Effort}, " · "), display.TextProps{Type: display.TextSecondary, FontSize: 11}).MaxLines(1)
			})
			workerCell(c, 1, func() {
				f := a.fields[key]
				if f == nil {
					f = &settingField{}
					a.fields[key] = f
				}
				if !f.dirty && !a.busy[key] {
					f.value = strconv.Itoa(w.Weight)
				}
				ui.Column(c).Width(64).Children(func() {
					input := field.Input(c, &f.value, field.InputProps{Size: theme.Small}).Label(w.ID + " 权重").Disabled(a.busy[key])
					if input.Changed() {
						f.dirty = true
						f.err = ""
					}
					if f.dirty && (input.Submitted() || input.FocusLeft()) {
						n, err := strconv.Atoi(f.value)
						if err != nil {
							f.err = "权重需要整数"
						} else {
							a.action(key, func() (string, error) {
								err := a.client.call("worker.set", map[string]any{"id": w.ID, "weight": n}, nil)
								if err == nil {
									a.refresh()
								}
								return "", err
							}, func(_ string, err error) {
								f.dirty = false
								if err != nil {
									f.err = err.Error()
									f.value = strconv.Itoa(w.Weight)
								}
							})
						}
					}
					fieldError(c, f.err)
				})
			})
			workerCell(c, 2, func() {
				for _, id := range w.Accounts {
					label := "账号"
					for _, acc := range a.snapshot.Accounts {
						if acc.ID == id && acc.Label != "" {
							label = acc.Label
							break
						}
					}
					display.Text(c, label, display.TextProps{FontSize: 13}).MaxLines(1)
				}
			})
			workerCell(c, 3, func() { display.Text(c, strconv.Itoa(w.Running), display.TextProps{}).FontFeatures("tnum") })
			workerCell(c, 4, func() {
				on := w.Enabled
				if choice.Switch(c, &on, choice.SwitchProps{Size: theme.Small}).Label(w.ID + " 启用").Disabled(a.busy[key+":enabled"]).Changed() {
					a.write(key+":enabled", "worker.set", map[string]any{"id": w.ID, "enabled": on})
				}
			})
			workerCell(c, 5, func() {
				ui.Row(c).Gap(4).Children(func() {
					b := action.Button(c, "编辑", action.ButtonProps{Size: theme.Small})
					b.Label("编辑 " + w.ID)
					if b.Clicked() {
						s.open(a, &w)
					}
					d := action.Button(c, "删除", action.ButtonProps{Size: theme.Small})
					d.Label("删除 " + w.ID)
					if d.Clicked() {
						a.confirm("删除候选", w.ID, func() { a.write(key+":delete", "worker.remove", map[string]string{"id": w.ID}) })
					}
				})
			})
		})
		ui.Column(c).Padding(0, 12, 8, 12).Children(func() {
			fieldError(c, a.errors[key+":enabled"])
			fieldError(c, a.errors[key+":delete"])
		})
		if divider {
			ui.Box(c).Height(1).AlignSelf(ui.Stretch).Background(tk.Split)
		}
	})
}

func (a *app) workerCards(c *ui.Context, state *workerPageState) {
	tk := theme.TokensOf(c)
	ui.Column(c).Gap(12).Children(func() {
		for _, w := range a.snapshot.Workers {
			w := w
			key := "worker:" + w.ID
			f := a.fields[key]
			if f == nil {
				f = &settingField{}
				a.fields[key] = f
			}
			ui.Column(c).Key("worker-card:"+w.ID).Gap(10).Padding(16).Radius(12).Border(1, tk.BorderSecondary).Children(func() {
				ui.Row(c).Gap(12).AlignItems(ui.Center).Children(func() {
					ui.Column(c).Grow(1).Basis(0).MinWidth(0).Gap(2).Children(func() {
						display.Text(c, w.ID, display.TextProps{Strong: true}).MaxLines(1)
						display.Text(c, strings.Join([]string{w.Engine, w.Model, w.Effort}, " · "), display.TextProps{Type: display.TextSecondary, FontSize: 11}).MaxLines(2)
					})
					on := w.Enabled
					if choice.Switch(c, &on, choice.SwitchProps{Size: theme.Small}).Label(w.ID + " 启用").Disabled(a.busy[key+":enabled"]).Changed() {
						a.write(key+":enabled", "worker.set", map[string]any{"id": w.ID, "enabled": on})
					}
				})
				ui.Row(c).Gap(20).AlignItems(ui.Center).Wrap().Children(func() {
					ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
						display.Text(c, "权重", display.TextProps{Type: display.TextSecondary, FontSize: 12})
						if !f.dirty && !a.busy[key] {
							f.value = strconv.Itoa(w.Weight)
						}
						ui.Column(c).Width(64).Children(func() {
							input := field.Input(c, &f.value, field.InputProps{Size: theme.Small}).Label(w.ID + " 权重").Disabled(a.busy[key])
							if input.Changed() {
								f.dirty = true
								f.err = ""
							}
							if f.dirty && (input.Submitted() || input.FocusLeft()) {
								n, err := strconv.Atoi(f.value)
								if err != nil {
									f.err = "权重需要整数"
								} else {
									a.action(key, func() (string, error) {
										err := a.client.call("worker.set", map[string]any{"id": w.ID, "weight": n}, nil)
										if err == nil {
											a.refresh()
										}
										return "", err
									}, func(_ string, err error) {
										f.dirty = false
										if err != nil {
											f.err = err.Error()
											f.value = strconv.Itoa(w.Weight)
										}
									})
								}
							}
						})
					})
					display.Text(c, "在跑 "+strconv.Itoa(w.Running), display.TextProps{Type: display.TextSecondary, FontSize: 12})
					for _, id := range w.Accounts {
						label := "账号"
						for _, acc := range a.snapshot.Accounts {
							if acc.ID == id && acc.Label != "" {
								label = acc.Label
								break
							}
						}
						display.Text(c, "账号 "+label, display.TextProps{Type: display.TextSecondary, FontSize: 12})
					}
				})
				fieldError(c, f.err)
				ui.Row(c).Gap(4).Children(func() {
					b := action.Button(c, "编辑", action.ButtonProps{Size: theme.Small})
					b.Label("编辑 " + w.ID)
					if b.Clicked() {
						state.open(a, &w)
					}
					d := action.Button(c, "删除", action.ButtonProps{Size: theme.Small})
					d.Label("删除 " + w.ID)
					if d.Clicked() {
						a.confirm("删除候选", w.ID, func() { a.write(key+":delete", "worker.remove", map[string]string{"id": w.ID}) })
					}
				})
				fieldError(c, a.errors[key+":enabled"])
				fieldError(c, a.errors[key+":delete"])
			})
		}
	})
}
