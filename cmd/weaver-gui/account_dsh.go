package main

import (
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/egoist/mygo/ui"
	"github.com/lobehub/lobe-mygo/pkg/action"
	"github.com/lobehub/lobe-mygo/pkg/choice"
	"github.com/lobehub/lobe-mygo/pkg/display"
	"github.com/lobehub/lobe-mygo/pkg/feedback"
	"github.com/lobehub/lobe-mygo/pkg/field"
	"github.com/lobehub/lobe-mygo/pkg/theme"
)

type headerRow struct {
	Name  string
	Value string
}

type dshModel struct {
	ID        string
	Name      string
	Context   string
	MaxOutput string
	Image     bool
	Efforts   []string
	Extra     map[string]any
}

type accountConfigView struct {
	ID        string `json:"id"`
	Engine    string `json:"engine"`
	Kind      string `json:"kind"`
	Provider  string `json:"provider,omitempty"`
	Protocol  string `json:"protocol,omitempty"`
	BaseURL   string `json:"baseUrl,omitempty"`
	HasAPIKey bool   `json:"hasApiKey"`
	Config    any    `json:"config"`
}

type modelInfo struct {
	ID            string `json:"id"`
	Name          string `json:"name,omitempty"`
	ContextWindow int    `json:"contextWindow,omitempty"`
	MaxTokens     int    `json:"maxTokens,omitempty"`
}

type modelFetch struct {
	Form    *accountForm
	Models  []modelInfo
	Checked map[string]bool
}

var dshEfforts = []string{"off", "minimal", "low", "medium", "high", "xhigh", "max"}

var (
	providerPattern = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)
	letterPattern   = regexp.MustCompile(`[a-zA-Z]`)
)

func (f *accountForm) applyPreset(preset string) {
	previous := f.Preset
	f.Preset = preset
	switch preset {
	case "deepseek":
		f.Provider = "deepseek-official"
		f.Protocol = ""
		f.BaseURL = ""
		f.Models = nil
	case "openai":
		f.Provider = "openai"
		f.Protocol = "openai-responses"
		f.BaseURL = "https://api.openai.com/v1"
	case "anthropic":
		f.Provider = "anthropic"
		f.Protocol = "anthropic-messages"
		f.BaseURL = "https://api.anthropic.com"
	case "custom":
		if previous != "custom" {
			f.BaseURL = ""
			f.BaseURLErr = ""
		}
		if f.Protocol == "" {
			f.Protocol = "openai-completions"
		}
	}
}

func dshPresetFor(acc account) string { return dshPresetFromProvider(acc.Provider) }

func (a *app) dshChannelFields(c *ui.Context, f *accountForm) {
	formGroupHeader(c, "渠道")
	formRow(c, "预设", func(label ui.Element) {
		ui.Row(c).Gap(6).Wrap().AlignItems(ui.Center).Children(func() {
			for _, preset := range []struct{ value, label string }{
				{"deepseek", "DeepSeek 官方"},
				{"openai", "OpenAI 官方"},
				{"anthropic", "Anthropic 官方"},
				{"custom", "自定义"},
			} {
				variant := action.Default
				if f.Preset == preset.value {
					variant = action.Primary
				}
				b := action.Button(c, preset.label, action.ButtonProps{Size: theme.Small, Variant: variant})
				if b.Clicked() {
					f.applyPreset(preset.value)
					f.Err = ""
				}
			}
		})
	})

	if f.Preset == "deepseek" {
		formHelp(c, "模型能力由 dsh 内置，强度为 off、low、high、max。")
	}

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
			if f.Preset == "custom" {
				input := field.Input(c, &f.Provider, field.InputProps{Size: theme.Small, Invalid: f.ProviderErr != "", Placeholder: "小写连字符，例如 my-gateway"}).Label("提供方").LabelledBy(label)
				if input.Changed() {
					f.ProviderErr = ""
				}
			} else {
				display.Text(c, f.Provider, display.TextProps{Code: true})
			}
			fieldError(c, f.ProviderErr)
		})
	})

	formRow(c, "协议", func(label ui.Element) {
		switch f.Preset {
		case "custom":
			field.Select(c, &f.Protocol, field.SelectProps{Size: theme.Small, Options: protocolOptions()}).Label("协议").LabelledBy(label)
		case "deepseek":
			display.Text(c, "由 dsh 直连", display.TextProps{Type: display.TextSecondary})
		default:
			display.Text(c, f.Protocol, display.TextProps{Code: true})
		}
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

	if f.Preset != "deepseek" {
		formDivider(c)
		a.dshHeaders(c, f)
		formDivider(c)
		a.dshModels(c, f)
		if len(f.Models) > 0 {
			formDivider(c)
			a.dshCandidate(c, f)
		}
		formDivider(c)
		a.dshAdvanced(c, f)
	}
}

func (a *app) dshHeaders(c *ui.Context, f *accountForm) {
	formRow(c, "请求头", func(label ui.Element) {
		ui.Row(c).Children(func() {
			add := action.Button(c, "添加", action.ButtonProps{Size: theme.Small})
			add.Label("添加请求头")
			if add.Clicked() {
				f.Headers = append(f.Headers, headerRow{})
			}
		})
	})
	formHelp(c, "网关要求的额外请求头")
	for i := range f.Headers {
		i := i
		ui.Row(c).Key(fmt.Sprintf("header:%d", i)).Gap(6).AlignItems(ui.Center).Children(func() {
			ui.Box(c).Width(formLabelWidth)
			field.Input(c, &f.Headers[i].Name, field.InputProps{Size: theme.Small, Placeholder: "名称"}).Label(fmt.Sprintf("请求头 %d 名称", i+1))
			field.Input(c, &f.Headers[i].Value, field.InputProps{Size: theme.Small, Placeholder: "值"}).Label(fmt.Sprintf("请求头 %d 值", i+1))
			if action.Button(c, "删除", action.ButtonProps{Size: theme.Small}).Label(fmt.Sprintf("删除请求头 %d", i+1)).Clicked() {
				f.Headers = append(f.Headers[:i], f.Headers[i+1:]...)
			}
		})
	}
}

func (a *app) dshModels(c *ui.Context, f *accountForm) {
	tk := theme.TokensOf(c)
	formRow(c, "模型", func(label ui.Element) {
		ui.Row(c).Gap(8).AlignItems(ui.Center).Wrap().Children(func() {
			add := action.Button(c, "添加模型", action.ButtonProps{Size: theme.Small})
			if add.Clicked() {
				f.Models = append(f.Models, dshModel{})
			}
			a.button(c, "account:models", "从接口拉取", func() { a.fetchModels(f) })
		})
	})
	if f.Loading {
		formHelp(c, "正在读取渠道配置…")
	}
	fieldError(c, f.FetchErr)
	if len(f.Models) == 0 {
		formHelp(c, "还没有模型。可以从接口拉取，或手动添加。")
	}
	if len(f.Models) > 0 {
		ui.Row(c).Gap(6).Padding(0, 0, 0, formLabelWidth).Children(func() {
			display.Text(c, "模型", display.TextProps{Type: display.TextSecondary, FontSize: 11}).Grow(1)
			display.Text(c, "上下文", display.TextProps{Type: display.TextSecondary, FontSize: 11}).Width(104)
			display.Text(c, "最大输出", display.TextProps{Type: display.TextSecondary, FontSize: 11}).Width(104)
			display.Text(c, "图片", display.TextProps{Type: display.TextSecondary, FontSize: 11}).Width(46)
			ui.Box(c).Width(48)
		})
	}
	for i := range f.Models {
		i := i
		m := &f.Models[i]
		ui.Column(c).Key(fmt.Sprintf("model:%d", i)).Gap(6).Padding(0, 0, 8, 0).Children(func() {
			ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
				field.Input(c, &m.ID, field.InputProps{Size: theme.Small, Placeholder: "模型 ID"}).Label(fmt.Sprintf("模型 %d ID", i+1))
				field.Input(c, &m.Context, field.InputProps{Size: theme.Small, Placeholder: "272000"}).Width(104).Label(fmt.Sprintf("模型 %d 上下文窗口", i+1))
				field.Input(c, &m.MaxOutput, field.InputProps{Size: theme.Small, Placeholder: "128000"}).Width(104).Label(fmt.Sprintf("模型 %d 最大输出", i+1))
				ui.Column(c).Width(46).Children(func() {
					choice.Switch(c, &m.Image, choice.SwitchProps{Size: theme.Small}).Label(fmt.Sprintf("模型 %d 图片输入", i+1))
				})
				if action.Button(c, "删除", action.ButtonProps{Size: theme.Small}).Label(fmt.Sprintf("删除模型 %d", i+1)).Clicked() {
					f.Models = append(f.Models[:i], f.Models[i+1:]...)
				}
			})
			ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
				display.Text(c, "思考力度", display.TextProps{Type: display.TextSecondary, FontSize: 11}).Width(56)
				for _, effort := range dshEfforts {
					effort := effort
					on := containsString(m.Efforts, effort)
					chip := ui.ToggleBase(c, &on).Label(fmt.Sprintf("模型 %d 力度 %s", i+1, effort)).
						Height(24).PaddingX(8).Gap(3).Radius(tk.BorderRadiusSM).Cursor(ui.CursorPointer).Unselectable()
					if on {
						chip.Background(tk.PrimaryBg).Border(1, tk.Primary).TextColor(tk.Primary)
					} else {
						chip.Border(1, tk.BorderSecondary).TextColor(tk.TextTertiary)
					}
					chip.Children(func() { ui.Text(c, effort).FontSize(12) })
					if chip.Changed() {
						if on {
							m.Efforts = sortedEfforts(append(m.Efforts, effort))
						} else {
							m.Efforts = removeString(m.Efforts, effort)
						}
						f.CandidateIDCustom = false
						f.reconcileCandidate()
					}
				}
			})
		})
	}
}

func (a *app) dshCandidate(c *ui.Context, f *accountForm) {
	f.reconcileCandidate()
	ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
		ui.Box(c).Width(formLabelWidth)
		choice.Checkbox(c, &f.CreateWorker, "同时建候选", choice.CheckboxProps{}).Label("同时建候选")
	})
	if !f.CreateWorker {
		formHelp(c, "保存时需要为选中的模型建一个候选。")
		return
	}
	modelOptions := make([]field.SelectOption, 0, len(f.Models))
	for _, m := range f.Models {
		if m.ID == "" {
			continue
		}
		modelOptions = append(modelOptions, field.SelectOption{Value: m.ID, Label: m.ID})
	}
	efforts := f.candidateEfforts()
	effortOptions := make([]field.SelectOption, 0, len(efforts)+1)
	if len(efforts) == 0 {
		effortOptions = append(effortOptions, field.SelectOption{Value: "", Label: "（不指定）"})
	}
	for _, e := range efforts {
		effortOptions = append(effortOptions, field.SelectOption{Value: e, Label: e})
	}
	formRow(c, "候选", func(label ui.Element) {
		ui.Row(c).Gap(8).AlignItems(ui.Center).Wrap().Children(func() {
			ui.Column(c).Width(180).Children(func() {
				field.Select(c, &f.CandidateModel, field.SelectProps{Size: theme.Small, Options: modelOptions}).Label("候选模型")
			})
			ui.Column(c).Width(190).Children(func() {
				input := field.Input(c, &f.CandidateID, field.InputProps{Size: theme.Small}).Label("候选 ID")
				if input.Changed() {
					f.CandidateIDCustom = true
				}
			})
			display.Text(c, "强度", display.TextProps{Type: display.TextSecondary, FontSize: 12})
			ui.Column(c).Width(100).Children(func() {
				field.Select(c, &f.CandidateEffort, field.SelectProps{Size: theme.Small, Options: effortOptions}).Label("候选强度")
			})
			display.Text(c, "权重", display.TextProps{Type: display.TextSecondary, FontSize: 12})
			ui.Column(c).Width(64).Children(func() {
				field.Input(c, &f.CandidateWeight, field.InputProps{Size: theme.Small}).Label("候选权重")
			})
		})
	})
}

func (a *app) dshAdvanced(c *ui.Context, f *accountForm) {
	if f.Preset == "deepseek" {
		return
	}
	ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
		ui.Box(c).Width(formLabelWidth)
		b := action.Button(c, "高级", action.ButtonProps{Size: theme.Small, Variant: action.Text})
		b.Label("高级")
		if b.Clicked() {
			if f.Advanced {
				if err := f.applyAdvanced(); err != "" {
					f.AdvancedErr = err
				} else {
					f.Advanced, f.AdvancedErr = false, ""
				}
			} else {
				if text, err := f.nativeJSONText(); err != nil {
					f.AdvancedErr = err.Error()
				} else {
					f.AdvancedText, f.Advanced, f.AdvancedErr = text, true, ""
				}
			}
		}
	})
	formHelp(c, "默认思考力度、超时、重试、兼容开关、原生 JSON")
	if f.Advanced {
		formRow(c, "原生 JSON", func(label ui.Element) {
			formFieldStack(c, func() {
				field.TextArea(c, &f.AdvancedText, field.TextAreaProps{Invalid: f.AdvancedErr != "", MinRows: 10, MaxRows: 18}).Label("高级 JSON")
				formHelp(c, "展开时以这段 JSON 为准；收起或保存时解析回表单。")
				fieldError(c, f.AdvancedErr)
			})
		})
	} else {
		fieldError(c, f.AdvancedErr)
	}
}

func (f *accountForm) reconcileCandidate() {
	if !f.CreateWorker {
		return
	}
	if f.CandidateModel == "" || !f.hasModel(f.CandidateModel) {
		for _, m := range f.Models {
			if m.ID != "" {
				f.CandidateModel = m.ID
				break
			}
		}
	}
	efforts := f.candidateEfforts()
	if !containsString(efforts, f.CandidateEffort) {
		if len(efforts) > 0 {
			f.CandidateEffort = efforts[0]
		} else {
			f.CandidateEffort = ""
		}
	}
	if !f.CandidateIDCustom || f.CandidateID == "" {
		f.CandidateID = f.defaultCandidateID()
	}
	if f.CandidateWeight == "" {
		f.CandidateWeight = "0"
	}
}

func (f *accountForm) hasModel(id string) bool {
	for _, m := range f.Models {
		if m.ID == id {
			return true
		}
	}
	return false
}

func (f *accountForm) candidateEfforts() []string {
	for _, m := range f.Models {
		if m.ID == f.CandidateModel {
			return sortedEfforts(m.Efforts)
		}
	}
	return nil
}

func (f *accountForm) defaultCandidateID() string {
	short := shortModelName(f.CandidateModel)
	if f.CandidateEffort == "" {
		return "dsh_" + short
	}
	return "dsh_" + short + "_" + f.CandidateEffort
}

func shortModelName(id string) string {
	parts := strings.Split(id, "-")
	name := ""
	for _, part := range parts {
		if letterPattern.MatchString(part) {
			name = part
		}
	}
	if name == "" {
		name = id
	}
	name = strings.ToLower(name)
	var b strings.Builder
	for _, r := range name {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
	}
	if b.Len() == 0 {
		return "model"
	}
	return b.String()
}

func sortedEfforts(efforts []string) []string {
	out := make([]string, 0, len(efforts))
	for _, want := range dshEfforts {
		if containsString(efforts, want) {
			out = append(out, want)
		}
	}
	return out
}

func containsString(list []string, value string) bool {
	for _, item := range list {
		if item == value {
			return true
		}
	}
	return false
}

func removeString(list []string, value string) []string {
	out := list[:0]
	for _, item := range list {
		if item != value {
			out = append(out, item)
		}
	}
	return out
}

func (a *app) saveDSHChannel(f *accountForm) {
	f.Err = ""
	if f.Advanced {
		if err := f.applyAdvanced(); err != "" {
			f.AdvancedErr = err
			return
		}
	}
	if f.Preset == "custom" {
		invalid := false
		if !providerPattern.MatchString(f.Provider) {
			f.ProviderErr = "提供方只能用小写字母、数字和连字符"
			invalid = true
		}
		if strings.TrimSpace(f.BaseURL) == "" {
			f.BaseURLErr = "接口地址必填"
			invalid = true
		}
		if invalid {
			return
		}
	}
	config, err := f.nativeConfig()
	if err != nil {
		f.Err = err.Error()
		return
	}
	params := map[string]any{
		"engine": "dsh", "kind": "api", "label": strings.TrimSpace(f.Label),
		"provider": f.Provider, "protocol": f.Protocol, "baseUrl": strings.TrimSpace(f.BaseURL),
		"apiKey": f.APIKey, "config": config,
	}
	method := "account.add"
	if f.Mode == "edit" {
		method = "account.set"
		params["id"] = f.ID
		if f.APIKey == "" {
			delete(params, "apiKey")
		}
	}
	mode := f.Mode
	var candidate *workerCreate
	if f.CreateWorker {
		f.reconcileCandidate()
		model, effort := f.CandidateModel, f.CandidateEffort
		if model == "" {
			f.Err = "同时建候选需要选择一个模型"
			return
		}
		if effort != "" && !containsString(f.candidateEfforts(), effort) {
			f.Err = "候选强度不在这个模型支持的思考力度里"
			return
		}
		weight, err := strconv.Atoi(strings.TrimSpace(f.CandidateWeight))
		if err != nil || weight < 0 {
			f.Err = "候选权重需要非负整数"
			return
		}
		if strings.TrimSpace(f.CandidateID) == "" {
			f.Err = "候选 ID 必填"
			return
		}
		candidate = &workerCreate{ID: strings.TrimSpace(f.CandidateID), Model: model, Effort: effort, Weight: weight}
		f.CandidateID = candidate.ID
	}
	a.action("account:save", func() (string, error) {
		var added account
		if err := a.client.call(method, params, &added); err != nil {
			return "", err
		}
		created := added.ID
		if method == "account.add" && created != "" {
			_ = a.client.call("account.check", map[string]string{"id": created}, nil)
		}
		if candidate != nil && created != "" {
			workerParams := map[string]any{
				"id": candidate.ID, "engine": "dsh", "model": candidate.Model,
				"accounts": []string{created}, "weight": candidate.Weight,
			}
			if candidate.Effort != "" {
				workerParams["effort"] = candidate.Effort
			}
			if err := a.client.call("worker.set", workerParams, nil); err != nil {
				a.refresh()
				return created, fmt.Errorf("账号已保存，但候选没有建成：%s", err.Error())
			}
		}
		a.refresh()
		return created, nil
	}, func(message string, err error) {
		if err != nil {
			f.Err = err.Error()
			if message != "" && f.Mode == "add" {
				f.Mode, f.ID = "edit", message
			}
			return
		}
		accountsFor(a).form = nil
		if candidate != nil {
			a.showToast("账号已接入，候选已创建")
		} else if mode == "add" {
			a.showToast("账号已接入")
		} else {
			a.showToast("账号已保存")
		}
	})
}

type workerCreate struct {
	ID     string
	Model  string
	Effort string
	Weight int
}

func (f *accountForm) nativeConfig() (string, error) {
	if f.Preset == "deepseek" {
		return "", nil
	}
	// A new channel with nothing in the native block besides the account
	// fields needs no config. Leaving it empty also lets the service apply its
	// own API-account validation, as A3 expects.
	if !f.HadConfig && len(f.headerMap()) == 0 && len(f.Extra) == 0 && !f.hasModelEntries() {
		return "", nil
	}
	block, err := f.nativeConfigMap()
	if err != nil {
		return "", err
	}
	body, err := json.Marshal(block)
	if err != nil {
		return "", err
	}
	return string(body), nil
}

func (f *accountForm) hasModelEntries() bool {
	for _, m := range f.Models {
		if strings.TrimSpace(m.ID) != "" {
			return true
		}
	}
	return false
}

func (f *accountForm) nativeConfigMap() (map[string]any, error) {
	block := map[string]any{}
	for key, value := range f.Extra {
		block[key] = value
	}
	block["api"] = f.Protocol
	block["displayName"] = strings.TrimSpace(f.Label)
	block["baseURL"] = strings.TrimSpace(f.BaseURL)
	if block["displayName"] == "" {
		block["displayName"] = f.Provider
	}
	if headers := f.headerMap(); len(headers) > 0 {
		block["headers"] = headers
	}
	models := make([]any, 0, len(f.Models))
	for _, m := range f.Models {
		if strings.TrimSpace(m.ID) == "" {
			continue
		}
		entry := map[string]any{}
		for key, value := range m.Extra {
			entry[key] = value
		}
		entry["id"] = strings.TrimSpace(m.ID)
		entry["name"] = strings.TrimSpace(m.Name)
		if entry["name"] == "" {
			entry["name"] = strings.TrimSpace(m.ID)
		}
		if n, ok := positiveInt(m.Context); ok {
			entry["contextWindow"] = n
		}
		if n, ok := positiveInt(m.MaxOutput); ok {
			entry["maxTokens"] = n
		}
		if m.Image {
			entry["input"] = []string{"text", "image"}
		} else {
			entry["input"] = []string{"text"}
		}
		if len(m.Efforts) == 0 {
			entry["reasoningEfforts"] = false
		} else {
			offered := map[string]string{}
			for _, effort := range sortedEfforts(m.Efforts) {
				offered[effort] = effort
			}
			entry["reasoningEfforts"] = offered
		}
		models = append(models, entry)
	}
	if len(models) > 0 {
		block["models"] = models
	}
	return block, nil
}

func (f *accountForm) headerMap() map[string]string {
	headers := map[string]string{}
	for _, h := range f.Headers {
		name := strings.TrimSpace(h.Name)
		if name == "" {
			continue
		}
		headers[name] = h.Value
	}
	return headers
}

func positiveInt(text string) (int, bool) {
	n, err := strconv.Atoi(strings.TrimSpace(text))
	if err != nil || n <= 0 {
		return 0, false
	}
	return n, true
}

func (f *accountForm) nativeJSONText() (string, error) {
	block, err := f.nativeConfigMap()
	if err != nil {
		return "", err
	}
	body, err := json.MarshalIndent(block, "", "  ")
	if err != nil {
		return "", err
	}
	return string(body), nil
}

func (f *accountForm) applyAdvanced() string {
	var parsed any
	if err := json.Unmarshal([]byte(f.AdvancedText), &parsed); err != nil {
		return "JSON 无法解析：" + err.Error()
	}
	if err := f.applyNative(parsed); err != nil {
		return err.Error()
	}
	return ""
}

func (f *accountForm) applyNative(value any) error {
	block, ok := value.(map[string]any)
	if !ok {
		return fmt.Errorf("JSON 必须是对象")
	}
	f.Extra = nil
	for key, extra := range block {
		switch key {
		case "api", "baseURL", "displayName", "provider", "headers", "models":
		default:
			if f.Extra == nil {
				f.Extra = map[string]any{}
			}
			f.Extra[key] = extra
		}
	}
	f.Protocol, _ = block["api"].(string)
	f.BaseURL, _ = block["baseURL"].(string)
	if name, _ := block["displayName"].(string); name != "" {
		f.Label = name
	}
	if provider, _ := block["provider"].(string); provider != "" {
		f.Provider = provider
	}
	f.Headers = nil
	if headers, ok := block["headers"].(map[string]any); ok {
		names := make([]string, 0, len(headers))
		for name := range headers {
			names = append(names, name)
		}
		sort.Strings(names)
		for _, name := range names {
			text, _ := headers[name].(string)
			f.Headers = append(f.Headers, headerRow{Name: name, Value: text})
		}
	}
	f.Models = nil
	if models, ok := block["models"].([]any); ok {
		for _, raw := range models {
			entry, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			m := dshModel{}
			m.ID, _ = entry["id"].(string)
			m.Name, _ = entry["name"].(string)
			for key, extra := range entry {
				switch key {
				case "id", "name", "contextWindow", "maxTokens", "input", "reasoningEfforts":
				default:
					if m.Extra == nil {
						m.Extra = map[string]any{}
					}
					m.Extra[key] = extra
				}
			}
			if n, ok := jsonInt(entry["contextWindow"]); ok {
				m.Context = strconv.Itoa(n)
			}
			if n, ok := jsonInt(entry["maxTokens"]); ok {
				m.MaxOutput = strconv.Itoa(n)
			}
			switch input := entry["input"].(type) {
			case []any:
				for _, item := range input {
					if text, _ := item.(string); text == "image" {
						m.Image = true
					}
				}
			case string:
				m.Image = input == "image"
			}
			switch offered := entry["reasoningEfforts"].(type) {
			case map[string]any:
				for effort := range offered {
					m.Efforts = append(m.Efforts, effort)
				}
				m.Efforts = sortedEfforts(m.Efforts)
			case bool:
				if offered {
					m.Efforts = append(m.Efforts, dshEfforts...)
				}
			}
			f.Models = append(f.Models, m)
		}
	}
	f.Preset = dshPresetFromProvider(f.Provider)
	return nil
}

func dshPresetFromProvider(provider string) string {
	switch provider {
	case "", "deepseek", "deepseek-official":
		return "deepseek"
	case "openai":
		return "openai"
	case "anthropic":
		return "anthropic"
	}
	return "custom"
}

func jsonInt(value any) (int, bool) {
	switch v := value.(type) {
	case float64:
		return int(v), true
	case json.Number:
		n, err := v.Int64()
		return int(n), err == nil
	case string:
		n, err := strconv.Atoi(strings.TrimSpace(v))
		return n, err == nil
	}
	return 0, false
}

func (a *app) fetchModels(f *accountForm) {
	f.FetchErr = ""
	if f.Preset == "custom" && strings.TrimSpace(f.BaseURL) == "" {
		f.BaseURLErr = "接口地址必填"
		return
	}
	params := map[string]any{
		"engine": "dsh", "provider": f.Provider, "protocol": f.Protocol,
		"baseUrl": strings.TrimSpace(f.BaseURL), "apiKey": f.APIKey,
	}
	if f.Mode == "edit" {
		params["id"] = f.ID
	}
	var models []modelInfo
	a.action("account:models", func() (string, error) {
		return "", a.client.call("account.models", params, &models)
	}, func(_ string, err error) {
		st := accountsFor(a)
		if st.form != f {
			return
		}
		if err != nil {
			f.FetchErr = err.Error()
			return
		}
		st.fetch = &modelFetch{Form: f, Models: models, Checked: map[string]bool{}}
		st.fetchOpen = true
	})
}

func (a *app) modelFetchView(c *ui.Context) {
	st := accountsFor(a)
	if !st.fetchOpen || st.fetch == nil {
		return
	}
	fetch := st.fetch
	open := true
	ok := feedback.Modal(c, &open, feedback.ModalProps{
		Title:      "从接口拉取模型",
		OkText:     "加入模型表",
		CancelText: "取消",
	}, func() {
		if len(fetch.Models) == 0 {
			display.Text(c, "接口没有返回模型", display.TextProps{Type: display.TextSecondary})
		}
		for _, m := range fetch.Models {
			ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
				checked := fetch.Checked[m.ID]
				cb := choice.Checkbox(c, &checked, m.ID, choice.CheckboxProps{})
				cb.Label("拉取 " + m.ID)
				if cb.Changed() {
					fetch.Checked[m.ID] = checked
				}
				if m.ContextWindow > 0 || m.MaxTokens > 0 {
					display.Text(c, fmt.Sprintf("上下文 %d · 最大输出 %d", m.ContextWindow, m.MaxTokens), display.TextProps{Type: display.TextSecondary, FontSize: 11})
				}
			})
		}
	})
	if !open {
		st.fetchOpen = false
		st.fetch = nil
		return
	}
	if ok {
		fetch.Form.addFetchedModels(fetch.Models, fetch.Checked)
		st.fetchOpen = false
		st.fetch = nil
	}
}

func (f *accountForm) addFetchedModels(models []modelInfo, checked map[string]bool) {
	for _, m := range models {
		if !checked[m.ID] {
			continue
		}
		existing := false
		for i := range f.Models {
			if f.Models[i].ID == m.ID {
				if m.ContextWindow > 0 {
					f.Models[i].Context = strconv.Itoa(m.ContextWindow)
				}
				if m.MaxTokens > 0 {
					f.Models[i].MaxOutput = strconv.Itoa(m.MaxTokens)
				}
				existing = true
				break
			}
		}
		if existing {
			continue
		}
		row := dshModel{ID: m.ID}
		if m.ContextWindow > 0 {
			row.Context = strconv.Itoa(m.ContextWindow)
		}
		if m.MaxTokens > 0 {
			row.MaxOutput = strconv.Itoa(m.MaxTokens)
		}
		f.Models = append(f.Models, row)
	}
	f.CandidateIDCustom = false
	f.reconcileCandidate()
}
