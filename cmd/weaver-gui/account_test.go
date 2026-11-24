package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"image/png"
	"math"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/MarioJames/weaver/internal/rpc"
	"github.com/egoist/mygo/ui"
)

// accountService is the skeleton's fake service with the account methods the
// accounts page uses. It embeds fakeService so the fixture, mutex and cleanup
// stay the ones the other UI tests use.
type accountService struct {
	fakeService
	configs       map[string]any
	addCalls      int
	quotaCalls    int
	usageSetCalls int
	modelCalls    int
	workerCalls   []map[string]any
}

func newAccountService(t *testing.T) *accountService {
	t.Helper()
	dir := t.TempDir()
	f := &accountService{fakeService: fakeService{home: dir, data: fixture(dir)}, configs: map[string]any{}}
	// The first account uses an imported ID on purpose: the table must never
	// show it, only the edit drawer and the login command may.
	f.data.Accounts[0].ID = "import_e6f3c04da52965f2b7c02668"
	f.data.Accounts[0].HasAPIKey = true
	f.data.Accounts[2].Resident = "ready"
	f.data.Accounts[4].Provider = "deepseek-official"
	f.data.Accounts[4].HasAPIKey = true
	f.data.Accounts[5].Provider = "openai"
	f.data.Accounts[5].Protocol = "openai-responses"
	f.data.Accounts[5].BaseURL = "https://api.openai.com/v1"
	f.data.Accounts[5].HasAPIKey = true
	f.data.Accounts[6].Provider = "anthropic"
	f.data.Accounts[6].Protocol = "anthropic-messages"
	f.data.Accounts[6].BaseURL = "https://api.anthropic.com"
	f.data.Accounts[6].HasAPIKey = true
	importID := f.data.Accounts[0].ID
	f.data.Workers = []worker{
		{ID: "claude_sonnet_high", Engine: "claude", Model: "sonnet", Effort: "high", Intelligence: 0, Enabled: true, Available: true, Accounts: []string{importID}},
		{ID: "codex_sol_medium", Engine: "codex", Model: "gpt-6.1-sol", Effort: "medium", Intelligence: 5, Enabled: true, Available: true, Accounts: []string{"a1"}},
		{ID: "opencode_deepseek", Engine: "opencode", Model: "deepseek-v4.1-flash", Effort: "max", Intelligence: 5, Enabled: true, Available: true, Accounts: []string{"a2"}},
		{ID: "opencode_muse", Engine: "opencode", Model: "muse-spark-1.3-contributor", Effort: "max", Intelligence: 0, Enabled: true, Available: true, Accounts: []string{"a2"}},
		{ID: "dsh_terra_xhigh", Engine: "dsh", Model: "gpt-6.1-terra", Effort: "xhigh", Intelligence: 0, Enabled: true, Available: true, Accounts: []string{"a5"}},
		{ID: "dsh_haiku_xhigh", Engine: "dsh", Model: "claude-haiku-5-5", Effort: "xhigh", Intelligence: 0, Enabled: true, Available: true, Accounts: []string{"a6"}},
	}
	f.configs["a5"] = map[string]any{
		"api":         "openai-responses",
		"displayName": "OpenAI API（dsh）",
		"baseURL":     "https://api.openai.com/v1",
		"models": []any{map[string]any{
			"id": "gpt-6.1-terra", "name": "gpt-6.1-terra",
			"contextWindow": 272000, "maxTokens": 128000,
			"input":            []any{"text", "image"},
			"reasoningEfforts": map[string]any{"xhigh": "xhigh", "max": "max"},
		}},
	}
	f.start(t)
	t.Cleanup(f.stop)
	return f
}

func (f *accountService) start(t *testing.T) {
	t.Helper()
	listener, err := net.Listen("unix", rpc.SocketPath(f.home))
	if err != nil {
		t.Fatal(err)
	}
	f.listener = listener
	f.wg.Add(1)
	go func() {
		defer f.wg.Done()
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			f.wg.Add(1)
			go func() {
				defer f.wg.Done()
				defer conn.Close()
				conn.SetDeadline(time.Now().Add(time.Second))
				var req rpc.Request
				if json.NewDecoder(conn).Decode(&req) != nil {
					return
				}
				f.respond(conn, req)
			}()
		}
	}()
}

func (f *accountService) respond(conn net.Conn, req rpc.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var result any
	var failure *rpc.Error
	switch req.Method {
	case "status":
		result = f.data
	case "account.list":
		result = f.data.Accounts
	case "account.add":
		var p struct {
			ID, Engine, Kind, Label, AuthDir, APIKey, Config, BaseURL, Provider, Protocol string
		}
		json.Unmarshal(req.Params, &p)
		f.addCalls++
		if p.Kind == "api" && p.APIKey == "" && p.Config == "" && p.AuthDir == "" {
			failure = &rpc.Error{Code: "INVALID", Message: "API 账号需要密钥、原生配置或已有的认证目录"}
			break
		}
		if p.ID == "" {
			p.ID = fmt.Sprintf("acct_%d", len(f.data.Accounts)+1)
		}
		acc := account{ID: p.ID, Engine: p.Engine, Kind: p.Kind, Label: p.Label, HasAPIKey: p.APIKey != "",
			HasConfig: p.Config != "", Provider: p.Provider, Protocol: p.Protocol, BaseURL: p.BaseURL, Enabled: true, Ready: true}
		f.data.Accounts = append(f.data.Accounts, acc)
		result = acc
	case "account.set":
		var p struct {
			ID       string
			Label    *string
			Enabled  *bool
			APIKey   *string
			Config   *string
			BaseURL  *string
			Provider *string
			Protocol *string
		}
		json.Unmarshal(req.Params, &p)
		acc := f.find(p.ID)
		if acc == nil {
			failure = &rpc.Error{Code: "NOT_FOUND", Message: "账号不存在"}
			break
		}
		if p.Label != nil {
			acc.Label = *p.Label
		}
		if p.Enabled != nil {
			acc.Enabled = *p.Enabled
		}
		if p.APIKey != nil {
			acc.HasAPIKey = *p.APIKey != ""
		}
		if p.Config != nil {
			acc.HasConfig = *p.Config != ""
		}
		if p.BaseURL != nil {
			acc.BaseURL = *p.BaseURL
		}
		if p.Provider != nil {
			acc.Provider = *p.Provider
		}
		if p.Protocol != nil {
			acc.Protocol = *p.Protocol
		}
		result = acc
	case "account.quota":
		var p struct{ ID string }
		_ = json.Unmarshal(req.Params, &p)
		f.quotaCalls++
		acc := f.find(p.ID)
		if acc != nil {
			acc.Quota = &accountQuota{Status: "available", Windows: []quotaWindow{{Label: "5 小时额度", UsedPercent: 42, ResetsAt: time.Now().Add(time.Hour).UnixMilli()}}, CheckedAt: time.Now().UnixMilli(), Factor: 1}
			result = []account{*acc}
		}
	case "account.check":
		var p struct{ ID string }
		json.Unmarshal(req.Params, &p)
		if p.ID == "" {
			result = f.data.Accounts
		} else if acc := f.find(p.ID); acc == nil {
			failure = &rpc.Error{Code: "NOT_FOUND", Message: "账号不存在"}
		} else {
			result = acc
		}
	case "account.config":
		var p struct{ ID string }
		json.Unmarshal(req.Params, &p)
		acc := f.find(p.ID)
		if acc == nil {
			failure = &rpc.Error{Code: "NOT_FOUND", Message: "账号不存在"}
			break
		}
		result = accountConfigView{ID: acc.ID, Engine: acc.Engine, Kind: acc.Kind, Provider: acc.Provider,
			Protocol: acc.Protocol, BaseURL: acc.BaseURL, HasAPIKey: acc.HasAPIKey, Config: f.configs[acc.ID]}
	case "account.models":
		var p struct{ ID, Engine, Provider, Protocol, BaseURL, APIKey string }
		json.Unmarshal(req.Params, &p)
		f.modelCalls++
		switch {
		case p.Provider == "deepseek-official":
			failure = &rpc.Error{Code: "INVALID", Message: "DeepSeek 官方渠道的模型由 dsh 内置"}
		case strings.Contains(p.BaseURL, "127.0.0.1") || strings.Contains(p.BaseURL, "unreachable"):
			failure = &rpc.Error{Code: "INVALID", Message: "拉取模型失败：请求模型接口失败：dial tcp 127.0.0.1:1: connect: connection refused"}
		default:
			result = []modelInfo{
				{ID: "gpt-6.1-terra", Name: "gpt-6.1-terra", ContextWindow: 272000, MaxTokens: 128000},
				{ID: "gpt-6.1-mini", Name: "gpt-6.1-mini", ContextWindow: 128000, MaxTokens: 32000},
			}
		}
	case "account.usage.set":
		var p map[string]json.RawMessage
		json.Unmarshal(req.Params, &p)
		var id string
		json.Unmarshal(p["id"], &id)
		f.usageSetCalls++
		acc := f.find(id)
		if acc == nil {
			failure = &rpc.Error{Code: "NOT_FOUND", Message: "账号不存在"}
			break
		}
		if acc.Usage == nil {
			acc.Usage = &usage{}
		}
		u := acc.Usage
		value := func(key string, target **float64) {
			if raw, ok := p[key]; ok {
				var v *float64
				json.Unmarshal(raw, &v)
				*target = v
			}
		}
		value("alertBelow", &u.AlertBelow)
		if raw, ok := p["prices"]; ok {
			var prices []struct {
				Model string
				usagePrices
			}
			json.Unmarshal(raw, &prices)
			for _, price := range prices {
				for i := range u.Models {
					if u.Models[i].Model == price.Model {
						u.Models[i].Prices = price.usagePrices
					}
				}
			}
		}
		if _, ok := p["balance"]; ok {
			value("balance", &u.Balance)
			u.BalanceAt = time.Now().UnixMilli()
			u.SpentSinceBalance = nil
		}
		u.Remaining = nil
		if u.Balance != nil {
			spent := 0.0
			if u.SpentSinceBalance != nil {
				spent = *u.SpentSinceBalance
			}
			remaining := *u.Balance - spent
			u.Remaining = &remaining
		}
		u.Low = u.Remaining != nil && u.AlertBelow != nil && *u.Remaining < *u.AlertBelow
		result = acc
	case "account.pause":
		var p struct {
			ID     string
			ForMs  int64
			Reason string
		}
		json.Unmarshal(req.Params, &p)
		acc := f.find(p.ID)
		if acc == nil {
			failure = &rpc.Error{Code: "NOT_FOUND", Message: "账号不存在"}
			break
		}
		acc.PausedUntil = time.Now().Add(time.Duration(p.ForMs) * time.Millisecond).UnixMilli()
		acc.PauseReason = p.Reason
		result = acc
	case "account.resume":
		var p struct{ ID string }
		json.Unmarshal(req.Params, &p)
		acc := f.find(p.ID)
		if acc == nil {
			failure = &rpc.Error{Code: "NOT_FOUND", Message: "账号不存在"}
			break
		}
		acc.PausedUntil, acc.PauseReason = 0, ""
		result = acc
	case "account.remove":
		var p struct{ ID string }
		json.Unmarshal(req.Params, &p)
		acc := f.find(p.ID)
		if acc == nil {
			failure = &rpc.Error{Code: "NOT_FOUND", Message: "账号不存在"}
			break
		}
		if acc.Running > 0 {
			failure = &rpc.Error{Code: "INVALID", Message: fmt.Sprintf("账号上还有 %d 个包在运行", acc.Running)}
			break
		}
		remaining := f.data.Accounts[:0]
		for _, item := range f.data.Accounts {
			if item.ID != p.ID {
				remaining = append(remaining, item)
			}
		}
		f.data.Accounts = remaining
		for i := range f.data.Workers {
			var keep []string
			for _, id := range f.data.Workers[i].Accounts {
				if id != p.ID {
					keep = append(keep, id)
				}
			}
			f.data.Workers[i].Accounts = keep
		}
		result = map[string]bool{"ok": true}
	case "worker.set":
		var p map[string]any
		json.Unmarshal(req.Params, &p)
		f.workerCalls = append(f.workerCalls, p)
		id, _ := p["id"].(string)
		engineName, _ := p["engine"].(string)
		model, _ := p["model"].(string)
		effort, _ := p["effort"].(string)
		intelligence := 0.0
		if n, ok := p["intelligence"].(float64); ok {
			intelligence = n
		}
		var accounts []string
		if list, ok := p["accounts"].([]any); ok {
			for _, item := range list {
				if text, ok := item.(string); ok {
					accounts = append(accounts, text)
				}
			}
		}
		f.data.Workers = append(f.data.Workers, worker{ID: id, Engine: engineName, Model: model, Effort: effort, Intelligence: intelligence, Enabled: true, Available: true, Accounts: accounts})
		result = map[string]any{"id": id, "intelligence": intelligence}
	default:
		failure = &rpc.Error{Code: "NOT_FOUND", Message: "未知方法"}
	}
	body, _ := json.Marshal(result)
	json.NewEncoder(conn).Encode(rpc.Response{OK: failure == nil, Result: body, Error: failure})
}

func (f *accountService) find(id string) *account {
	for i := range f.data.Accounts {
		if f.data.Accounts[i].ID == id {
			return &f.data.Accounts[i]
		}
	}
	return nil
}

func openAccountMore(t *testing.T, tt *ui.Tester, label string) {
	t.Helper()
	click(t, tt, "更多操作 "+label)
}

func openAccounts(t *testing.T, f *accountService) (*app, *ui.Tester) {
	t.Helper()
	a := testApp(t, &f.fakeService)
	tt := ui.NewTester(a.view, 1280, 900)
	click(t, tt, "账号")
	return a, tt
}

func countText(tt *ui.Tester, text string) int {
	n := 0
	for _, item := range tt.Texts() {
		if item == text {
			n++
		}
	}
	return n
}

func accountFormValue(t *testing.T, a *app, read func(*accountForm)) {
	t.Helper()
	a.mu.Lock()
	defer a.mu.Unlock()
	f := accountsFor(a).form
	if f == nil {
		t.Fatal("账号表单没有打开")
	}
	read(f)
}

func seedUsage(f *accountService, id string, u *usage) {
	f.mu.Lock()
	defer f.mu.Unlock()
	acc := f.find(id)
	if acc != nil {
		acc.Usage = u
	}
}

func moneyPtr(v float64) *float64 { return &v }

func TestAccountsA1Table(t *testing.T) {
	f := newAccountService(t)
	_, tt := openAccounts(t, f)
	for _, label := range []string{"Claude 5x Max", "ChatGPT Pro 5x", "opencode no••@gmail.com", "opencode im••@gmail.com / Default", "dsh deepseek-official", "OpenAI API（dsh）", "Anthropic API（dsh）"} {
		if !tt.HasText(label) {
			t.Errorf("缺少账号 %q", label)
		}
	}
	if !tt.HasText("7 个账号") {
		t.Errorf("账号数不对：%q", tt.Texts())
	}
	if !tt.HasText("已停用") {
		t.Errorf("缺少已停用")
	}
	if got := countText(tt, "没有候选在用"); got != 2 {
		t.Errorf("没有候选在用 = %d，want 2", got)
	}
	for _, id := range []string{"claude_sonnet_high", "codex_sol_medium", "opencode_deepseek", "opencode_muse", "dsh_terra_xhigh", "dsh_haiku_xhigh"} {
		if !tt.HasText(id) {
			t.Errorf("缺少候选 %q", id)
		}
	}
	if tt.HasText("import_") {
		t.Errorf("账号表出现了 import_ ID：%q", tt.Texts())
	}
	if !tt.HasText("opencode · 订阅 · 常驻就绪") {
		t.Errorf("缺少常驻状态：%q", tt.Texts())
	}
}

func TestAccountsA5DeleteConfirmationAndRunningError(t *testing.T) {
	f := newAccountService(t)
	a, tt := openAccounts(t, f)
	openAccountMore(t, tt, "Claude 5x Max")
	click(t, tt, "删除 Claude 5x Max")
	if !tt.HasText("凭据目录会留在磁盘上") || !tt.HasText("claude_sonnet_high") {
		t.Fatalf("删除确认没有列出候选或凭据目录：%q", tt.Texts())
	}
	click(t, tt, "确认移除")
	waitFor(t, tt, a, func() bool {
		f.mu.Lock()
		defer f.mu.Unlock()
		importID := "import_e6f3c04da52965f2b7c02668"
		return f.find(importID) == nil && !a.busy["account:remove:"+importID]
	})
	if countText(tt, "Claude 5x Max") != 0 {
		t.Fatalf("删除后账号还在：%q", tt.Texts())
	}

	f.mu.Lock()
	f.find("a1").Running = 1
	f.mu.Unlock()
	openAccountMore(t, tt, "ChatGPT Pro 5x")
	click(t, tt, "删除 ChatGPT Pro 5x")
	if !tt.HasText("凭据目录会留在磁盘上") || !tt.HasText("codex_sol_medium") {
		t.Fatalf("删除确认没有列出 codex 候选：%q", tt.Texts())
	}
	click(t, tt, "确认移除")
	waitFor(t, tt, a, func() bool {
		return !a.busy["account:remove:a1"] && a.errors["account:remove:a1"] != ""
	})
	if !tt.HasText("账号上还有 1 个包在运行") {
		t.Fatalf("没有原样显示服务报错：%q", tt.Texts())
	}
	if !tt.HasText("ChatGPT Pro 5x") {
		t.Fatalf("报错后账号没有保留：%q", tt.Texts())
	}
}

func TestAccountsA20PresetChangesProtocolAndAddress(t *testing.T) {
	f := newAccountService(t)
	a, tt := openAccounts(t, f)
	click(t, tt, "接入账号")
	click(t, tt, "OpenAI 官方")
	accountFormValue(t, a, func(form *accountForm) {
		if form.Protocol != "openai-responses" || form.BaseURL != "https://api.openai.com/v1" || form.Provider != "openai" {
			t.Fatalf("OpenAI 预设不对：%+v", form)
		}
	})
	if !tt.HasText("openai-responses") {
		t.Fatalf("界面没有显示 OpenAI 协议：%q", tt.Texts())
	}
	if info, ok := tt.AccessByRole(ui.RoleTextField, "接口地址"); !ok || info.Value != "https://api.openai.com/v1" {
		t.Fatalf("界面没有显示 OpenAI 地址：%+v %v", info, ok)
	}
	click(t, tt, "Anthropic 官方")
	accountFormValue(t, a, func(form *accountForm) {
		if form.Protocol != "anthropic-messages" || form.BaseURL != "https://api.anthropic.com" || form.Provider != "anthropic" {
			t.Fatalf("Anthropic 预设不对：%+v", form)
		}
	})
	if !tt.HasText("anthropic-messages") {
		t.Fatalf("界面没有显示 Anthropic 协议：%q", tt.Texts())
	}
	if info, ok := tt.AccessByRole(ui.RoleTextField, "接口地址"); !ok || info.Value != "https://api.anthropic.com" {
		t.Fatalf("界面没有显示 Anthropic 地址：%+v %v", info, ok)
	}
}

func TestAccountsA22DSHConfigReadback(t *testing.T) {
	f := newAccountService(t)
	a, tt := openAccounts(t, f)
	click(t, tt, "编辑 OpenAI API（dsh）")
	waitFor(t, tt, a, func() bool {
		form := accountsFor(a).form
		return form != nil && !form.Loading && len(form.Models) == 1
	})
	accountFormValue(t, a, func(form *accountForm) {
		if form.Provider != "openai" || form.Protocol != "openai-responses" || form.BaseURL != "https://api.openai.com/v1" {
			t.Fatalf("渠道字段没有读回：%+v", form)
		}
		model := form.Models[0]
		if model.ID != "gpt-6.1-terra" || model.Context != "272000" || model.MaxOutput != "128000" || !model.Image {
			t.Fatalf("模型没有读回：%+v", model)
		}
		if strings.Join(model.Efforts, ",") != "xhigh,max" {
			t.Fatalf("思考力度 = %v", model.Efforts)
		}
	})
	for _, label := range []string{"模型 1 上下文窗口", "模型 1 最大输出"} {
		info, ok := tt.AccessByRole(ui.RoleTextField, label)
		if !ok {
			t.Fatalf("缺少字段 %q", label)
		}
		want := "272000"
		if strings.Contains(label, "最大输出") {
			want = "128000"
		}
		if info.Value != want {
			t.Errorf("%s = %q，want %q", label, info.Value, want)
		}
	}
	if info, ok := tt.Access("模型 1 图片输入"); !ok || !info.Checked {
		t.Errorf("图片输入没有打开：%+v %v", info, ok)
	}
	for _, effort := range []string{"xhigh", "max"} {
		if info, ok := tt.Access("模型 1 力度 " + effort); !ok || !info.Checked {
			t.Errorf("力度 %s 没有选中：%+v %v", effort, info, ok)
		}
	}
	if !tt.HasText("已设置，留空表示不改") {
		t.Errorf("密钥栏没有显示已设置：%q", tt.Texts())
	}
	if info, ok := tt.AccessByRole(ui.RoleTextField, "模型 1 ID"); !ok || info.Value != "gpt-6.1-terra" {
		t.Errorf("模型 ID 没显示：%+v %v", info, ok)
	}
}

func TestAccountsA23CandidateEfforts(t *testing.T) {
	f := newAccountService(t)
	a, tt := openAccounts(t, f)
	click(t, tt, "接入账号")
	edit(t, tt, "名称", "OpenAI 测试渠道", false)
	edit(t, tt, "API 密钥", "sk-test-secret-value", false)
	click(t, tt, "添加模型")
	edit(t, tt, "模型 1 ID", "gpt-6.1-terra", false)
	edit(t, tt, "模型 1 上下文窗口", "272000", false)
	edit(t, tt, "模型 1 最大输出", "128000", false)
	click(t, tt, "模型 1 力度 xhigh")
	click(t, tt, "模型 1 力度 max")
	click(t, tt, "同时建候选")
	accountFormValue(t, a, func(form *accountForm) {
		if got := strings.Join(form.candidateEfforts(), ","); got != "xhigh,max" {
			t.Fatalf("候选强度选项 = %s", got)
		}
		if form.CandidateID != "dsh_terra_xhigh" {
			t.Fatalf("候选 ID 默认值 = %q", form.CandidateID)
		}
		if form.CandidateIntelligence != "0" {
			t.Fatalf("候选能力分默认值 = %q", form.CandidateIntelligence)
		}
	})
	edit(t, tt, "候选 ID", "dsh_my_choice", false)
	tt.Frame()
	accountFormValue(t, a, func(form *accountForm) {
		if form.CandidateID != "dsh_my_choice" {
			t.Fatalf("候选 ID 不能改：%q", form.CandidateID)
		}
	})
	edit(t, tt, "候选 ID", "dsh_terra_xhigh", false)
	tt.Frame()
	click(t, tt, "保存并检查")
	waitFor(t, tt, a, func() bool {
		return accountsFor(a).form == nil && len(f.workerCalls) == 1
	})
	f.mu.Lock()
	call := f.workerCalls[0]
	f.mu.Unlock()
	if call["id"] != "dsh_terra_xhigh" || call["model"] != "gpt-6.1-terra" || call["effort"] != "xhigh" {
		t.Fatalf("worker.set 参数不对：%+v", call)
	}
	if intelligence, _ := call["intelligence"].(float64); intelligence != 0 {
		t.Fatalf("候选能力分 = %v", call["intelligence"])
	}
	assertNoSecret(t, a, tt, "sk-test-secret-value")
}

func TestAccountsA24CustomAddressAndFetchFailure(t *testing.T) {
	f := newAccountService(t)
	a, tt := openAccounts(t, f)
	click(t, tt, "接入账号")
	click(t, tt, "自定义")
	edit(t, tt, "名称", "自定义渠道", false)
	edit(t, tt, "API 密钥", "sk-custom-secret", false)
	clearField(t, tt, "接口地址")
	click(t, tt, "保存并检查")
	if !tt.HasText("接口地址必填") {
		t.Fatalf("缺少地址必填提示：%q", tt.Texts())
	}
	f.mu.Lock()
	addCalls := f.addCalls
	f.mu.Unlock()
	if addCalls != 0 {
		t.Fatalf("地址为空仍然保存了：%d", addCalls)
	}
	edit(t, tt, "接口地址", "http://127.0.0.1:1/v1", false)
	click(t, tt, "从接口拉取")
	waitFor(t, tt, a, func() bool {
		form := accountsFor(a).form
		return form != nil && form.FetchErr != ""
	})
	if !tt.HasText("connection refused") {
		t.Fatalf("没有显示拉取失败原因：%q", tt.Texts())
	}
	accountFormValue(t, a, func(form *accountForm) {
		if form.BaseURL != "http://127.0.0.1:1/v1" || form.Label != "自定义渠道" || form.APIKey != "sk-custom-secret" {
			t.Fatalf("拉取失败后表单内容丢了：%+v", form)
		}
	})
	f.mu.Lock()
	stillNoAdd := f.addCalls
	f.mu.Unlock()
	if stillNoAdd != 0 {
		t.Fatalf("拉取失败竟然保存了账号：%d", stillNoAdd)
	}
}

// TestUsageSettingsRoundTrip covers A2: balance, alert line and the four
// prices are saved and come back when the drawer opens again.
func TestUsageSettingsRoundTrip(t *testing.T) {
	f := newAccountService(t)
	seedUsage(f, "a6", &usage{Models: []modelUsage{{Model: "claude-haiku-5-5"}, {Model: "claude-sonnet-5-5"}}})
	a, tt := openAccounts(t, f)
	click(t, tt, "配置用量 Anthropic API（dsh）")
	for label, value := range map[string]string{"当前余额": "50", "低于多少提示": "5",
		"claude-haiku-5-5 输入单价": "1", "claude-haiku-5-5 输出单价": "5", "claude-haiku-5-5 缓存读单价": "0.1", "claude-haiku-5-5 缓存写单价": "1.25",
		"claude-sonnet-5-5 输入单价": "3", "claude-sonnet-5-5 输出单价": "15"} {
		edit(t, tt, label, value, false)
	}
	click(t, tt, "保存")
	waitFor(t, tt, a, func() bool { return !a.busy["account:usage.save:a6"] && f.setCalls() == 1 })
	if !tt.HasText("用量设置已保存") {
		t.Fatalf("没有保存提示：%q", tt.Texts())
	}
	click(t, tt, "关闭")
	click(t, tt, "配置用量 Anthropic API（dsh）")
	p := accountsFor(a).usage
	if p == nil || p.Balance != "50.00" || p.Alert != "5" || len(p.Models) != 2 ||
		p.Models[0].Values != [4]string{"1", "5", "0.1", "1.25"} || p.Models[1].Values != [4]string{"3", "15", "", ""} {
		t.Fatalf("再次打开的值不对：%+v", p)
	}
	if !tt.HasText("记录于 " + time.UnixMilli(p.BalanceAt).Format("01-02 15:04")) {
		t.Fatalf("没有余额记录时间：%q", tt.Texts())
	}
	// Saving again without touching the balance must not restamp it.
	click(t, tt, "保存")
	waitFor(t, tt, a, func() bool { return !a.busy["account:usage.save:a6"] && f.setCalls() == 2 })
	f.mu.Lock()
	at := f.find("a6").Usage.BalanceAt
	f.mu.Unlock()
	if at != p.BalanceAt {
		t.Fatalf("没改余额却重记了时间：%d → %d", p.BalanceAt, at)
	}
}

func (f *accountService) setCalls() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.usageSetCalls
}

// TestUsageRejectsABadPrice covers A3: nothing is sent and the stored value stays.
func TestUsageRejectsABadPrice(t *testing.T) {
	f := newAccountService(t)
	seedUsage(f, "a6", &usage{Models: []modelUsage{{Model: "claude-haiku-5-5", Prices: usagePrices{Input: moneyPtr(1)}}}})
	_, tt := openAccounts(t, f)
	click(t, tt, "配置用量 Anthropic API（dsh）")
	for _, bad := range []string{"abc", "-1"} {
		clearField(t, tt, "claude-haiku-5-5 输入单价")
		edit(t, tt, "claude-haiku-5-5 输入单价", bad, false)
		click(t, tt, "保存")
		tt.Advance(time.Second)
		if !tt.HasText("claude-haiku-5-5 的输入单价需要不小于 0 的数字") {
			t.Fatalf("%q 没有报错：%q", bad, tt.Texts())
		}
	}
	if f.setCalls() != 0 {
		t.Fatalf("非法单价被提交了 %d 次", f.setCalls())
	}
}

// TestUsageWithoutPricesShowsTokens covers A8.
func TestUsageWithoutPricesShowsTokens(t *testing.T) {
	f := newAccountService(t)
	seedUsage(f, "a5", &usage{Month: usageTotals{Runs: 12, InputTokens: 1_200_000, OutputTokens: 150_000, Unpriced: 12},
		Balance: moneyPtr(50), BalanceAt: time.Now().UnixMilli()})
	_, tt := openAccounts(t, f)
	for _, text := range []string{"1.4M 令牌", "12 次 · 未填单价", "填单价后可估算"} {
		if !tt.HasText(text) {
			t.Fatalf("没有 %q：%q", text, tt.Texts())
		}
	}
	click(t, tt, "配置用量 OpenAI API（dsh）")
	if !tt.HasText("本月 12 次运行 · 输入 1.2M · 输出 150K · 缓存读 0 · 缓存写 0 · 12 次未计价") {
		t.Fatalf("抽屉里没有本月统计：%q", tt.Texts())
	}
}

// TestAccountsA30LowRemainingIsRed covers A7.
func TestAccountsA30LowRemainingIsRed(t *testing.T) {
	f := newAccountService(t)
	seedUsage(f, "a5", &usage{Month: usageTotals{Runs: 37, Cost: moneyPtr(48.10)},
		Balance: moneyPtr(50), BalanceAt: time.Now().UnixMilli(), SpentSinceBalance: moneyPtr(48.10), Remaining: moneyPtr(1.90)})
	a, tt := openAccounts(t, f)
	click(t, tt, "配置用量 OpenAI API（dsh）")
	edit(t, tt, "低于多少提示", "5", false)
	click(t, tt, "保存")
	waitFor(t, tt, a, func() bool {
		f.mu.Lock()
		defer f.mu.Unlock()
		acc := f.find("a5")
		return acc != nil && acc.Usage != nil && acc.Usage.Low && !a.busy["account:usage.save:a5"]
	})
	click(t, tt, "关闭")
	text := "$1.90 · 低于 $5"
	if !tt.HasText(text) {
		t.Fatalf("估算剩余没有提示线：%q", tt.Texts())
	}
	if !textHasDangerPixel(tt, text, 1280) {
		t.Fatalf("%q 不是红色", text)
	}
	click(t, tt, "概览")
	if !tt.HasText("OpenAI API（dsh） 估算剩余低于 $5") {
		t.Fatalf("概览没有提醒：%q", tt.Texts())
	}
}

func clearField(t *testing.T, tt *ui.Tester, label string) {
	t.Helper()
	click(t, tt, label)
	tt.Key(ui.Ctrl, ui.KeyA)
	tt.Key(0, ui.KeyBackspace)
	tt.Advance(time.Second)
}

func assertNoSecret(t *testing.T, a *app, tt *ui.Tester, secret string) {
	t.Helper()
	if tt.HasText(secret) {
		t.Errorf("界面文字包含密钥原文：%q", tt.Texts())
	}
	for _, info := range tt.AccessAll() {
		if strings.Contains(info.Name, secret) || strings.Contains(info.Value, secret) || strings.Contains(info.Description, secret) || strings.Contains(info.Placeholder, secret) {
			t.Errorf("辅助功能信息包含密钥原文：%+v", info)
		}
	}
	a.mu.Lock()
	data, _ := json.Marshal(a.snapshot)
	a.mu.Unlock()
	if bytes.Contains(data, []byte(secret)) {
		t.Errorf("status 快照包含密钥原文")
	}
}

func textHasDangerPixel(tt *ui.Tester, text string, width int) bool {
	rect, ok := tt.Find(text)
	if !ok {
		return false
	}
	img := tt.Image()
	scale := float32(img.Bounds().Dx()) / float32(width)
	for y := int(rect.Y * scale); y < int((rect.Y+rect.H)*scale); y++ {
		for x := int(rect.X * scale); x < int((rect.X+rect.W)*scale); x++ {
			if x < 0 || y < 0 || x >= img.Bounds().Dx() || y >= img.Bounds().Dy() {
				continue
			}
			r, g, b, _ := img.At(x, y).RGBA()
			if math.Abs(float64(r>>8)-243) < 45 && math.Abs(float64(g>>8)-88) < 80 && math.Abs(float64(b>>8)-55) < 80 {
				return true
			}
		}
	}
	return false
}

func TestAccountScreenshots(t *testing.T) {
	dir := os.Getenv("WEAVER_ACCOUNT_SCREENSHOTS")
	if dir == "" {
		t.Skip("未设置截图目录")
	}
	f := newAccountService(t)
	checked := time.Now().Add(-3 * time.Minute).UnixMilli()
	f.find("a1").Quota = &accountQuota{
		Status:  "exhausted",
		Windows: []quotaWindow{{Label: "7 天额度", UsedPercent: 100, ResetsAt: time.Now().Add(50 * time.Hour).UnixMilli()}},
		Credits: &quotaCredits{HasCredits: true, Balance: 57525.497649, HasBalance: true},
		ResetCredits: &quotaResetCredits{
			AvailableCount: 1,
			NextExpiresAt:  time.Date(2026, 12, 12, 22, 18, 0, 0, time.UTC).UnixMilli(),
		},
		CheckedAt: checked,
		Factor:    0,
	}
	f.find("import_e6f3c04da52965f2b7c02668").Quota = &accountQuota{Status: "available", Windows: []quotaWindow{{Label: "5 小时额度", UsedPercent: 0}, {Label: "7 天额度", UsedPercent: 98, ResetsAt: time.Now().Add(11 * time.Hour).UnixMilli()}, {Label: "7 天额度", Model: "Fable", UsedPercent: 70, ResetsAt: time.Now().Add(11 * time.Hour).UnixMilli()}}, CheckedAt: checked, Factor: 0.3}

	seedUsage(f, "a5", &usage{Month: usageTotals{Runs: 12, InputTokens: 1_200_000, OutputTokens: 150_000, Unpriced: 12},
		Balance: moneyPtr(50), BalanceAt: checked})
	seedUsage(f, "a6", &usage{Month: usageTotals{Runs: 37, Cost: moneyPtr(2.66)}, Models: []modelUsage{{Model: "claude-haiku-5-5", Prices: usagePrices{Input: moneyPtr(1), Output: moneyPtr(5)}, Runs: 37, Cost: moneyPtr(2.66)}},
		Balance: moneyPtr(50), BalanceAt: checked, SpentSinceBalance: moneyPtr(2.66), Remaining: moneyPtr(47.34), AlertBelow: moneyPtr(48), Low: true})
	a, tt := openAccounts(t, f)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	save := func(name string) {
		file, err := os.Create(filepath.Join(dir, name))
		if err != nil {
			t.Fatal(err)
		}
		err = png.Encode(file, tt.Image())
		file.Close()
		if err != nil {
			t.Fatal(err)
		}
	}
	save("accounts.png")
	click(t, tt, "编辑 OpenAI API（dsh）")
	waitFor(t, tt, a, func() bool {
		form := accountsFor(a).form
		return form != nil && !form.Loading && len(form.Models) == 1
	})
	save("dsh-channel.png")
	click(t, tt, "取消")
	click(t, tt, "配置用量 OpenAI API（dsh）")
	save("usage.png")
}

func TestLoginFallbackCommand(t *testing.T) {
	stubLoginLibraryFailure(t)
	f := newAccountService(t)
	_, tt := openAccounts(t, f)
	openAccountMore(t, tt, "Claude 5x Max")
	click(t, tt, "登录 Claude 5x Max")
	if !tt.HasText("在终端里运行：") || !tt.HasText("weaver account login import_e6f3c04da52965f2b7c02668") {
		t.Fatalf("登录降级框没有命令：%q", tt.Texts())
	}
	if !tt.HasText("我已登录，重新检查") || !tt.HasText("复制命令") {
		t.Fatalf("登录降级框缺少按钮：%q", tt.Texts())
	}
	click(t, tt, "关闭")
	if tt.HasText("在终端里运行：") {
		t.Fatalf("登录框没有关闭：%q", tt.Texts())
	}
}

func TestDSHFetchModelsAppendsRows(t *testing.T) {
	f := newAccountService(t)
	a, tt := openAccounts(t, f)
	click(t, tt, "接入账号")
	edit(t, tt, "API 密钥", "sk-fetch-secret", false)
	click(t, tt, "从接口拉取")
	waitFor(t, tt, a, func() bool {
		return accountsFor(a).fetchOpen
	})
	if !tt.HasText("gpt-6.1-terra") || !tt.HasText("上下文 272000 · 最大输出 128000") {
		t.Fatalf("拉取结果没有列出模型与容量：%q", tt.Texts())
	}
	click(t, tt, "拉取 gpt-6.1-terra")
	click(t, tt, "加入模型表")
	waitFor(t, tt, a, func() bool {
		form := accountsFor(a).form
		return form != nil && len(form.Models) == 1
	})
	accountFormValue(t, a, func(form *accountForm) {
		m := form.Models[0]
		if m.ID != "gpt-6.1-terra" || m.Context != "272000" || m.MaxOutput != "128000" {
			t.Fatalf("模型表没有带入容量：%+v", m)
		}
	})
	assertNoSecret(t, a, tt, "sk-fetch-secret")
}

func TestDSHAdvancedJSONRoundTrip(t *testing.T) {
	f := newAccountForm()
	f.Label = "测试渠道"
	f.Provider = "openai"
	f.Protocol = "openai-responses"
	f.BaseURL = "https://api.openai.com/v1"
	f.Headers = []headerRow{{Name: "X-Tenant", Value: "abc"}}
	f.Extra = map[string]any{"timeout": 30}
	f.Models = []dshModel{{ID: "gpt-6.1-terra", Context: "272000", MaxOutput: "128000", Image: true, Efforts: []string{"xhigh", "max"}, Extra: map[string]any{"compat": true}}}
	text, err := f.nativeJSONText()
	if err != nil {
		t.Fatal(err)
	}
	g := newAccountForm()
	g.AdvancedText = text
	if message := g.applyAdvanced(); message != "" {
		t.Fatal(message)
	}
	if len(g.Models) != 1 || g.Models[0].ID != "gpt-6.1-terra" || !g.Models[0].Image {
		t.Fatalf("JSON 回填模型不对：%+v", g.Models)
	}
	if g.Protocol != "openai-responses" || g.BaseURL != "https://api.openai.com/v1" || g.Label != "测试渠道" {
		t.Fatalf("JSON 回填字段不对：%+v", g)
	}
	if len(g.Headers) != 1 || g.Headers[0].Name != "X-Tenant" {
		t.Fatalf("JSON 回填请求头不对：%+v", g.Headers)
	}
	if g.Extra["timeout"] != float64(30) || g.Models[0].Extra["compat"] != true {
		t.Fatalf("JSON 回填丢掉了原生字段：%+v %+v", g.Extra, g.Models[0].Extra)
	}
	g.AdvancedText = "{"
	if message := g.applyAdvanced(); message == "" {
		t.Fatal("非法 JSON 没有报错")
	}

	plain := newAccountForm()
	plain.Provider = "openai"
	plain.Protocol = "openai-responses"
	plain.BaseURL = "https://api.openai.com/v1"
	plain.Models = []dshModel{{ID: "no-reasoning"}}
	config, err := plain.nativeConfig()
	if err != nil {
		t.Fatal(err)
	}
	var parsed struct {
		API    string `json:"api"`
		Models []struct {
			ID               string `json:"id"`
			ReasoningEfforts any    `json:"reasoningEfforts"`
		} `json:"models"`
	}
	if err := json.Unmarshal([]byte(config), &parsed); err != nil {
		t.Fatal(err)
	}
	if parsed.API != "openai-responses" || len(parsed.Models) != 1 || parsed.Models[0].ReasoningEfforts != false {
		t.Fatalf("原生配置不对：%s", config)
	}
}

func TestAccountsEnableToggle(t *testing.T) {
	f := newAccountService(t)
	a, tt := openAccounts(t, f)
	label := "启用 opencode im••@gmail.com / Default"
	click(t, tt, label)
	waitFor(t, tt, a, func() bool {
		f.mu.Lock()
		defer f.mu.Unlock()
		acc := f.find("a3")
		return acc != nil && acc.Enabled
	})
	if tt.HasText("已停用") {
		t.Fatalf("启用后仍显示已停用：%q", tt.Texts())
	}
	click(t, tt, label)
	waitFor(t, tt, a, func() bool {
		f.mu.Lock()
		defer f.mu.Unlock()
		acc := f.find("a3")
		return acc != nil && !acc.Enabled
	})
	if !tt.HasText("已停用") {
		t.Fatalf("停用后没有显示已停用：%q", tt.Texts())
	}
}

func TestDSHAddWithoutKeyUsesServiceValidation(t *testing.T) {
	f := newAccountService(t)
	a, tt := openAccounts(t, f)
	click(t, tt, "接入账号")
	edit(t, tt, "名称", "没有密钥的渠道", false)
	click(t, tt, "保存并检查")
	waitFor(t, tt, a, func() bool {
		form := accountsFor(a).form
		return form != nil && form.Err != ""
	})
	if !tt.HasText("API 账号需要密钥、原生配置或已有的认证目录") {
		t.Fatalf("默认 dsh 表单没有把服务校验显示出来：%q", tt.Texts())
	}
	f.mu.Lock()
	count, calls := len(f.data.Accounts), f.addCalls
	f.mu.Unlock()
	if count != 7 || calls != 1 {
		t.Fatalf("账号数 %d，add 调用 %d", count, calls)
	}
}

// A balance just under the alert line must not read as equal to it, and a
// spend under one cent must not read as nothing.
func TestUsageAmountsNeverReadWrong(t *testing.T) {
	for _, c := range []struct{ got, want string }{
		{remainingMoney(49.996843), "$49.99"},
		{remainingMoney(47.34), "$47.34"},
		{money(0.000915), "<$0.01"},
		{money(0), "$0.00"},
		{money(2.666), "$2.67"},
	} {
		if c.got != c.want {
			t.Errorf("got %q, want %q", c.got, c.want)
		}
	}
}

func TestAccountQuotaRefresh(t *testing.T) {
	f := newAccountService(t)
	a, tt := openAccounts(t, f)
	// Nothing was read yet: the row keeps its dashes and offers no extra line.
	if tt.HasText("读取于") {
		t.Fatal("quota shown before it was read")
	}
	openAccountMore(t, tt, "Claude 5x Max")
	click(t, tt, "刷新额度 Claude 5x Max")
	waitFor(t, tt, a, func() bool {
		f.mu.Lock()
		defer f.mu.Unlock()
		return f.quotaCalls == 1 && !a.busy["account:quota:import_e6f3c04da52965f2b7c02668"]
	})
	tt.Frame()
	for _, label := range []string{"5 小时额度 已用 42%"} {
		if _, ok := tt.Find(label); !ok {
			t.Fatalf("missing %q: %v", label, tt.Texts())
		}
	}
	found := false
	for _, text := range tt.Texts() {
		if strings.HasPrefix(text, "读取于 ") {
			found = true
		}
	}
	if !found || !tt.HasText("42%") || !tt.HasText("5 小时") {
		t.Fatalf("missing refreshed quota window: %v", tt.Texts())
	}
}

func TestModelQuotaWindowNamesItsModel(t *testing.T) {
	if got := quotaWindowLabel(quotaWindow{Label: "7 天额度", Model: "Fable"}); got != "7 天 · Fable" {
		t.Fatalf("model window label = %q", got)
	}
	if got := quotaWindowLabel(quotaWindow{Label: "7 天额度"}); got != "7 天" {
		t.Fatalf("account window label = %q", got)
	}
}

func TestCodexCreditsAndResetCardsDisplay(t *testing.T) {
	for _, tc := range []struct {
		got, want string
	}{
		{formatCreditsBalance(57525.497649), "57,525.5"},
		{formatCreditsBalance(1000), "1,000"},
		{formatCreditsBalance(12.345), "12.35"},
		{formatCreditsBalance(0), "0"},
	} {
		if tc.got != tc.want {
			t.Errorf("formatCreditsBalance = %q, want %q", tc.got, tc.want)
		}
	}
	if v, s, w := formatCredits(&quotaCredits{Unlimited: true}); v != "无限制" || s != "不限量" || w {
		t.Fatalf("unlimited = %q %q %v", v, s, w)
	}
	if v, s, w := formatCredits(&quotaCredits{HasCredits: true, HasBalance: true, Balance: 10, OverageLimitReached: true}); v != "10" || s != "已达上限" || !w {
		t.Fatalf("overage = %q %q %v", v, s, w)
	}

	f := newAccountService(t)
	checked := time.Now().Add(-time.Minute).UnixMilli()
	expiry := time.Date(2026, 12, 12, 12, 0, 0, 0, time.Local).UnixMilli()
	f.find("a1").Quota = &accountQuota{
		Status:       "exhausted",
		Windows:      []quotaWindow{{Label: "7 天额度", UsedPercent: 100, ResetsAt: time.Now().Add(24 * time.Hour).UnixMilli()}},
		Credits:      &quotaCredits{HasCredits: true, Balance: 57525.497649, HasBalance: true},
		ResetCredits: &quotaResetCredits{AvailableCount: 1, NextExpiresAt: expiry},
		CheckedAt:    checked,
		Factor:       0,
	}
	for _, width := range []int{1280, 800} {
		a := testApp(t, &f.fakeService)
		tt := ui.NewTester(a.view, width, 820)
		click(t, tt, "账号")
		for _, want := range []string{"Credits", "57,525.5", "可用", "重置卡", "1 张", "12-12 到期"} {
			if !tt.HasText(want) {
				t.Fatalf("width=%d missing %q in %v", width, want, tt.Texts())
			}
		}
		if _, ok := tt.Find("Credits 57,525.5 可用"); !ok {
			t.Fatalf("width=%d missing accessible Credits label", width)
		}
		if _, ok := tt.Find("重置卡 1 张"); !ok {
			t.Fatalf("width=%d missing accessible reset-card label", width)
		}
	}
}
