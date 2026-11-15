package main

import (
	"strings"

	"github.com/egoist/mygo/ui"
	"github.com/lobehub/lobe-mygo/pkg/action"
	"github.com/lobehub/lobe-mygo/pkg/display"
	"github.com/lobehub/lobe-mygo/pkg/feedback"
	"github.com/lobehub/lobe-mygo/pkg/field"
	"github.com/lobehub/lobe-mygo/pkg/theme"
)

type accountForm struct {
	Mode      string // "add" or "edit"
	ID        string
	Engine    string
	Kind      string
	Label     string
	APIKey    string
	HasAPIKey bool
	HadConfig bool

	Provider    string
	Protocol    string
	BaseURL     string
	BaseURLErr  string
	ProviderErr string

	// dsh channel fields, kept on the same value as the base fields above.
	Preset                string
	Headers               []headerRow
	Models                []dshModel
	Extra                 map[string]any
	Advanced              bool
	AdvancedText          string
	AdvancedErr           string
	Loading               bool
	FetchErr              string
	CreateWorker          bool
	CandidateModel        string
	CandidateID           string
	CandidateEffort       string
	CandidateIntelligence string
	CandidateIDCustom     bool

	Err string
}

func newAccountForm() *accountForm {
	f := &accountForm{Mode: "add", Engine: "dsh", Kind: "api", CandidateIntelligence: "0"}
	f.applyPreset("openai")
	return f
}

func (a *app) openEdit(acc account) {
	f := &accountForm{
		Mode: "edit", ID: acc.ID, Engine: acc.Engine, Kind: acc.Kind, Label: accountLabel(acc),
		HasAPIKey: acc.HasAPIKey, HadConfig: acc.HasConfig, Provider: acc.Provider, Protocol: acc.Protocol, BaseURL: acc.BaseURL,
		CandidateIntelligence: "0",
	}
	st := accountsFor(a)
	st.form = f
	if acc.Engine != "dsh" {
		return
	}
	f.Preset = dshPresetFor(acc)
	f.Loading = true
	key := "account:config:" + acc.ID
	var view accountConfigView
	a.action(key, func() (string, error) {
		return "", a.client.call("account.config", map[string]string{"id": acc.ID}, &view)
	}, func(_ string, err error) {
		if st.form != f {
			return
		}
		f.Loading = false
		if err != nil {
			f.Err = err.Error()
			return
		}
		f.applyConfig(view)
	})
}

func (f *accountForm) title() string {
	if f.Mode == "edit" {
		return "编辑 " + f.Label
	}
	if f.Engine == "dsh" {
		return "接入 dsh 渠道"
	}
	return "接入账号"
}

func (a *app) accountFormView(c *ui.Context) {
	st := accountsFor(a)
	f := st.form
	if f == nil {
		return
	}
	open := true
	width, _ := c.Size()
	size := float32(780)
	if width > 0 && width-24 < size {
		size = width - 24
	}
	feedback.Drawer(c, &open, feedback.DrawerProps{
		Title: f.title(),
		Size:  size,
		Footer: func() {
			if action.Button(c, "取消", action.ButtonProps{}).Clicked() {
				st.form = nil
			}
			a.primaryButton(c, "account:save", "保存并检查", func() { a.saveAccountForm(f) })
		},
	}, func() {
		ui.Column(c).Gap(12).Children(func() { a.accountFormBody(c, f) })
	})
	if !open {
		st.form = nil
	}
}

func (a *app) accountFormBody(c *ui.Context, f *accountForm) {
	fieldError(c, f.Err)
	ui.Column(c).Gap(12).Children(func() {
		if f.Mode == "edit" {
			formRow(c, "ID", func(label ui.Element) {
				display.Text(c, f.ID, display.TextProps{Code: true})
			})
		}
		if f.Mode == "add" {
			formRow(c, "引擎", func(label ui.Element) {
				sel := field.Select(c, &f.Engine, field.SelectProps{Size: theme.Small, Options: []field.SelectOption{
					{Value: "claude", Label: "claude"},
					{Value: "codex", Label: "codex"},
					{Value: "opencode", Label: "opencode"},
					{Value: "dsh", Label: "dsh"},
				}}).Label("引擎").LabelledBy(label)
				if sel.Changed() {
					f.Err = ""
					if f.Engine == "dsh" {
						f.Kind = "api"
						f.applyPreset("openai")
					}
				}
			})
		} else {
			formRow(c, "引擎", func(label ui.Element) {
				display.Text(c, f.Engine+"（建好后不能改）", display.TextProps{Type: display.TextSecondary})
			})
		}

		if f.Engine == "dsh" {
			formRow(c, "类型", func(label ui.Element) {
				display.Text(c, "API（dsh 渠道）", display.TextProps{Type: display.TextSecondary})
			})
		} else if f.Mode == "add" {
			formRow(c, "类型", func(label ui.Element) {
				field.Select(c, &f.Kind, field.SelectProps{Size: theme.Small, Options: []field.SelectOption{
					{Value: "subscription", Label: "订阅"},
					{Value: "api", Label: "API"},
				}}).Label("类型").LabelledBy(label)
			})
		} else {
			formRow(c, "类型", func(label ui.Element) {
				display.Text(c, kindLabel(f.Kind), display.TextProps{Type: display.TextSecondary})
			})
		}

		formRow(c, "名称", func(label ui.Element) {
			field.Input(c, &f.Label, field.InputProps{Size: theme.Small, Placeholder: "例如：OpenAI API（dsh）"}).Label("名称").LabelledBy(label)
		})

		if f.Mode == "add" && f.Engine != "dsh" {
			formRow(c, "ID（可选）", func(label ui.Element) {
				field.Input(c, &f.ID, field.InputProps{Size: theme.Small, Placeholder: "留空由服务生成"}).Label("ID（可选）").LabelledBy(label)
			})
		}
	})

	if f.Engine == "dsh" {
		formDivider(c)
		ui.Column(c).Gap(12).Children(func() { a.dshChannelFields(c, f) })
		return
	}
	if f.Kind != "api" {
		formDivider(c)
		formHelp(c, "订阅账号保存后用「登录」完成认证。")
		return
	}
	formDivider(c)
	ui.Column(c).Gap(12).Children(func() { a.apiAccountFields(c, f) })
}

func (a *app) apiAccountFields(c *ui.Context, f *accountForm) {
	formRow(c, "API 密钥", func(label ui.Element) {
		formFieldStack(c, func() {
			field.InputPassword(c, &f.APIKey, field.InputProps{Size: theme.Small}).Label("API 密钥").LabelledBy(label)
			if f.Mode == "edit" && f.HasAPIKey {
				formHelp(c, "已设置，留空表示不改")
			} else {
				formHelp(c, "保存后只显示「已设置」，不再显示内容。")
			}
		})
	})
	formRow(c, "提供方", func(label ui.Element) {
		formFieldStack(c, func() {
			field.Input(c, &f.Provider, field.InputProps{Size: theme.Small, Placeholder: "例如 openai"}).Label("提供方").LabelledBy(label)
			fieldError(c, f.ProviderErr)
		})
	})
	formRow(c, "协议", func(label ui.Element) {
		field.Select(c, &f.Protocol, field.SelectProps{Size: theme.Small, Options: protocolOptions()}).Label("协议").LabelledBy(label)
	})
	formRow(c, "接口地址", func(label ui.Element) {
		formFieldStack(c, func() {
			input := field.Input(c, &f.BaseURL, field.InputProps{Size: theme.Small, Invalid: f.BaseURLErr != "", Placeholder: "https://"}).Label("接口地址").LabelledBy(label)
			if input.Changed() {
				f.BaseURLErr = ""
			}
			fieldError(c, f.BaseURLErr)
		})
	})
}

func protocolOptions() []field.SelectOption {
	return []field.SelectOption{
		{Value: "openai-completions", Label: "openai-completions"},
		{Value: "openai-responses", Label: "openai-responses"},
		{Value: "anthropic-messages", Label: "anthropic-messages"},
	}
}

func (a *app) saveAccountForm(f *accountForm) {
	if f.Engine == "dsh" {
		a.saveDSHChannel(f)
		return
	}
	f.Err = ""
	method := "account.add"
	label := strings.TrimSpace(f.Label)
	engine := f.Engine
	params := map[string]any{"engine": engine, "kind": f.Kind, "label": label}
	if f.Mode == "edit" {
		method = "account.set"
		params["id"] = f.ID
		if f.Kind == "api" {
			params["provider"] = f.Provider
			params["protocol"] = f.Protocol
			params["baseUrl"] = f.BaseURL
			if f.APIKey != "" {
				params["apiKey"] = f.APIKey
			}
		}
	} else {
		if f.ID != "" {
			params["id"] = strings.TrimSpace(f.ID)
		}
		if f.Kind == "api" {
			params["apiKey"] = f.APIKey
			params["provider"] = f.Provider
			params["protocol"] = f.Protocol
			params["baseUrl"] = f.BaseURL
		}
	}
	mode := f.Mode
	a.action("account:save", func() (string, error) {
		var added account
		if err := a.client.call(method, params, &added); err != nil {
			return "", err
		}
		if method == "account.add" && added.ID != "" {
			_ = a.client.call("account.check", map[string]string{"id": added.ID}, nil)
		}
		a.refresh()
		return added.ID, nil
	}, func(message string, err error) {
		if err != nil {
			f.Err = err.Error()
			if message != "" && f.Mode == "add" {
				f.Mode, f.ID = "edit", message
			}
			return
		}
		accountsFor(a).form = nil
		if mode == "add" {
			a.showToast("账号已接入")
		} else {
			a.showToast("账号已保存")
		}
	})
}

func (f *accountForm) applyConfig(view accountConfigView) {
	f.Loading = false
	if view.Provider != "" {
		f.Provider = view.Provider
	}
	if view.Protocol != "" {
		f.Protocol = view.Protocol
	}
	if view.BaseURL != "" {
		f.BaseURL = view.BaseURL
	}
	f.HasAPIKey = view.HasAPIKey
	if view.Config == nil {
		return
	}
	if err := f.applyNative(view.Config); err != nil {
		f.Err = "渠道配置读回失败：" + err.Error()
	}
}
