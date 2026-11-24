package quota

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unicode"
)

// nativeCredential is the minimal material needed for one quota request
// and optional OAuth refresh.
type nativeCredential struct {
	token        string
	refreshToken string
	accountID    string   // codex only
	scopes       []string // claude only
	expiresAt    int64    // unix milliseconds; 0 when unknown
	orgID        string   // OpenCode Console only
	console      bool     // OpenCode Console rather than a Go API key
}

func (c *nativeCredential) isExpired(now time.Time) bool {
	return c != nil && c.expiresAt > 0 && c.expiresAt <= now.UnixMilli()
}

// readCredentialObject reads a small JSON object without following a symlink.
// The file must be a regular file no larger than 256 KiB.
func readCredentialObject(path string) (map[string]any, error) {
	info, err := os.Lstat(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, unauthenticated("未找到原生登录凭据")
		}
		return nil, unsupported("无法安全读取原生认证文件")
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return nil, unsupported("认证文件类型或大小不受支持")
	}
	if info.Size() > maxCredentialBytes {
		return nil, unsupported("认证文件超过大小限制")
	}
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, unauthenticated("未找到原生登录凭据")
		}
		return nil, unsupported("无法安全读取原生认证文件")
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !opened.Mode().IsRegular() {
		return nil, unsupported("无法安全读取原生认证文件")
	}
	if opened.Size() > maxCredentialBytes {
		return nil, unsupported("认证文件超过大小限制")
	}
	body, err := io.ReadAll(io.LimitReader(file, maxCredentialBytes+1))
	if err != nil {
		return nil, unsupported("无法安全读取原生认证文件")
	}
	if len(body) > maxCredentialBytes {
		return nil, unsupported("认证文件超过大小限制")
	}
	var parsed any
	if json.Unmarshal(body, &parsed) != nil {
		return nil, unsupported("认证文件格式不受支持")
	}
	root, ok := object(parsed)
	if !ok {
		return nil, unsupported("认证文件格式不受支持")
	}
	return root, nil
}

func credentialPath(authDir, name string) (string, error) {
	if authDir == "" || !filepath.IsAbs(authDir) {
		return "", unsupported("认证目录无效")
	}
	return filepath.Join(authDir, name), nil
}

func readCodexCredentialRaw(authDir string) (*nativeCredential, map[string]any, string, error) {
	path, err := credentialPath(authDir, "auth.json")
	if err != nil {
		return nil, nil, "", err
	}
	root, err := readCredentialObject(path)
	if err != nil {
		return nil, nil, "", err
	}
	if mode, present := root["auth_mode"]; present {
		if value, _ := mode.(string); value != "chatgpt" {
			return nil, nil, "", unsupported("仅支持 Codex 原生 ChatGPT 登录")
		}
	} else {
		for _, key := range []string{"OPENAI_API_KEY", "personal_access_token", "agent_identity", "bedrock_api_key", "bedrock_access_keys"} {
			if value, present := root[key]; present && notEmptyish(value) {
				return nil, nil, "", unsupported("Codex 当前认证模式不明确")
			}
		}
	}
	tokens, _ := object(root["tokens"])
	token := nonempty(tokens["access_token"], 16384)
	accountID := nonempty(tokens["account_id"], 256)
	if token == "" || accountID == "" {
		return nil, nil, "", unsupported("缺少完整的 Codex ChatGPT 登录凭据")
	}
	expires := jwtExpiryMillis(token)
	if expires == 0 {
		return nil, nil, "", unsupported("无法确认 Codex 原生登录有效期")
	}
	cred := &nativeCredential{
		token:        token,
		refreshToken: nonempty(tokens["refresh_token"], 16384),
		accountID:    accountID,
		expiresAt:    expires,
	}
	return cred, root, path, nil
}

func readClaudeCredentialRaw(authDir string) (*nativeCredential, map[string]any, string, error) {
	path, err := credentialPath(authDir, ".credentials.json")
	if err != nil {
		return nil, nil, "", err
	}
	root, err := readCredentialObject(path)
	if err != nil {
		return nil, nil, "", err
	}
	oauth, _ := object(root["claudeAiOauth"])
	token := nonempty(oauth["accessToken"], 16384)
	if token == "" {
		return nil, nil, "", unauthenticated("缺少 Claude Code 原生登录凭据")
	}
	var expiresAt int64
	if raw, present := oauth["expiresAt"]; present {
		expires, ok := toFloat(raw)
		if !ok || math.IsNaN(expires) || math.IsInf(expires, 0) || expires <= 0 {
			return nil, nil, "", unsupported("无法确认 Claude Code 登录有效期")
		}
		expiresAt = int64(expires)
	}
	var scopes []string
	if rawScopes, ok := oauth["scopes"].([]any); ok {
		for _, item := range rawScopes {
			if s := nonempty(item, 256); s != "" {
				scopes = append(scopes, s)
			}
		}
	}
	cred := &nativeCredential{
		token:        token,
		refreshToken: nonempty(oauth["refreshToken"], 16384),
		scopes:       scopes,
		expiresAt:    expiresAt,
	}
	return cred, root, path, nil
}

func readAgyCredentialRaw(authDir string) (*nativeCredential, map[string]any, string, error) {
	path, err := credentialPath(authDir, filepath.Join(".gemini", "antigravity-cli", "antigravity-oauth-token"))
	if err != nil {
		return nil, nil, "", err
	}
	root, err := readCredentialObject(path)
	if err != nil {
		return nil, nil, "", err
	}
	tok, _ := object(root["token"])
	token := nonempty(tok["access_token"], 16384)
	if token == "" {
		return nil, nil, "", unauthenticated("缺少 Antigravity 原生登录凭据")
	}
	var expiresAt int64
	if raw, present := tok["expiry"]; present {
		if exp := parseProviderTimestamp(raw); exp > 0 {
			expiresAt = exp
		}
	}
	cred := &nativeCredential{
		token:        token,
		refreshToken: nonempty(tok["refresh_token"], 16384),
		expiresAt:    expiresAt,
	}
	return cred, root, path, nil
}

// readOpenCodeCredential follows the native login priority: an active Console
// session in opencode.db wins; otherwise the Go key stored in the credential
// table or data/opencode/auth.json is used. A present-but-unusable Console
// state never falls back to another account's key.
func readOpenCodeCredential(ctx context.Context, authDir string, now time.Time) (*nativeCredential, error) {
	if authDir == "" || !filepath.IsAbs(authDir) {
		return nil, unsupported("认证目录无效")
	}
	cred, err := readOpenCodeDatabase(ctx, filepath.Join(authDir, "opencode.db"), now)
	if err != nil {
		return nil, err
	}
	if cred != nil {
		return cred, nil
	}
	return readOpenCodeAuthFile(filepath.Join(authDir, "data", "opencode", "auth.json"))
}

func readOpenCodeAuthFile(path string) (*nativeCredential, error) {
	const noSubscription = "尚未连接 OpenCode Go 订阅，无 Go 套餐额度可读；免费模型与按量余额没有官方只读额度接口"
	root, err := readCredentialObject(path)
	if err != nil {
		var quotaErr *Error
		if errors.As(err, &quotaErr) && quotaErr.Kind == kindUnauthenticated {
			return nil, unsupported(noSubscription)
		}
		return nil, err
	}
	providerID := ""
	if _, ok := object(root["opencode-go"]); ok {
		providerID = "opencode-go"
	} else if _, ok := object(root["opencode"]); ok {
		providerID = "opencode"
	}
	if providerID == "" {
		return nil, unsupported(noSubscription)
	}
	entry, _ := object(root[providerID])
	if value, _ := entry["type"].(string); value != "api" {
		return nil, unsupported("OpenCode 当前登录方式没有 Go 套餐额度可读；连接 OpenCode Go 订阅后可查看套餐窗口")
	}
	token := nonempty(entry["key"], 16384)
	if token == "" {
		return nil, unsupported("OpenCode Go API key 缺失或不可用，无法读取 Go 套餐额度")
	}
	return &nativeCredential{token: token}, nil
}

func nonempty(value any, max int) string {
	text, ok := value.(string)
	if !ok || text == "" || len(text) > max {
		return ""
	}
	for _, r := range text {
		if r <= 0x1f || r == 0x7f || isSpace(r) {
			return ""
		}
	}
	return text
}

func nonemptyID(value any) string {
	text, ok := value.(string)
	if !ok {
		return ""
	}
	text = strings.TrimSpace(text)
	if text == "" || len(text) > 256 {
		return ""
	}
	for _, r := range text {
		if r <= 0x1f || r == 0x7f || isSpace(r) {
			return ""
		}
	}
	return text
}

func notEmptyish(value any) bool {
	if value == nil {
		return false
	}
	if text, ok := value.(string); ok {
		return text != ""
	}
	return true
}

func isSpace(r rune) bool { return unicode.IsSpace(r) }

func jwtExpiryMillis(token string) int64 {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return 0
	}
	for _, part := range parts {
		if part == "" {
			return 0
		}
		for _, r := range part {
			if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' || r == '-') {
				return 0
			}
		}
	}
	body, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return 0
	}
	var claims map[string]any
	if json.Unmarshal(body, &claims) != nil {
		return 0
	}
	expires, ok := claims["exp"].(float64)
	if !ok || expires <= 0 || expires != math.Trunc(expires) || expires > 8640000000000 {
		return 0
	}
	return int64(expires) * 1000
}

// expiryMillis accepts the millisecond and legacy second encodings used by
// OpenCode installations. It reports whether a usable expiry was present.
func expiryMillis(value any) (int64, bool) {
	number, ok := toFloat(value)
	if !ok || number <= 0 || number != math.Trunc(number) || number > 9007199254740991 {
		return 0, false
	}
	if number >= 1_000_000_000_000 {
		if number > 8_640_000_000_000_000 {
			return 0, false
		}
		return int64(number), true
	}
	if number >= 1_000_000_000 {
		return int64(number) * 1000, true
	}
	return 0, false
}

func toFloat(value any) (float64, bool) {
	switch v := value.(type) {
	case float64:
		return v, true
	case float32:
		return float64(v), true
	case int:
		return float64(v), true
	case int64:
		return float64(v), true
	case json.Number:
		f, err := v.Float64()
		return f, err == nil
	default:
		return 0, false
	}
}
