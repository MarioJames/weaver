package quota

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"math"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	defaultCodexTokenURL  = "https://auth.openai.com/oauth/token"
	defaultClaudeTokenURL = "https://platform.claude.com/v1/oauth/token"
	codexOAuthClientID    = "app_EMoamEEZ73f0CkXaXp7hrann"
	claudeOAuthClientID   = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
	defaultRefreshAhead   = 15 * time.Minute
)

var authDirLocks = struct {
	mu sync.Mutex
	m  map[string]*sync.Mutex
}{m: map[string]*sync.Mutex{}}

// lockAuthDir serializes credential refreshes for the same directory across all
// Clients in this process so rotating refresh tokens are never spent twice.
func lockAuthDir(dir string) func() {
	key := filepath.Clean(dir)
	authDirLocks.mu.Lock()
	m := authDirLocks.m[key]
	if m == nil {
		m = &sync.Mutex{}
		authDirLocks.m[key] = m
	}
	authDirLocks.mu.Unlock()
	m.Lock()
	return m.Unlock
}

func (c *Client) codexTokenURL() string {
	if c != nil && c.CodexTokenURL != "" {
		return c.CodexTokenURL
	}
	return defaultCodexTokenURL
}

func (c *Client) claudeTokenURL() string {
	if c != nil && c.ClaudeTokenURL != "" {
		return c.ClaudeTokenURL
	}
	return defaultClaudeTokenURL
}

func (c *Client) refreshAhead() time.Duration {
	if c != nil && c.RefreshAhead > 0 {
		return c.RefreshAhead
	}
	return defaultRefreshAhead
}

func (c *Client) shouldRefresh(cred *nativeCredential, now time.Time) (expired, expiringSoon bool) {
	if cred == nil || cred.expiresAt <= 0 {
		return false, false
	}
	nowMs := now.UnixMilli()
	expired = cred.expiresAt <= nowMs
	expiringSoon = cred.expiresAt <= now.Add(c.refreshAhead()).UnixMilli()
	return expired, expiringSoon
}

// refreshCodex renews an expiring, expired, or rejected Codex ChatGPT OAuth
// token and atomically persists the updated auth.json in authDir.
// If rejectedToken is non-empty (401 retry path), refresh proceeds even when
// the local JWT expiry is in the future unless another goroutine already wrote
// a different access token.
func (c *Client) refreshCodex(ctx context.Context, authDir, rejectedToken string, now time.Time) (*nativeCredential, error) {
	unlock := lockAuthDir(authDir)
	defer unlock()

	cred, root, path, err := readCodexCredentialRaw(authDir)
	if err != nil {
		return nil, err
	}
	// Re-check under the lock: another caller or a just-finished CLI may have
	// already written a fresh token.
	if rejectedToken != "" {
		if cred.token != rejectedToken && !cred.isExpired(now) {
			return cred, nil
		}
	} else if _, expiringSoon := c.shouldRefresh(cred, now); !expiringSoon {
		return cred, nil
	}
	if cred.refreshToken == "" {
		return nil, unauthenticated("原生登录已过期，请在对应工具中重新登录")
	}

	form := url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {cred.refreshToken},
		"client_id":     {codexOAuthClientID},
		"scope":         {"openid profile email"},
	}
	payload, err := c.postToken(ctx, c.codexTokenURL(), "application/x-www-form-urlencoded", "codex-cli", []byte(form.Encode()))
	if err != nil {
		return nil, err
	}

	newAccess := nonempty(payload["access_token"], 16384)
	if newAccess == "" {
		return nil, upstream("自动续期返回的访问令牌无效")
	}
	newExpiry := jwtExpiryMillis(newAccess)
	if newExpiry == 0 || newExpiry <= now.UnixMilli() {
		return nil, upstream("自动续期返回的访问令牌有效期无效")
	}
	newRefresh := nonempty(payload["refresh_token"], 16384)
	newIDToken := nonempty(payload["id_token"], 16384)

	tokens, ok := object(root["tokens"])
	if !ok {
		return nil, unsupported("认证文件格式不受支持")
	}
	tokens["access_token"] = newAccess
	if newRefresh != "" {
		tokens["refresh_token"] = newRefresh
	}
	if newIDToken != "" {
		tokens["id_token"] = newIDToken
	}
	root["tokens"] = tokens
	root["last_refresh"] = now.UTC().Format(time.RFC3339Nano)

	if err := writeCredentialObject(path, root); err != nil {
		return nil, err
	}
	updated := *cred
	updated.token = newAccess
	updated.expiresAt = newExpiry
	if newRefresh != "" {
		updated.refreshToken = newRefresh
	}
	return &updated, nil
}

// refreshClaude renews an expiring, expired, or rejected Claude Code OAuth
// token and atomically persists the updated .credentials.json in authDir.
func (c *Client) refreshClaude(ctx context.Context, authDir, rejectedToken string, now time.Time) (*nativeCredential, error) {
	unlock := lockAuthDir(authDir)
	defer unlock()

	cred, root, path, err := readClaudeCredentialRaw(authDir)
	if err != nil {
		return nil, err
	}
	if rejectedToken != "" {
		if cred.token != rejectedToken && !cred.isExpired(now) {
			return cred, nil
		}
	} else if _, expiringSoon := c.shouldRefresh(cred, now); !expiringSoon {
		return cred, nil
	}
	if cred.refreshToken == "" {
		return nil, unauthenticated("原生登录已过期，请在对应工具中重新登录")
	}

	bodyMap := map[string]any{
		"grant_type":    "refresh_token",
		"refresh_token": cred.refreshToken,
		"client_id":     claudeOAuthClientID,
	}
	if len(cred.scopes) > 0 {
		bodyMap["scope"] = strings.Join(cred.scopes, " ")
	}
	bodyBytes, err := json.Marshal(bodyMap)
	if err != nil {
		return nil, upstream("无法构造自动续期请求")
	}
	payload, err := c.postToken(ctx, c.claudeTokenURL(), "application/json", quotaUserAgent, bodyBytes)
	if err != nil {
		return nil, err
	}

	newAccess := nonempty(payload["access_token"], 16384)
	if newAccess == "" {
		return nil, upstream("自动续期返回的访问令牌无效")
	}
	expiresIn, ok := toFloat(payload["expires_in"])
	if !ok || math.IsNaN(expiresIn) || math.IsInf(expiresIn, 0) || expiresIn <= 0 || expiresIn > 86400*3650 {
		return nil, upstream("自动续期返回的访问令牌有效期无效")
	}
	newExpiresAt := now.UnixMilli() + int64(expiresIn*1000)
	newRefresh := nonempty(payload["refresh_token"], 16384)

	oauth, ok := object(root["claudeAiOauth"])
	if !ok {
		return nil, unsupported("认证文件格式不受支持")
	}
	oauth["accessToken"] = newAccess
	oauth["expiresAt"] = newExpiresAt
	if newRefresh != "" {
		oauth["refreshToken"] = newRefresh
	}
	if rawRefreshExp, present := payload["refresh_token_expires_in"]; present {
		if refreshExp, ok := toFloat(rawRefreshExp); ok && !math.IsNaN(refreshExp) && !math.IsInf(refreshExp, 0) && refreshExp > 0 && refreshExp <= 86400*3650 {
			oauth["refreshTokenExpiresAt"] = now.UnixMilli() + int64(refreshExp*1000)
		}
	}
	var newScopes []string
	if rawScope, ok := payload["scope"].(string); ok {
		if fields := strings.Fields(rawScope); len(fields) > 0 {
			oauth["scopes"] = fields
			newScopes = fields
		}
	}
	root["claudeAiOauth"] = oauth

	if err := writeCredentialObject(path, root); err != nil {
		return nil, err
	}
	updated := *cred
	updated.token = newAccess
	updated.expiresAt = newExpiresAt
	if newRefresh != "" {
		updated.refreshToken = newRefresh
	}
	if len(newScopes) > 0 {
		updated.scopes = newScopes
	}
	return &updated, nil
}

// postToken sends one OAuth refresh_token POST without automatic retries
// (rotating refresh tokens are not idempotent) and never leaks bodies/secrets.
func (c *Client) postToken(ctx context.Context, endpointURL, contentType, userAgent string, body []byte) (map[string]any, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpointURL, bytes.NewReader(body))
	if err != nil {
		return nil, upstream("自动续期接口地址无效")
	}
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", userAgent)

	resp, err := c.httpClient().Do(req)
	if err != nil {
		switch {
		case errors.Is(err, context.DeadlineExceeded), ctx.Err() == context.DeadlineExceeded:
			return nil, transient("自动续期请求超时")
		case errors.Is(err, context.Canceled), ctx.Err() == context.Canceled:
			return nil, transient("额度请求已取消")
		default:
			return nil, transient("自动续期请求失败，请稍后重试")
		}
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		switch {
		case resp.StatusCode == http.StatusTooManyRequests:
			return nil, transient("自动续期接口限流，请稍后重试")
		case resp.StatusCode >= 500:
			return nil, transient("自动续期服务暂时不可用，请稍后重试")
		case resp.StatusCode == http.StatusBadRequest || resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden:
			return nil, unauthenticated("登录已失效，自动续期失败，请重新登录")
		default:
			return nil, upstream("自动续期服务返回异常，请稍后重试")
		}
	}

	raw, err := readLimited(resp.Body)
	if err != nil {
		return nil, err
	}
	var parsed any
	if json.Unmarshal(raw, &parsed) != nil {
		return nil, upstream("自动续期接口返回了无效 JSON")
	}
	obj, ok := object(parsed)
	if !ok {
		return nil, upstream("自动续期接口返回格式异常")
	}
	return obj, nil
}

// writeCredentialObject atomically replaces an existing regular credential file
// with mode 0600, refusing symlinks or non-regular targets.
func writeCredentialObject(path string, root map[string]any) error {
	info, err := os.Lstat(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return unauthenticated("未找到原生登录凭据")
		}
		return unsupported("无法安全写入原生认证文件")
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return unsupported("认证文件类型或大小不受支持")
	}
	encoded, err := json.MarshalIndent(root, "", "  ")
	if err != nil {
		return unsupported("无法序列化原生认证文件")
	}
	encoded = append(encoded, '\n')
	if len(encoded) > maxCredentialBytes {
		return unsupported("认证文件超过大小限制")
	}

	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".weaver-cred-*.tmp")
	if err != nil {
		return unsupported("无法创建临时认证文件")
	}
	tmpPath := tmp.Name()
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(tmpPath)
		}
	}()
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return unsupported("无法设置认证文件权限")
	}
	if _, err := tmp.Write(encoded); err != nil {
		_ = tmp.Close()
		return unsupported("无法写入原生认证文件")
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return unsupported("无法落盘原生认证文件")
	}
	if err := tmp.Close(); err != nil {
		return unsupported("无法关闭临时认证文件")
	}
	if err := os.Rename(tmpPath, path); err != nil {
		return unsupported("无法替换原生认证文件")
	}
	cleanup = false
	return nil
}
