package engine

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// launchCtx carries one attempt's command line while it is being built.
type launchCtx struct {
	run   Run
	env   map[string]string // variables added on top of the cleaned service environment
	extra []string          // account-specific arguments
	stdin bool              // the prompt is delivered on stdin (otherwise the engine reads promptPath)
}

func (c *launchCtx) promptPath() string { return filepath.Join(c.run.RunDir, "prompt.txt") }

// put writes a private file into the run directory.
func (c *launchCtx) put(name, body string) (string, error) {
	path := filepath.Join(c.run.RunDir, name)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return "", err
	}
	return path, os.WriteFile(path, []byte(body), 0o600)
}

func (c *launchCtx) privateDir(name string) (string, error) {
	path := filepath.Join(c.run.RunDir, name)
	return path, os.MkdirAll(path, 0o700)
}

type spec struct {
	bin string
	// standby: the CLI can be started ahead of its prompt and fed JSON messages on stdin.
	standby bool
	// argv builds the cold-start command after prepare has filled c.extra.
	argv func(c *launchCtx) ([]string, error)
	// prepare sets the account environment and writes private config files.
	prepare func(c *launchCtx) error
	// ready checks the local credential material.
	ready func(a Account) (bool, string)
	// login is the native sign-in command, run in the account's environment.
	login func(a Account) ([]string, map[string]string)
}

var specs = map[string]*spec{
	"claude": {
		bin: "claude", standby: true,
		argv: func(c *launchCtx) ([]string, error) {
			argv := []string{"claude", "-p", "--output-format", "stream-json", "--verbose", "--model", c.run.Model}
			if c.run.Effort != "" {
				argv = append(argv, "--effort", c.run.Effort)
			}
			argv = append(argv, "--permission-mode", "bypassPermissions", "--setting-sources", "", "--strict-mcp-config", "--no-session-persistence")
			return append(argv, c.extra...), nil
		},
		prepare: func(c *launchCtx) error {
			a := c.run.Account
			settings := map[string]any{}
			if a.Config != "" {
				if err := json.Unmarshal([]byte(a.Config), &settings); err != nil {
					return errors.New("账号的原生 JSON 配置无法解析")
				}
			}
			if a.Kind == "subscription" {
				c.env["CLAUDE_CONFIG_DIR"] = a.AuthDir
			} else {
				home, err := c.privateDir("claude-home")
				if err != nil {
					return err
				}
				c.env["CLAUDE_CONFIG_DIR"] = home
				env, _ := settings["env"].(map[string]any)
				if env == nil {
					env = map[string]any{}
				}
				if a.APIKey != "" {
					env["ANTHROPIC_API_KEY"] = a.APIKey
				}
				if a.BaseURL != "" {
					env["ANTHROPIC_BASE_URL"] = a.BaseURL
				}
				settings["env"] = env
			}
			body, _ := json.Marshal(settings)
			path, err := c.put("claude-settings.json", string(body))
			c.extra = append(c.extra, "--settings", path)
			return err
		},
		ready: func(a Account) (bool, string) {
			if a.Kind == "api" {
				return apiReady(a)
			}
			var v struct {
				OAuth struct {
					AccessToken  string `json:"accessToken"`
					RefreshToken string `json:"refreshToken"`
					ExpiresAt    int64  `json:"expiresAt"`
				} `json:"claudeAiOauth"`
			}
			if why := readAuthJSON(a.AuthDir, ".credentials.json", &v); why != "" {
				return false, why
			}
			if v.OAuth.AccessToken == "" {
				return false, "没有登录凭据，请重新登录"
			}
			if v.OAuth.ExpiresAt != 0 && v.OAuth.ExpiresAt <= time.Now().UnixMilli() && v.OAuth.RefreshToken == "" {
				return false, "登录已过期，请重新登录"
			}
			return true, ""
		},
		login: func(a Account) ([]string, map[string]string) {
			return []string{"claude", "auth", "login"}, map[string]string{"CLAUDE_CONFIG_DIR": a.AuthDir}
		},
	},
	"codex": {
		bin: "codex",
		argv: func(c *launchCtx) ([]string, error) {
			argv := []string{"codex", "exec", "--json", "--ephemeral", "--skip-git-repo-check", "--sandbox", "danger-full-access", "--cd", c.run.Workspace, "--model", c.run.Model}
			if c.run.Effort != "" {
				argv = append(argv, "-c", `model_reasoning_effort="`+c.run.Effort+`"`)
			}
			argv = append(argv, c.extra...)
			return append(argv, "-"), nil
		},
		prepare: func(c *launchCtx) error {
			a := c.run.Account
			if a.Kind == "subscription" {
				c.env["CODEX_HOME"] = a.AuthDir
				// Pin the account to its own file credentials: no keyring, no API key fallback.
				c.extra = append(c.extra, "-c", `model_provider="openai"`, "-c", `cli_auth_credentials_store="file"`, "-c", `forced_login_method="chatgpt"`)
				return nil
			}
			if a.Config != "" {
				return errors.New("Codex API 账号暂不支持附带原生 TOML 配置")
			}
			if a.Protocol != "" && a.Protocol != "openai-responses" {
				return errors.New("Codex API 账号需要 OpenAI Responses 协议")
			}
			home, err := c.privateDir("codex-home")
			if err != nil {
				return err
			}
			c.env["CODEX_HOME"] = home
			provider := a.Provider
			if provider == "" {
				provider = "weaver"
			}
			base := a.BaseURL
			if base == "" {
				base = "https://api.openai.com/v1"
			}
			config := fmt.Sprintf("model_provider = %s\nmodel = %s\n\n[model_providers.%s]\nname = %s\nbase_url = %s\nwire_api = \"responses\"\nrequires_openai_auth = false\nexperimental_bearer_token = %s\n",
				tomlString(provider), tomlString(c.run.Model), tomlString(provider), tomlString(provider), tomlString(base), tomlString(a.APIKey))
			if _, err := c.put("codex-home/config.toml", config); err != nil {
				return err
			}
			_, err = c.put("codex-home/auth.json", "{}")
			return err
		},
		ready: func(a Account) (bool, string) {
			if a.Kind == "api" {
				return apiReady(a)
			}
			var v struct {
				AuthMode string `json:"auth_mode"`
				APIKey   string `json:"OPENAI_API_KEY"`
				Tokens   struct {
					AccessToken  string `json:"access_token"`
					RefreshToken string `json:"refresh_token"`
				} `json:"tokens"`
			}
			if why := readAuthJSON(a.AuthDir, "auth.json", &v); why != "" {
				return false, why
			}
			if v.Tokens.AccessToken == "" || (v.AuthMode != "" && v.AuthMode != "chatgpt") || v.APIKey != "" {
				return false, "不是 ChatGPT 订阅登录，请重新登录"
			}
			if exp := jwtExpiry(v.Tokens.AccessToken); exp != 0 && exp <= time.Now().Unix() && v.Tokens.RefreshToken == "" {
				return false, "登录已过期，请重新登录"
			}
			return true, ""
		},
		login: func(a Account) ([]string, map[string]string) {
			return []string{"codex", "-c", `cli_auth_credentials_store="file"`, "login"}, map[string]string{"CODEX_HOME": a.AuthDir}
		},
	},
	"opencode": {
		bin: "opencode",
		argv: func(c *launchCtx) ([]string, error) {
			model := c.run.Model
			if c.run.Effort != "" {
				model += "#" + c.run.Effort
			}
			return []string{"opencode", "run", "--format", "json", "--model", model, "--auto", "--standalone"}, nil
		},
		prepare: func(c *launchCtx) error {
			dir, err := c.privateDir("opencode")
			if err != nil {
				return err
			}
			env, err := opencodeEnv(c.run.Account, c.run.Model, dir)
			for key, value := range env {
				c.env[key] = value
			}
			return err
		},
		ready: func(a Account) (bool, string) {
			if a.Kind == "api" {
				return apiReady(a)
			}
			info, err := os.Lstat(filepath.Join(a.AuthDir, "opencode.db"))
			if err != nil || !info.Mode().IsRegular() || info.Size() == 0 {
				return false, "认证目录里没有 opencode 的账号数据库，请重新登录"
			}
			return true, ""
		},
		login: func(a Account) ([]string, map[string]string) {
			env, _ := opencodeAccountEnv(a.AuthDir)
			return []string{"opencode", "auth", "login"}, env
		},
	},
	"dsh": {bin: "dsh", argv: dshArgv, prepare: dshPrepare, ready: apiReady},
}

func oneOf(value string, allowed ...string) bool {
	for _, a := range allowed {
		if value == a {
			return true
		}
	}
	return false
}

func tomlString(s string) string { return strconv.Quote(s) }

func apiReady(a Account) (bool, string) {
	if a.Kind != "api" {
		return false, "这个引擎只支持 API 账号"
	}
	if a.APIKey == "" && a.Config == "" {
		return false, "没有配置密钥"
	}
	return true, ""
}

// readAuthJSON loads a credential file from an account directory. It returns a reason when the file is unusable.
func readAuthJSON(dir, name string, into any) string {
	if dir == "" || !filepath.IsAbs(dir) {
		return "没有认证目录"
	}
	info, err := os.Lstat(dir)
	if err != nil || !info.IsDir() {
		return "认证目录不存在：" + dir
	}
	body, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil {
		return "没有登录凭据，请重新登录"
	}
	if json.Unmarshal(body, into) != nil {
		return "登录凭据文件损坏，请重新登录"
	}
	return ""
}

// jwtExpiry returns the exp claim of a JWT in Unix seconds, or 0 when it has none.
func jwtExpiry(token string) int64 {
	parts := strings.Split(token, ".")
	if len(parts) < 2 {
		return 0
	}
	body, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return 0
	}
	var claims struct {
		Exp float64 `json:"exp"`
	}
	if json.Unmarshal(body, &claims) != nil {
		return 0
	}
	return int64(claims.Exp)
}

// opencodeAccountEnv points opencode at an account's own config, data and database.
func opencodeAccountEnv(root string) (map[string]string, error) {
	env := map[string]string{"OPENCODE_DB": filepath.Join(root, "opencode.db"), "OPENCODE_DISABLE_PROJECT_CONFIG": "1"}
	for key, dir := range map[string]string{"XDG_CONFIG_HOME": "config", "XDG_DATA_HOME": "data", "XDG_STATE_HOME": "state", "XDG_CACHE_HOME": "cache"} {
		env[key] = filepath.Join(root, dir)
		if err := os.MkdirAll(env[key], 0o700); err != nil {
			return nil, err
		}
	}
	return env, nil
}

// opencodeEnv builds the environment for a cold run or a resident server.
// dir is a private directory that receives the generated opencode.json.
func opencodeEnv(a Account, model, dir string) (map[string]string, error) {
	config := map[string]any{}
	if a.Config != "" {
		if err := json.Unmarshal([]byte(a.Config), &config); err != nil {
			return nil, errors.New("账号的原生 JSON 配置无法解析")
		}
	}
	root := a.AuthDir
	if a.Kind == "api" {
		root = filepath.Join(dir, "home")
		if err := os.MkdirAll(root, 0o700); err != nil {
			return nil, err
		}
		provider := a.Provider
		if provider == "" {
			provider = strings.SplitN(model, "/", 2)[0]
		}
		config["enabled_providers"] = []string{provider}
		if a.APIKey != "" {
			npm := "@ai-sdk/openai-compatible"
			switch a.Protocol {
			case "anthropic":
				npm = "@ai-sdk/anthropic"
			case "openai-responses":
				npm = "@ai-sdk/openai"
			}
			options := map[string]any{"apiKey": a.APIKey}
			if a.BaseURL != "" {
				options["baseURL"] = a.BaseURL
			}
			name := strings.TrimPrefix(model, provider+"/")
			config["provider"] = map[string]any{provider: map[string]any{"npm": npm, "options": options, "models": map[string]any{name: map[string]any{"name": name}}}}
		}
	} else if root == "" {
		return nil, errors.New("账号没有认证目录")
	}
	env, err := opencodeAccountEnv(root)
	if err != nil {
		return nil, err
	}
	if a.Kind == "api" {
		env["OPENCODE_AUTH_CONTENT"] = "{}"
	}
	body, _ := json.Marshal(config)
	// opencode expands {env:...} and {file:...} in its config; keep account values literal.
	text := strings.NewReplacer("{env:", `{env:`, "{file:", `{file:`).Replace(string(body))
	path := filepath.Join(dir, "opencode.json")
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
		return nil, err
	}
	env["OPENCODE_CONFIG_DIR"] = dir
	env["OPENCODE_CONFIG"] = path
	return env, nil
}

// CheckAccount reports whether an account can be launched right now:
// its engine binary is installed and its credential material is present.
func CheckAccount(a Account) (bool, string) {
	s := specs[a.Engine]
	if s == nil {
		return false, "不支持的引擎 " + a.Engine
	}
	if _, err := exec.LookPath(s.bin); err != nil {
		return false, "本机没有安装 " + s.bin
	}
	return s.ready(a)
}

// LoginCommand returns the engine's native sign-in command and the variables
// that point it at the account's own credential directory.
func LoginCommand(a Account) ([]string, map[string]string, error) {
	s := specs[a.Engine]
	if s == nil || s.login == nil || a.Kind != "subscription" {
		return nil, nil, fmt.Errorf("引擎 %s 的这类账号没有登录流程；API 账号请直接设置密钥", a.Engine)
	}
	if a.AuthDir == "" {
		return nil, nil, errors.New("账号没有认证目录")
	}
	argv, env := s.login(a)
	return argv, env, nil
}

// credentialVariables are stripped from the service environment before a
// launch, so one account's keys can never leak into another account's run.
var credentialPrefixes = []string{"ANTHROPIC_", "OPENAI_", "AZURE_OPENAI_", "XAI_", "GROK_", "CODEX_", "CLAUDE_", "QODER_", "OPENCODE_", "DSH_", "DEEPSEEK_"}
var credentialSuffixes = []string{"API_KEY", "APIKEY", "ACCESS_TOKEN", "REFRESH_TOKEN", "AUTH_TOKEN", "BEARER_TOKEN", "CLIENT_SECRET"}
var credentialNames = []string{"PI_CODING_AGENT_DIR", "GOOGLE_API_KEY", "GEMINI_API_KEY", "WEAVER_CHANNEL_KEY", "ELECTRON_RUN_AS_NODE"}

func isCredentialVariable(name string) bool {
	for _, p := range credentialPrefixes {
		if strings.HasPrefix(name, p) {
			return true
		}
	}
	for _, s := range credentialSuffixes {
		if strings.HasSuffix(name, s) {
			return true
		}
	}
	return oneOf(name, credentialNames...)
}

// CleanEnv returns the service environment without credential variables, plus the given additions.
func CleanEnv(extra map[string]string) []string {
	var out []string
	for _, kv := range os.Environ() {
		name, _, _ := strings.Cut(kv, "=")
		if isCredentialVariable(name) {
			continue
		}
		if _, overridden := extra[name]; overridden {
			continue
		}
		out = append(out, kv)
	}
	for key, value := range extra {
		out = append(out, key+"="+value)
	}
	return out
}
