package kernel

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"strings"

	"github.com/MarioJames/weaver/internal/engine"
)

// AccountConfig returns a channel's stored native configuration as a JSON
// object for editing. Every apiKey field is removed at any depth, and the two
// secret values themselves never appear in the result.
func (k *Kernel) AccountConfig(id string) (*AccountConfigView, error) {
	view := &AccountConfigView{}
	err := k.read(func() error {
		var configText string
		err := k.db.QueryRow(`SELECT id, engine, kind, provider, protocol, base_url, api_key<>'', config, admin_key<>''
			FROM accounts WHERE id=?`, id).
			Scan(&view.ID, &view.Engine, &view.Kind, &view.Provider, &view.Protocol, &view.BaseURL,
				&view.HasAPIKey, &configText, &view.HasAdminKey)
		if err == sql.ErrNoRows {
			return errf("NOT_FOUND", "账号 %s 不存在", id)
		}
		if err != nil {
			return err
		}
		if strings.TrimSpace(configText) == "" {
			view.Config = nil
			return nil
		}
		var parsed any
		if err := json.Unmarshal([]byte(configText), &parsed); err != nil {
			return errf("INVALID", "账号 %s 的原生 JSON 配置无法解析", id)
		}
		scrubAPIKeys(parsed)
		view.Config = parsed
		return nil
	})
	if err != nil {
		return nil, err
	}
	return view, nil
}

// scrubAPIKeys removes keys named apiKey (case-insensitive) from every object
// in a decoded JSON document.
func scrubAPIKeys(v any) {
	switch value := v.(type) {
	case map[string]any:
		for key := range value {
			if strings.EqualFold(key, "apiKey") {
				delete(value, key)
				continue
			}
			scrubAPIKeys(value[key])
		}
	case []any:
		for _, item := range value {
			scrubAPIKeys(item)
		}
	}
}

// ModelFetchInput names either a stored account or a channel still being
// edited. Explicit fields win; a missing API key falls back to the stored one.
type ModelFetchInput struct {
	ID       string `json:"id,omitempty"`
	Engine   string `json:"engine,omitempty"`
	Provider string `json:"provider,omitempty"`
	Protocol string `json:"protocol,omitempty"`
	BaseURL  string `json:"baseUrl,omitempty"`
	APIKey   string `json:"apiKey,omitempty"`
}

// FetchModels asks a channel's models endpoint for its list. It only reads;
// nothing is stored.
func (k *Kernel) FetchModels(in ModelFetchInput) ([]ModelInfo, error) {
	var a engine.Account
	if in.ID != "" {
		var err error
		if a, err = k.EngineAccount(in.ID); err != nil {
			return nil, err
		}
	}
	if in.Engine != "" {
		a.Engine = in.Engine
	}
	if in.Provider != "" {
		a.Provider = in.Provider
	}
	if in.Protocol != "" {
		a.Protocol = in.Protocol
	}
	if in.BaseURL != "" {
		a.BaseURL = in.BaseURL
	}
	if in.APIKey != "" {
		a.APIKey = in.APIKey
	}
	if a.Engine == "" {
		return nil, errf("INVALID", "拉取模型需要账号或引擎")
	}
	if a.Engine == "dsh" && engine.DSHNative(a) {
		return nil, errf("INVALID", "DeepSeek 官方渠道的模型由 dsh 内置")
	}
	if a.APIKey == "" {
		return nil, errf("INVALID", "拉取模型需要 API 密钥")
	}
	protocol := modelsProtocol(a)
	base := modelsBaseURL(a)
	if base == "" {
		return nil, errf("INVALID", "拉取模型需要填写接口地址")
	}
	var endpoint string
	switch protocol {
	case "openai-completions", "openai-responses":
		endpoint = strings.TrimRight(base, "/") + "/models"
	case "anthropic-messages":
		base = strings.TrimSuffix(strings.TrimRight(base, "/"), "/v1")
		endpoint = base + "/v1/models?limit=1000"
	default:
		return nil, errf("INVALID", "不支持的协议 %q", protocol)
	}
	req, err := http.NewRequest(http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	switch protocol {
	case "anthropic-messages":
		req.Header.Set("x-api-key", a.APIKey)
		req.Header.Set("anthropic-version", "2023-06-01")
	default:
		req.Header.Set("Authorization", "Bearer "+a.APIKey)
	}
	status, body, err := apiGet(req, "模型")
	if err != nil {
		return nil, errf("INVALID", "拉取模型失败：%s", err.Error())
	}
	if status < 200 || status >= 300 {
		return nil, errf("INVALID", "拉取模型失败：%s", upstreamMessage(status, body))
	}
	var payload struct {
		Data []map[string]any `json:"data"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		var list []map[string]any
		if json.Unmarshal(body, &list) != nil {
			return nil, errf("INVALID", "模型接口返回的不是合法 JSON")
		}
		payload.Data = list
	}
	out := make([]ModelInfo, 0, len(payload.Data))
	for _, item := range payload.Data {
		id, _ := item["id"].(string)
		if id == "" {
			continue
		}
		name, _ := item["name"].(string)
		if name == "" {
			name, _ = item["display_name"].(string)
		}
		if name == "" {
			name = id
		}
		out = append(out, ModelInfo{
			ID:            id,
			Name:          name,
			ContextWindow: intField(item, "context_window", "context_length", "max_input_tokens", "input_token_limit"),
			MaxTokens:     intField(item, "max_tokens", "max_output_tokens", "output_token_limit"),
		})
	}
	return out, nil
}

func modelsProtocol(a engine.Account) string {
	if a.Protocol != "" {
		return a.Protocol
	}
	switch a.Engine {
	case "codex":
		return "openai-responses"
	case "claude":
		return "anthropic-messages"
	}
	return engine.DSHAPI(a)
}

func modelsBaseURL(a engine.Account) string {
	if base := accountBaseURL(a); base != "" {
		return base
	}
	if _, base, ok := engine.DSHEndpoint(a.Provider); ok {
		return base
	}
	switch a.Engine {
	case "codex":
		return "https://api.openai.com/v1"
	case "claude":
		return "https://api.anthropic.com"
	}
	return ""
}

func intField(m map[string]any, keys ...string) int {
	for _, key := range keys {
		switch value := m[key].(type) {
		case float64:
			if value > 0 {
				return int(value)
			}
		case json.Number:
			if n, err := value.Int64(); err == nil && n > 0 {
				return int(n)
			}
		case string:
			if n, err := strconv.Atoi(strings.TrimSpace(value)); err == nil && n > 0 {
				return n
			}
		}
	}
	return 0
}

var dshEfforts = []string{"off", "low", "high", "max"}

// validateDshEffort checks a candidate's effort against the model knowledge a
// dsh account carries. A model the account does not list is left to the
// runtime default and not checked.
func validateDshEffort(a engine.Account, model, effort string) error {
	if engine.DSHNative(a) {
		if effort == "" || oneOfString(effort, dshEfforts...) {
			return nil
		}
		return errf("INVALID", "模型 %s 的思考力度只有 %s", model, strings.Join(dshEfforts, "/"))
	}
	if a.Config == "" {
		return nil
	}
	var block struct {
		Models []map[string]any `json:"models"`
	}
	if json.Unmarshal([]byte(a.Config), &block) != nil {
		return nil
	}
	for _, m := range block.Models {
		id, _ := m["id"].(string)
		if id != model {
			continue
		}
		switch offered := m["reasoningEfforts"].(type) {
		case map[string]any:
			if len(offered) == 0 {
				return nil
			}
			if _, ok := offered[effort]; ok {
				return nil
			}
			names := make([]string, 0, len(offered))
			for name := range offered {
				names = append(names, name)
			}
			sort.Strings(names)
			return errf("INVALID", "模型 %s 的思考力度只有 %s", model, strings.Join(names, "/"))
		case bool:
			if !offered && effort != "" {
				return errf("INVALID", "模型 %s 不支持思考力度", model)
			}
		}
		return nil
	}
	return nil
}

func oneOfString(value string, allowed ...string) bool {
	for _, a := range allowed {
		if value == a {
			return true
		}
	}
	return false
}

func (k *Kernel) validateDshWorker(t *tx, id string) error {
	var model, effort string
	if err := t.QueryRow(`SELECT model, COALESCE(effort,'') FROM workers WHERE id=?`, id).Scan(&model, &effort); err != nil {
		return err
	}
	accounts, err := queryStrings(t, `SELECT account_id FROM worker_accounts WHERE worker_id=? ORDER BY position`, id)
	if err != nil {
		return err
	}
	for _, account := range accounts {
		a, err := accountSecrets(t, account)
		if err != nil {
			return err
		}
		if err := validateDshEffort(a, model, effort); err != nil {
			return err
		}
	}
	return nil
}
