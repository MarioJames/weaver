// Package quota reads subscription quota windows from the native credential
// stores of Codex, Claude Code and OpenCode. For Codex and Claude Code it can
// proactively renew expiring or expired OAuth access tokens inside the
// account's isolated AuthDir (skipped when SkipRefresh is set). OpenCode
// databases remain strictly read-only.
package quota

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
)

const (
	maxCredentialBytes  = 256 << 10
	maxResponseBytes    = 256 << 10
	defaultHTTPTimeout  = 15 * time.Second
	quotaUserAgent      = "Weaver"
	openCodeConsoleRoot = "https://opencode.ai/console"
)

// Default provider endpoints. They are constants so the zero Client works,
// while the exported Client fields let tests point at local servers.
const (
	defaultCodexURL             = "https://chatgpt.com/backend-api/wham/usage"
	defaultCodexResetCreditsURL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits"
	defaultClaudeURL            = "https://api.anthropic.com/api/oauth/usage"
	defaultOpenCodeGoURL        = "https://opencode.ai/zen/go/v1/usage"
	defaultOpenCodeConsoleURL   = openCodeConsoleRoot + "/api/go/status"
)

const (
	kindUnsupported      = "unsupported"
	kindUnauthenticated  = "unauthenticated"
	kindRenewalPending   = "renewal_pending"
	kindTransient        = "transient"
	kindUpstream         = "upstream"
	statusAvailable      = "available"
	statusExhausted      = "exhausted"
	statusUnknown        = "unknown"
	scopeAccount         = "account"
	scopeModel           = "model"
	scopeUnknown         = "unknown"
	universalQuotaDetail = "接口未提供足以确认账户可用性的完整额度信息"
)

// Window is one quota window reported by a subscription endpoint.
type Window struct {
	ID              string  `json:"id"`                        // 如 codex:account:primary_window、claude:weekly_all:0、opencode:weekly
	Label           string  `json:"label"`                     // 中文，如「5 小时额度」「7 天额度」「每月额度」
	Scope           string  `json:"scope"`                     // account | model | unknown
	Model           string  `json:"model,omitempty"`           // scope 为 model 时的模型名
	UsedPercent     float64 `json:"usedPercent"`               // 0–100
	ResetsAt        int64   `json:"resetsAt,omitempty"`        // Unix 毫秒，0 表示未知
	DurationMinutes int     `json:"durationMinutes,omitempty"` // 窗口长度，0 表示未知
}

// Credits describes a subscription account's overage credit balance (Codex).
type Credits struct {
	HasCredits          bool    `json:"hasCredits"`
	Unlimited           bool    `json:"unlimited,omitempty"`
	OverageLimitReached bool    `json:"overageLimitReached,omitempty"`
	Balance             float64 `json:"balance,omitempty"`
	HasBalance          bool    `json:"hasBalance,omitempty"`
}

// Usable reports whether the account has remaining overage credits that can
// serve requests when subscription rate-limit windows are exhausted.
func (c *Credits) Usable() bool {
	if c == nil || c.OverageLimitReached {
		return false
	}
	if c.Unlimited {
		return true
	}
	if !c.HasCredits {
		return false
	}
	if c.HasBalance {
		return c.Balance > 0
	}
	return true
}

// ResetCredits describes available rate-limit reset cards (Codex).
type ResetCredits struct {
	AvailableCount int   `json:"availableCount"`
	NextExpiresAt  int64 `json:"nextExpiresAt,omitempty"` // 最早一张可用重置卡到期时间，Unix 毫秒
}

// Snapshot is a normalized reading of one subscription account.
type Snapshot struct {
	Status       string        `json:"status"` // available | exhausted | unknown
	Windows      []Window      `json:"windows"`
	Credits      *Credits      `json:"credits,omitempty"`
	ResetCredits *ResetCredits `json:"resetCredits,omitempty"`
	Detail       string        `json:"detail,omitempty"` // 一句中文说明
}

// Source identifies one subscription account. AuthDir means CODEX_HOME for
// codex (auth.json below it), CLAUDE_CONFIG_DIR for claude
// (.credentials.json below it), and the account root for opencode
// (opencode.db below it plus data/opencode/auth.json).
// When SkipRefresh is true (for example, while an engine attempt is actively
// running on this account), Fetch will not refresh or modify credentials.
type Source struct {
	Engine      string
	AuthDir     string
	SkipRefresh bool
}

// Error is a quota failure. Kind is one of unsupported, unauthenticated,
// renewal_pending, transient or upstream. Message is user-facing Chinese and
// never contains a token, key, e-mail address, organization id or response body.
type Error struct {
	Kind, Message string
	status        int
}

// Error implements error.
func (e *Error) Error() string {
	if e == nil {
		return ""
	}
	return e.Message
}

func quotaError(kind, message string) *Error {
	return &Error{Kind: kind, Message: message}
}

func unsupported(message string) *Error { return quotaError(kindUnsupported, message) }
func unauthenticated(message string) *Error {
	return quotaError(kindUnauthenticated, message)
}
func renewalPending() *Error {
	return quotaError(kindRenewalPending, "原生访问令牌已到期，等待原生 CLI 续期后再读取")
}
func transient(message string) *Error { return quotaError(kindTransient, message) }
func upstream(message string) *Error  { return quotaError(kindUpstream, message) }

// Client fetches quota snapshots. The zero value is ready to use with a
// 15-second timeout and the official provider endpoints.
type Client struct {
	HTTP                 *http.Client
	CodexURL             string        // 默认 https://chatgpt.com/backend-api/wham/usage
	CodexResetCreditsURL string        // 默认 https://chatgpt.com/backend-api/wham/rate-limit-reset-credits
	CodexTokenURL        string        // 默认 https://auth.openai.com/oauth/token
	ClaudeURL            string        // 默认 https://api.anthropic.com/api/oauth/usage
	ClaudeTokenURL       string        // 默认 https://platform.claude.com/v1/oauth/token
	OpenCodeGoURL        string        // 默认 https://opencode.ai/zen/go/v1/usage
	OpenCodeConsoleURL   string        // 默认 https://opencode.ai/console/api/go/status
	RefreshAhead         time.Duration // 默认 15 分钟；<=0 使用默认值
}

type endpoint int

const (
	endpointCodex endpoint = iota
	endpointClaude
	endpointOpenCodeGo
	endpointOpenCodeConsole
)

// Fetch reads the account credential, proactively renews expiring/expired OAuth
// tokens for Codex and Claude when allowed, and probes the subscription endpoint.
func (c *Client) Fetch(ctx context.Context, src Source, now time.Time) (*Snapshot, error) {
	switch src.Engine {
	case "codex":
		cred, refreshed, err := c.prepareCredential(ctx, src, now, readCodexCredentialRaw, c.refreshCodex)
		if err != nil {
			return nil, err
		}
		payload, err := c.fetchWith401Retry(ctx, src, now, cred, refreshed, c.refreshCodex, func(active *nativeCredential) (any, error) {
			return c.request(ctx, c.codexURL(), map[string]string{
				"Authorization":      "Bearer " + active.token,
				"ChatGPT-Account-Id": active.accountID,
				"User-Agent":         "codex-cli",
				"Accept":             "application/json",
			}, endpointCodex)
		})
		if err != nil {
			return nil, err
		}
		snap := normalizeCodex(payload, now)
		if resetURL := c.codexResetCreditsURL(); resetURL != "" {
			if resetPayload, resetErr := c.request(ctx, resetURL, map[string]string{
				"Authorization":      "Bearer " + cred.token,
				"ChatGPT-Account-Id": cred.accountID,
				"User-Agent":         "codex-cli",
				"OpenAI-Beta":        "codex-1",
				"Accept":             "application/json",
			}, endpointCodex); resetErr == nil {
				mergeCodexResetCredits(snap, resetPayload, now)
			}
		}
		redactSnapshot(snap, "codex", cred.token, cred.accountID)
		return snap, nil
	case "claude":
		cred, refreshed, err := c.prepareCredential(ctx, src, now, readClaudeCredentialRaw, c.refreshClaude)
		if err != nil {
			return nil, err
		}
		payload, err := c.fetchWith401Retry(ctx, src, now, cred, refreshed, c.refreshClaude, func(active *nativeCredential) (any, error) {
			return c.request(ctx, c.claudeURL(), map[string]string{
				"Authorization":  "Bearer " + active.token,
				"anthropic-beta": "oauth-2025-04-20",
				"Accept":         "application/json",
				"User-Agent":     quotaUserAgent,
			}, endpointClaude)
		})
		if err != nil {
			return nil, err
		}
		snap := normalizeClaude(payload, now)
		redactSnapshot(snap, "claude", cred.token)
		return snap, nil
	case "opencode":
		cred, err := readOpenCodeCredential(ctx, src.AuthDir, now)
		if err != nil {
			return nil, err
		}
		if cred.console {
			payload, err := c.request(ctx, c.openCodeConsoleURL(), map[string]string{
				"Authorization": "Bearer " + cred.token,
				"x-org-id":      cred.orgID,
				"Accept":        "application/json",
				"User-Agent":    quotaUserAgent,
			}, endpointOpenCodeConsole)
			if err != nil {
				return nil, err
			}
			snap := normalizeConsole(payload)
			redactSnapshot(snap, "opencode", cred.token, cred.orgID)
			return snap, nil
		}
		payload, err := c.request(ctx, c.openCodeGoURL(), map[string]string{
			"Authorization": "Bearer " + cred.token,
			"Accept":        "application/json",
			"User-Agent":    quotaUserAgent,
		}, endpointOpenCodeGo)
		if err != nil {
			return nil, err
		}
		snap := normalizeOpenCodeGo(payload, now)
		redactSnapshot(snap, "opencode", cred.token)
		return snap, nil
	default:
		return nil, unsupported("不支持的订阅引擎")
	}
}

type credReader func(authDir string) (*nativeCredential, map[string]any, string, error)
type credRefresher func(ctx context.Context, authDir, rejectedToken string, now time.Time) (*nativeCredential, error)

func (c *Client) prepareCredential(ctx context.Context, src Source, now time.Time, read credReader, refresh credRefresher) (*nativeCredential, bool, error) {
	cred, _, _, err := read(src.AuthDir)
	if err != nil {
		return nil, false, err
	}
	expired, expiringSoon := c.shouldRefresh(cred, now)
	if expired {
		if cred.refreshToken == "" {
			return nil, false, unauthenticated("原生登录已过期，请在对应工具中重新登录")
		}
		if src.SkipRefresh {
			return nil, false, renewalPending()
		}
		updated, err := refresh(ctx, src.AuthDir, "", now)
		if err != nil {
			return nil, false, err
		}
		return updated, true, nil
	}
	if expiringSoon && cred.refreshToken != "" && !src.SkipRefresh {
		updated, err := refresh(ctx, src.AuthDir, "", now)
		if err == nil {
			return updated, true, nil
		}
		var qe *Error
		if errors.As(err, &qe) && qe.Kind == kindUnauthenticated {
			return nil, false, err
		}
		// Transient refresh error while the current access token is still valid:
		// proceed with the current token and retry refresh on the next poll.
	}
	return cred, false, nil
}

func (c *Client) fetchWith401Retry(
	ctx context.Context,
	src Source,
	now time.Time,
	cred *nativeCredential,
	alreadyRefreshed bool,
	refresh credRefresher,
	call func(*nativeCredential) (any, error),
) (any, error) {
	payload, err := call(cred)
	if err == nil || alreadyRefreshed || src.SkipRefresh || cred.refreshToken == "" {
		return payload, err
	}
	var qe *Error
	if !errors.As(err, &qe) || qe.status != http.StatusUnauthorized {
		return nil, err
	}
	updated, refreshErr := refresh(ctx, src.AuthDir, cred.token, now)
	if refreshErr != nil {
		return nil, refreshErr
	}
	*cred = *updated
	return call(cred)
}

func (c *Client) codexURL() string {
	if c != nil && c.CodexURL != "" {
		return c.CodexURL
	}
	return defaultCodexURL
}

func (c *Client) codexResetCreditsURL() string {
	if c != nil && c.CodexResetCreditsURL != "" {
		return c.CodexResetCreditsURL
	}
	// When a caller overrides CodexURL (e.g. unit tests) without setting
	// CodexResetCreditsURL, skip the optional reset-card endpoint rather than
	// hitting the live upstream.
	if c != nil && c.CodexURL != "" {
		return ""
	}
	return defaultCodexResetCreditsURL
}

func (c *Client) claudeURL() string {
	if c != nil && c.ClaudeURL != "" {
		return c.ClaudeURL
	}
	return defaultClaudeURL
}

func (c *Client) openCodeGoURL() string {
	if c != nil && c.OpenCodeGoURL != "" {
		return c.OpenCodeGoURL
	}
	return defaultOpenCodeGoURL
}

func (c *Client) openCodeConsoleURL() string {
	if c != nil && c.OpenCodeConsoleURL != "" {
		return c.OpenCodeConsoleURL
	}
	return defaultOpenCodeConsoleURL
}

// httpClient returns a copy of the configured client. Redirects are never
// followed and ambient cookies are never sent, so a bearer token cannot be
// forwarded to a third-party host.
func (c *Client) httpClient() *http.Client {
	var base http.Client
	if c != nil && c.HTTP != nil {
		base = *c.HTTP
	} else {
		base.Timeout = defaultHTTPTimeout
	}
	base.Jar = nil
	base.CheckRedirect = func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}
	return &base
}

// retryDelays spaces the extra attempts made after a dropped connection or a
// 5xx. A rate limit is never retried: probing again only extends it.
var retryDelays = []time.Duration{500 * time.Millisecond, 2 * time.Second}

func (c *Client) request(ctx context.Context, url string, headers map[string]string, ep endpoint) (any, error) {
	for attempt := 0; ; attempt++ {
		payload, retry, err := c.requestOnce(ctx, url, headers, ep)
		if !retry || attempt == len(retryDelays) {
			return payload, err
		}
		timer := time.NewTimer(retryDelays[attempt])
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, err
		case <-timer.C:
		}
	}
}

// requestOnce performs one GET. retry reports a failure worth repeating at once.
func (c *Client) requestOnce(ctx context.Context, url string, headers map[string]string, ep endpoint) (_ any, retry bool, _ error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, false, upstream("额度接口地址无效")
	}
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	resp, err := c.httpClient().Do(req)
	if err != nil {
		switch {
		case errors.Is(err, context.DeadlineExceeded), ctx.Err() == context.DeadlineExceeded:
			return nil, false, transient("额度接口请求超时")
		case errors.Is(err, context.Canceled), ctx.Err() == context.Canceled:
			return nil, false, transient("额度请求已取消")
		default:
			return nil, true, transient("额度接口请求失败")
		}
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		if ep == endpointOpenCodeGo && resp.StatusCode == http.StatusForbidden {
			if body, readErr := readLimited(resp.Body); readErr == nil && isEntitlementError(body) {
				return nil, false, unsupported("当前 key 没有 Go 订阅，无法读取 Go 套餐窗口；免费模型与按量余额没有官方只读额度接口")
			}
			return nil, false, upstream("额度接口暂时不可用")
		}
		switch resp.StatusCode {
		case http.StatusUnauthorized:
			if ep == endpointOpenCodeConsole {
				e := unauthenticated("原生 Console 登录无效，请在 OpenCode 中重新登录后手动刷新")
				e.status = http.StatusUnauthorized
				return nil, false, e
			}
			e := unauthenticated("原生登录无效或无权读取额度，请在对应工具中确认登录")
			e.status = http.StatusUnauthorized
			return nil, false, e
		case http.StatusForbidden:
			if ep == endpointOpenCodeConsole {
				return nil, false, unsupported("当前 Console 登录无 Go 额度读取权限；免费模型与按量余额没有官方只读额度接口")
			}
			return nil, false, unauthenticated("原生登录无效或无权读取额度，请在对应工具中确认登录")
		case http.StatusTooManyRequests:
			return nil, false, transient("额度探测接口限流，请稍后重试")
		}
		if resp.StatusCode >= 500 {
			return nil, true, transient("额度接口暂时不可用")
		}
		return nil, false, upstream("额度接口暂时不可用")
	}

	contentType := resp.Header.Get("Content-Type")
	if i := strings.IndexByte(contentType, ';'); i >= 0 {
		contentType = contentType[:i]
	}
	contentType = strings.ToLower(strings.TrimSpace(contentType))
	if contentType != "application/json" && !strings.HasSuffix(contentType, "+json") {
		return nil, false, upstream("额度接口返回了非 JSON 数据")
	}
	body, err := readLimited(resp.Body)
	if err != nil {
		return nil, false, err
	}
	var payload any
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, false, upstream("额度接口返回了无效 JSON")
	}
	return payload, false, nil
}

func readLimited(r io.Reader) ([]byte, error) {
	body, err := io.ReadAll(io.LimitReader(r, maxResponseBytes+1))
	if err != nil {
		return nil, transient("额度接口读取响应失败")
	}
	if len(body) > maxResponseBytes {
		return nil, upstream("额度响应超过大小限制")
	}
	return body, nil
}

func isEntitlementError(body []byte) bool {
	var payload map[string]any
	if json.Unmarshal(body, &payload) != nil {
		return false
	}
	detail, ok := object(payload["error"])
	if !ok {
		return false
	}
	kind, _ := detail["type"].(string)
	return kind == "EntitlementError"
}
