package main

import (
	"encoding/json"
	"fmt"
	"math"
	"slices"
	"sort"
	"strconv"
	"strings"

	"github.com/egoist/mygo/ui"
	"github.com/lobehub/lobe-mygo/pkg/choice"
	"github.com/lobehub/lobe-mygo/pkg/display"
	"github.com/lobehub/lobe-mygo/pkg/field"
	"github.com/lobehub/lobe-mygo/pkg/lucide"
	"github.com/lobehub/lobe-mygo/pkg/theme"
)

type workerModel struct {
	ID      string          `json:"id"`
	Efforts json.RawMessage `json:"reasoningEfforts"`
}
type workerConfig struct {
	Provider string `json:"provider"`
	Config   *struct {
		Models []workerModel `json:"models"`
	} `json:"config"`
}
type workerPageState struct {
	shown                                                          bool
	debater                                                        bool
	clearing                                                       bool
	original                                                       *worker
	id, engine, model, effort, intelligence, parallel, description string
	accounts                                                       []string
	configs                                                        map[string]workerConfig
	configErrors                                                   map[string]string
	err                                                            string
}

func (s *workerPageState) open(a *app, w *worker) {
	*s = workerPageState{shown: true, engine: "claude", intelligence: "0", parallel: "0", accounts: []string{}, configs: map[string]workerConfig{}, configErrors: map[string]string{}}
	if w != nil {
		v := *w
		s.original = &v
		s.id = w.ID
		s.engine = w.Engine
		s.model = w.Model
		s.effort = w.Effort
		s.intelligence = strconv.FormatFloat(w.Intelligence, 'f', -1, 64)
		s.parallel = strconv.Itoa(w.MaxParallel)
		s.description = w.Description
		s.accounts = append([]string{}, w.Accounts...)
	}
	s.loadConfigs(a)
}
func (s *workerPageState) openDebater(a *app, id string, w *worker) {
	s.open(a, w)
	s.debater = true
	s.id = id
}

func (s *workerPageState) loadConfigs(a *app) {
	if s.engine != "dsh" {
		return
	}
	for _, id := range s.accounts {
		if _, failed := s.configErrors[id]; failed {
			continue
		}
		if _, ok := s.configs[id]; ok {
			continue
		}
		key := "worker:config:" + id
		target := s.configs
		failures := s.configErrors
		a.action(key, func() (string, error) {
			var cfg workerConfig
			err := a.client.call("account.config", map[string]string{"id": id}, &cfg)
			b, _ := json.Marshal(cfg)
			return string(b), err
		}, func(body string, err error) {
			if err != nil {
				failures[id] = err.Error()
				return
			}
			var cfg workerConfig
			json.Unmarshal([]byte(body), &cfg)
			target[id] = cfg
			delete(failures, id)
		})
	}
}
func (s *workerPageState) options() ([]string, []string, bool) {
	models := []string{}
	var efforts []string
	constrained := false
	restrict := func(allowed []string) {
		if !constrained {
			efforts = allowed
			constrained = true
			return
		}
		efforts = slices.DeleteFunc(efforts, func(v string) bool { return !slices.Contains(allowed, v) })
	}
	for _, id := range s.accounts {
		cfg, loaded := s.configs[id]
		if !loaded {
			continue
		}
		if cfg.Provider == "" || cfg.Provider == "deepseek" || cfg.Provider == "deepseek-official" {
			restrict([]string{"off", "low", "high", "max"})
			continue
		}
		if cfg.Config == nil {
			continue
		}
		for _, m := range cfg.Config.Models {
			if !slices.Contains(models, m.ID) {
				models = append(models, m.ID)
			}
			if m.ID != s.model {
				continue
			}
			var offered map[string]any
			var allowed []string
			if string(m.Efforts) == "false" {
				allowed = []string{""}
			} else if json.Unmarshal(m.Efforts, &offered) == nil && len(offered) > 0 {
				for k := range offered {
					allowed = append(allowed, k)
				}
			} else {
				continue
			}
			restrict(allowed)
		}
	}
	sort.Strings(models)
	// Show reasoning intensity in its natural order, keeping custom keys supported.
	sort.Slice(efforts, func(i, j int) bool {
		order := func(v string) int {
			n := slices.Index([]string{"", "off", "minimal", "low", "medium", "high", "xhigh", "max"}, v)
			if n < 0 {
				return 99
			}
			return n
		}
		if order(efforts[i]) == order(efforts[j]) {
			return efforts[i] < efforts[j]
		}
		return order(efforts[i]) < order(efforts[j])
	})
	return models, efforts, constrained
}
func workerInput(c *ui.Context, label string, value *string, readonly bool) {
	formRow(c, label, func(labelEl ui.Element) {
		field.Input(c, value, field.InputProps{Size: theme.Small}).Label(label).LabelledBy(labelEl).Disabled(readonly)
	})
}

func (s *workerPageState) drawer(a *app, c *ui.Context) {
	if !s.shown {
		return
	}
	s.loadConfigs(a)
	ui.Overlay(c, func() {
		tk := theme.TokensOf(c)
		back := ui.Row(c).Absolute().Left(0).Right(0).Top(0).Bottom(0).Justify(ui.End).Background(ui.RGBA(0, 0, 0, 0.3)).Modal()
		back.Children(func() {
			screen, _ := c.Size()
			width := float32(520)
			if screen > 0 && screen-24 < width {
				width = screen - 24
			}
			panel := ui.Column(c).Width(width).FillHeight().Background(tk.BgContainer).Role(ui.RoleDialog).Label("候选编辑")
			panel.Children(func() {
				ui.Row(c).MinHeight(56).Padding(12, 20).Gap(8).AlignItems(ui.Center).Children(func() {
					title := "新建候选"
					if s.original != nil {
						title = "编辑 " + s.id
					}
					if s.debater {
						title = "配置" + debaterName(s.id)
						if s.original != nil {
							title = "编辑" + debaterName(s.id)
						}
					}
					ui.Text(c, title).FontSize(17).FontWeight(600).Grow(1)
					close := ui.ButtonBase(c).Label("关闭候选编辑").Size(28, 28).Radius(tk.BorderRadiusSM).Center().
						TextColor(tk.TextTertiary).Cursor(ui.CursorPointer)
					close.Children(func() { ui.Icon(c, lucide.X()).FontSize(16) })
					if close.Disabled(a.busy["worker:save"] || a.busy["worker:clear"]).Clicked() {
						s.shown = false
					}
				})
				ui.Box(c).Height(1).AlignSelf(ui.Stretch).Background(tk.Split)
				ui.Scroll(c).Grow(1).Basis(0).MinHeight(0).Padding(20, 24).Children(func() {
					ui.Column(c).Gap(12).Children(func() {
						if !s.debater {
							workerInput(c, "ID", &s.id, s.original != nil)
						}
						formRow(c, "引擎", func(label ui.Element) {
							if s.original != nil && !s.debater {
								display.Text(c, s.engine+"（建好后不能改）", display.TextProps{Type: display.TextSecondary})
							} else if ui.Select(c, &s.engine, []string{"claude", "codex", "opencode", "dsh"}).LabelledBy(label).Changed() {
								s.accounts = []string{}
								s.model = ""
								s.configs = map[string]workerConfig{}
								s.configErrors = map[string]string{}
								s.effort = ""
							}
						})
						formRow(c, "账号", func(label ui.Element) {
							ui.Column(c).Gap(6).Children(func() {
								found := false
								for _, acc := range a.snapshot.Accounts {
									if acc.Engine != s.engine {
										continue
									}
									found = true
									on := slices.Contains(s.accounts, acc.ID)
									if choice.Checkbox(c.Key(acc.ID), &on, acc.Label, choice.CheckboxProps{}).Changed() {
										if on {
											s.accounts = append(s.accounts, acc.ID)
										} else {
											s.accounts = slices.DeleteFunc(s.accounts, func(id string) bool { return id == acc.ID })
										}
										s.loadConfigs(a)
									}
								}
								if !found {
									display.Text(c, "这个引擎还没有账号。", display.TextProps{Type: display.TextSecondary, FontSize: 12})
								}
								formHelp(c, "只列 "+s.engine+" 的账号")
							})
						})
						for _, id := range s.accounts {
							fieldError(c, s.configErrors[id])
							if a.busy["worker:config:"+id] {
								formHelp(c, "正在读取配置…")
							}
						}
						models, efforts, constrained := s.options()
						if constrained && !slices.Contains(efforts, s.effort) {
							s.effort = ""
							if len(efforts) > 0 {
								s.effort = efforts[0]
							}
						}
						if s.engine == "dsh" {
							formRow(c, "模型", func(label ui.Element) {
								options := make([]field.SelectOption, 0, len(models)+1)
								if s.model != "" && !slices.Contains(models, s.model) {
									options = append(options, field.SelectOption{Value: s.model, Label: s.model})
								}
								for _, m := range models {
									options = append(options, field.SelectOption{Value: m, Label: m})
								}
								field.Select(c, &s.model, field.SelectProps{Size: theme.Small, Options: options, Placeholder: "选择模型"}).Label("模型").LabelledBy(label)
							})
							formRow(c, "强度", func(label ui.Element) {
								if constrained {
									field.Select(c, &s.effort, field.SelectProps{Size: theme.Small, Options: stringOptions(efforts)}).Label("强度").LabelledBy(label)
								} else {
									field.Input(c, &s.effort, field.InputProps{Size: theme.Small}).Label("强度").LabelledBy(label)
								}
							})
							formHelp(c, "模型清单来自选中的 dsh 渠道。")
						} else {
							workerInput(c, "模型", &s.model, false)
							workerInput(c, "强度", &s.effort, false)
						}
						if !s.debater {
							formRow(c, "能力分", func(label ui.Element) {
								ui.Column(c).Width(120).Children(func() {
									field.Input(c, &s.intelligence, field.InputProps{Size: theme.Small}).Label("能力分").LabelledBy(label)
								})
							})
							formRow(c, "并行上限", func(label ui.Element) {
								formFieldStack(c, func() {
									ui.Column(c).Width(120).Children(func() {
										field.Input(c, &s.parallel, field.InputProps{Size: theme.Small}).Label("并行上限").LabelledBy(label)
									})
									formHelp(c, "0 为不限")
								})
							})
							workerInput(c, "说明", &s.description, false)
						}
						fieldError(c, s.err)
					})
				})
				ui.Box(c).Height(1).AlignSelf(ui.Stretch).Background(tk.Split)
				ui.Row(c).Padding(14, 20).Gap(8).Wrap().Justify(ui.End).AlignItems(ui.Center).Children(func() {
					saving := a.busy["worker:save"] || a.busy["worker:clear"]
					if s.debater && s.original != nil {
						if s.clearing {
							display.Text(c, "确认清空"+debaterName(s.id)+"？", display.TextProps{})
							if ui.Button(c, "保留席位").Disabled(saving).Clicked() {
								s.clearing = false
							}
							if ui.Button(c, "确认移除").Disabled(saving).Clicked() {
								id := s.id
								a.action("worker:clear", func() (string, error) {
									err := a.client.call("worker.remove", map[string]string{"id": id}, nil)
									if err == nil {
										a.refresh()
									}
									return "", err
								}, func(_ string, err error) {
									if err != nil {
										s.err = err.Error()
									} else {
										s.shown = false
									}
								})
							}
						} else if ui.Button(c, "清空席位").Disabled(saving).Clicked() {
							s.clearing = true
						}
					}
					if ui.Button(c, "取消").Disabled(saving).Clicked() {
						s.shown = false
					}
					a.primaryButton(c, "worker:save", "保存", func() {
						if !saving {
							s.save(a)
						}
					})
				})
			})
			if !a.busy["worker:save"] && !a.busy["worker:clear"] && (panel.PressedOutside() || back.OverlayShortcut(0, ui.KeyEscape)) {
				s.shown = false
			}
		})
	})
}
func (s *workerPageState) save(a *app) {
	if a.busy["worker:save"] || a.busy["worker:clear"] {
		return
	}
	if s.debater {
		if strings.TrimSpace(s.model) == "" || len(s.accounts) == 0 {
			s.err = "请选择模型和至少一个账号"
			return
		}
		s.submit(a, map[string]any{"id": s.id, "engine": s.engine, "model": s.model, "effort": s.effort, "accounts": append([]string{}, s.accounts...)})
		return
	}

	intelligence, err := strconv.ParseFloat(strings.TrimSpace(s.intelligence), 64)
	if err != nil || !validWorkerIntelligence(intelligence) {
		s.err = "能力分只能为 0（未评分）或 1–10，步长 0.5"
		return
	}
	parallel, err := strconv.Atoi(strings.TrimSpace(s.parallel))
	if err != nil {
		s.err = "并行上限需要整数"
		return
	}
	p := map[string]any{"id": s.id}
	old := s.original
	if old == nil {
		p["engine"] = s.engine
	}
	if old == nil || s.model != old.Model {
		p["model"] = s.model
	}
	if old == nil || s.effort != old.Effort {
		p["effort"] = s.effort
	}
	if old == nil || intelligence != old.Intelligence {
		p["intelligence"] = intelligence
	}
	if old == nil || parallel != old.MaxParallel {
		p["maxParallel"] = parallel
	}
	if old == nil || !slices.Equal(s.accounts, old.Accounts) {
		p["accounts"] = append([]string{}, s.accounts...)
	}
	if old == nil || s.description != old.Description {
		p["description"] = s.description
	}
	s.submit(a, p)
}

func (s *workerPageState) submit(a *app, p map[string]any) {
	s.err = ""
	a.action("worker:save", func() (string, error) {
		err := a.client.call("worker.set", p, nil)
		if err == nil {
			a.refresh()
		}
		return "", err
	}, func(_ string, err error) {
		if err != nil {
			s.err = fmt.Sprint(err)
		} else {
			s.shown = false
			a.showToast("已保存")
		}
	})
}

func stringOptions(values []string) []field.SelectOption {
	options := make([]field.SelectOption, 0, len(values))
	for _, v := range values {
		options = append(options, field.SelectOption{Value: v, Label: v})
	}
	return options
}

func validWorkerIntelligence(n float64) bool {
	return n == 0 || (n >= 1 && n <= 10 && math.Mod(n*2, 1) == 0)
}
