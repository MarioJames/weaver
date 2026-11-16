package main

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"

	"github.com/egoist/mygo/ui"
	"github.com/lobehub/lobe-mygo/pkg/choice"
	"github.com/lobehub/lobe-mygo/pkg/display"
	"github.com/lobehub/lobe-mygo/pkg/field"
	"github.com/lobehub/lobe-mygo/pkg/theme"
)

func (a *app) saveSetting(key, value string) {
	f := a.fields[key]
	old := a.snapshot.Settings[key]
	if value == old {
		f.dirty = false
		return
	}
	a.action("config:"+key, func() (string, error) {
		err := a.client.call("config.set", map[string]string{"key": key, "value": value}, nil)
		if err == nil {
			a.refresh()
		}
		return "", err
	}, func(_ string, err error) {
		f.dirty = false
		if err != nil {
			f.value = old
			f.err = err.Error()
		} else {
			f.value = value
			f.err = ""
			a.showToast("已保存")
		}
	})
}

func (a *app) settingsPage(c *ui.Context) {
	a.pageHeader(c, "设置", "调度、常驻引擎、服务和技能", nil)
	section(c, "调度", func() {
		ui.Column(c).Gap(10).Children(func() {
			for _, item := range []struct {
				key, label, desc string
				toggle           bool
			}{
				{"max_parallel", "全局并行上限", "同时在跑的包数，0 为不限", false},
				{"stall_seconds", "卡住判定", "秒没有新事件就算卡住", false},
				{"quota_refresh_minutes", "额度刷新间隔", "分钟自动读取一次订阅账号额度，1 到 1440", false},
				{"resident", "opencode 常驻", "订阅账号保持一个常驻服务，包来了直接进", true},
				{"standby", "claude 待命", "提前起好进程等包", true},
			} {
				a.settingRow(c, item.key, item.label, item.desc, item.toggle)
			}
			a.autoArchiveSetting(c)
		})
	})
	section(c, "常驻引擎", func() {
		shown := map[string]bool{}
		// status.residents 与 engine.list 使用同一个服务端结果，随统一快照刷新。
		for _, r := range a.snapshot.Residents {
			a.engineRow(c, r.AccountID, &r)
			shown[r.AccountID] = true
		}
		for _, acc := range a.snapshot.Accounts {
			if acc.Engine == "opencode" && acc.Kind == "subscription" && !shown[acc.ID] {
				a.engineRow(c, acc.ID, nil)
			}
		}
	})
	section(c, "服务", func() {
		s := a.snapshot
		ui.Column(c).Gap(6).Children(func() {
			ui.Text(c, fmt.Sprintf("版本 %s · 进程 %d", s.Version, s.PID)).FontSize(13).TextColor(theme.TokensOf(c).Text)
			label := "数据目录 " + s.Home
			if _, custom := a.customDataHome(); custom {
				label = "自定义数据目录 " + s.Home
			}
			ui.Text(c, label).FontSize(12).TextColor(theme.TokensOf(c).TextTertiary)
			if _, custom := a.customDataHome(); custom {
				ui.Text(c, "这个目录的服务由 weaver-gui 用临时用户单元管理，不会改动正式的 weaver.service。").
					FontSize(12).TextColor(theme.TokensOf(c).TextTertiary)
			}
		})
		ui.Row(c).Gap(8).Wrap().Children(func() {
			a.button(c, "backup", "立即备份", func() {
				a.action("backup", func() (string, error) {
					var out struct {
						Path string `json:"path"`
					}
					err := a.client.call("backup", nil, &out)
					if err == nil {
						a.refresh()
					}
					return out.Path, err
				}, nil)
			})
			a.button(c, "service:restart", "重启服务", func() {
				a.action("service:restart", func() (string, error) {
					out, err := restartServiceFor(a.ctx, a.client.home)
					if err == nil {
						a.refresh()
					}
					return out, err
				}, nil)
			})
			if _, custom := a.customDataHome(); !custom {
				a.button(c, "service:uninstall", "移除用户服务", func() {
					a.confirm("移除用户服务", "移除用户服务", func() { a.external("service:uninstall", weaverExecutable(), "service", "uninstall") })
				})
			}
		})
		for _, key := range []string{"backup", "service:restart", "service:uninstall"} {
			fieldError(c, a.errors[key])
		}
	})
	section(c, "技能 agents-weaver", func() {
		ui.Row(c).Gap(16).AlignItems(ui.Center).Disabled(a.busy["skill:check"]).Children(func() {
			state := a.skillState
			color := display.TagColor("")
			switch state {
			case "已安装":
				color = display.TagSuccess
			case "需要更新":
				color = display.TagWarning
			}
			display.Tag(c, state, display.TagProps{Color: color})
			label := "重新安装"
			if a.skillState == "未安装" {
				label = "安装"
			}
			a.button(c, "skill:install", label, func() {
				a.action("skill:install", func() (string, error) { return command(a.ctx, weaverExecutable(), "skill", "install") }, func(_ string, err error) {
					if err == nil {
						a.checkSkill()
					}
				})
			})
		})
		if a.busy["skill:check"] {
			display.Text(c, "检查中…", display.TextProps{Type: display.TextSecondary, FontSize: 12})
		}
		fieldError(c, a.errors["skill:check"])
		fieldError(c, a.errors["skill:install"])
	})
}

func (a *app) settingRow(c *ui.Context, key, label, desc string, toggle bool) {
	f := a.fields[key]
	if f == nil {
		return
	}
	ui.Column(c).Key(key).Gap(2).Children(func() {
		ui.Row(c).Gap(16).AlignItems(ui.Center).Children(func() {
			labelEl := ui.Row(c).Width(130).Height(24).AlignItems(ui.Center).Shrink(0).Children(func() {
				display.Text(c, label, display.TextProps{Strong: true}).SingleLine()
			})
			if toggle {
				on := f.value == "on"
				sw := choice.Switch(c, &on, choice.SwitchProps{}).LabelledBy(labelEl).Disabled(a.busy["config:"+key])
				if sw.Changed() {
					value := "off"
					if on {
						value = "on"
					}
					f.value = value
					f.dirty = true
					a.saveSetting(key, value)
				}
			} else {
				ui.Column(c).Width(140).Children(func() {
					input := field.Input(c, &f.value, field.InputProps{Size: theme.Small, Invalid: f.err != ""}).
						Label(label).LabelledBy(labelEl).Disabled(a.busy["config:"+key])
					if input.Changed() {
						f.dirty = true
						f.err = ""
					}
					if (input.Submitted() || input.FocusLeft()) && f.dirty {
						a.saveSetting(key, f.value)
					}
				})
			}
			display.Text(c, desc, display.TextProps{Type: display.TextSecondary, FontSize: 12}).Grow(1).Basis(0).MinWidth(0)
		})
		fieldError(c, f.err)
	})
}

func (a *app) engineRow(c *ui.Context, id string, r *resident) {
	tk := theme.TokensOf(c)
	label := "账号"
	for _, acc := range a.snapshot.Accounts {
		if acc.ID == id {
			label = acc.Label
			break
		}
	}
	key := "engine:" + id
	ui.Column(c).Key(key).Gap(4).Children(func() {
		ui.Row(c).Gap(10).Wrap().AlignItems(ui.Center).Children(func() {
			ui.Text(c, label).FontSize(13).FontWeight(600).TextColor(tk.Text)
			if r != nil {
				statusTag(c, r.State)
				display.Text(c, fmt.Sprintf("端口 %d · %d 个会话", r.Port, r.Sessions), display.TextProps{Type: display.TextSecondary, FontSize: 12})
				a.button(c, key, "停止", func() { a.write(key, "engine.stop", map[string]string{"account": id}) })
			} else {
				a.button(c, key, "启动", func() { a.write(key, "engine.start", map[string]string{"account": id}) })
			}
		})
		if r != nil {
			fieldError(c, r.Reason)
		}
		fieldError(c, a.errors[key])
	})
	ui.Box(c).Height(1).AlignSelf(ui.Stretch).Background(tk.Split)
}

func (a *app) external(key, name string, args ...string) {
	a.action(key, func() (string, error) {
		out, err := command(a.ctx, name, args...)
		if err == nil {
			a.refresh()
		}
		return out, err
	}, nil)
}

func (a *app) checkSkill() {
	a.skillChecked = true
	a.action("skill:check", func() (string, error) {
		expected, err := command(a.ctx, weaverExecutable(), "skill")
		if err != nil {
			return "", err
		}
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		installed, err := os.ReadFile(filepath.Join(home, ".agents", "skills", "agents-weaver", "SKILL.md"))
		if os.IsNotExist(err) {
			return "未安装", nil
		}
		if err != nil {
			return "", err
		}
		if bytes.Equal(installed, []byte(expected)) {
			return "已安装", nil
		}
		return "需要更新", nil
	}, func(state string, err error) {
		if err == nil {
			a.skillState = state
		}
	})
}
