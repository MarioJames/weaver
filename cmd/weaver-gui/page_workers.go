package main

import (
	"fmt"
	"sort"
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
			for i, label := range []string{"候选", "能力分", "首次采纳", "中位耗时", "账号", "在跑", "启用", "操作"} {
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
	sizes := []float32{0, 76, 76, 76, 190, 44, 52, 114}
	e := ui.Column(c).MinWidth(0)
	if i == 0 {
		e.Grow(1).Basis(0).MinWidth(160)
	} else {
		e.Width(sizes[i])
	}
	e.Children(body)
}

func (a *app) workerShares(c *ui.Context) {
	rated, unrated := []worker{}, 0
	for _, w := range a.snapshot.Workers {
		switch {
		case w.Intelligence == 0:
			unrated++
		case w.Enabled:
			rated = append(rated, w)
		}
	}
	sort.SliceStable(rated, func(i, j int) bool { return rated[i].Intelligence < rated[j].Intelligence })
	if len(rated) == 0 {
		inlineError(c, "没有已评分的候选", "没有指定候选的包不会被派发。给至少一个启用的候选填上能力分。")
	}
	section(c, "包只交给能力分不低于它需求分的候选：", func() {
		tk := theme.TokensOf(c)
		if len(rated) > 0 {
			ui.Row(c).Height(34).Radius(8).Background(tk.FillSecondary).Clip().Children(func() {
				for i, w := range rated {
					color, textColor := tk.Primary, tk.PrimaryForeground
					if i%2 == 1 {
						color, textColor = tk.FillSecondary, tk.Text
					}
					ui.Column(c.Key(w.ID)).Grow(1).Basis(0).MinWidth(0).Background(color).Justify(ui.Center).Padding(8).Children(func() {
						display.Text(c, fmt.Sprintf("%g · %s", w.Intelligence, w.ID), display.TextProps{FontSize: 12}).TextColor(textColor).SingleLine()
					})
				}
			})
		}
		note := "能力分从左到右递增；够格的候选之间按首次采纳率、耗时、额度和在跑数安排。"
		if unrated > 0 {
			note += fmt.Sprintf("其余 %d 个未评分：只在包指定它时使用。", unrated)
		}
		display.Text(c, note, display.TextProps{Type: display.TextSecondary, FontSize: 12})
		for _, w := range a.snapshot.Workers {
			if !w.Available && w.Reason != "" && w.Intelligence != 0 {
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
					f.value = workerIntelligenceText(w.Intelligence)
				}
				ui.Column(c).Width(64).Children(func() {
					input := field.Input(c, &f.value, field.InputProps{Size: theme.Small, Placeholder: "未评分"}).Label(w.ID + " 能力分").Disabled(a.busy[key])
					if input.Changed() {
						f.dirty = true
						f.err = ""
					}
					if f.dirty && (input.Submitted() || input.FocusLeft()) {
						n, err := parseWorkerIntelligence(f.value)
						if err != nil || !validWorkerIntelligence(n) {
							f.err = "能力分只能为 0（未评分）或 1–10，步长 0.5"
						} else {
							a.action(key, func() (string, error) {
								err := a.client.call("worker.set", map[string]any{"id": w.ID, "intelligence": n}, nil)
								if err == nil {
									a.refresh()
								}
								return "", err
							}, func(_ string, err error) {
								f.dirty = false
								if err != nil {
									f.err = err.Error()
									f.value = workerIntelligenceText(w.Intelligence)
								}
							})
						}
					}
					fieldError(c, f.err)
				})
			})
			workerCell(c, 2, func() {
				if w.Stats.Samples == 0 {
					display.Text(c, "—", display.TextProps{Type: display.TextSecondary})
					return
				}
				display.Text(c, fmt.Sprintf("%.0f%%", w.Stats.FirstAcceptanceRate*100), display.TextProps{}).FontFeatures("tnum")
				display.Text(c, fmt.Sprintf("%d 次", w.Stats.Samples), display.TextProps{Type: display.TextSecondary, FontSize: 11})
			})
			workerCell(c, 3, func() {
				if w.Stats.Samples == 0 {
					display.Text(c, "—", display.TextProps{Type: display.TextSecondary})
					return
				}
				display.Text(c, workerDurationText(w.Stats.MedianSeconds), display.TextProps{}).FontFeatures("tnum")
			})
			workerCell(c, 4, func() {
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
			workerCell(c, 5, func() { display.Text(c, strconv.Itoa(w.Running), display.TextProps{}).FontFeatures("tnum") })
			workerCell(c, 6, func() {
				on := w.Enabled
				if choice.Switch(c, &on, choice.SwitchProps{Size: theme.Small}).Label(w.ID + " 启用").Disabled(a.busy[key+":enabled"]).Changed() {
					a.write(key+":enabled", "worker.set", map[string]any{"id": w.ID, "enabled": on})
				}
			})
			workerCell(c, 7, func() {
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
						display.Text(c, "能力分", display.TextProps{Type: display.TextSecondary, FontSize: 12})
						if !f.dirty && !a.busy[key] {
							f.value = workerIntelligenceText(w.Intelligence)
						}
						ui.Column(c).Width(64).Children(func() {
							input := field.Input(c, &f.value, field.InputProps{Size: theme.Small, Placeholder: "未评分"}).Label(w.ID + " 能力分").Disabled(a.busy[key])
							if input.Changed() {
								f.dirty = true
								f.err = ""
							}
							if f.dirty && (input.Submitted() || input.FocusLeft()) {
								n, err := parseWorkerIntelligence(f.value)
								if err != nil || !validWorkerIntelligence(n) {
									f.err = "能力分只能为 0（未评分）或 1–10，步长 0.5"
								} else {
									a.action(key, func() (string, error) {
										err := a.client.call("worker.set", map[string]any{"id": w.ID, "intelligence": n}, nil)
										if err == nil {
											a.refresh()
										}
										return "", err
									}, func(_ string, err error) {
										f.dirty = false
										if err != nil {
											f.err = err.Error()
											f.value = workerIntelligenceText(w.Intelligence)
										}
									})
								}
							}
						})
					})
					display.Text(c, workerStatsText(w), display.TextProps{Type: display.TextSecondary, FontSize: 11})
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

func workerStatsText(w worker) string {
	if w.Intelligence == 0 {
		return "未评分：只在包指定它时使用"
	}
	if w.Stats.Samples == 0 {
		return "暂无数据"
	}
	return fmt.Sprintf("首次采纳 %.0f%% · 中位耗时 %.0f 分", w.Stats.FirstAcceptanceRate*100, w.Stats.MedianSeconds/60)
}

// An unrated candidate shows an empty field with a placeholder instead of a bare 0.
func workerIntelligenceText(n float64) string {
	if n == 0 {
		return ""
	}
	return strconv.FormatFloat(n, 'f', -1, 64)
}

func parseWorkerIntelligence(text string) (float64, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return 0, nil
	}
	return strconv.ParseFloat(text, 64)
}

func workerDurationText(seconds float64) string {
	if seconds < 90 {
		return fmt.Sprintf("%.0f 秒", seconds)
	}
	return fmt.Sprintf("%.0f 分", seconds/60)
}
