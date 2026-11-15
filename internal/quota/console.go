package quota

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io/fs"
	"math"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

type dbCredential struct {
	id            string
	integrationID string
	kind          string
	key           string
	access        string
	refresh       string
	active        bool
	expires       any
	metadata      map[string]any
}

// readOpenCodeDatabase reads the native login state. A missing database means
// "no native login yet" (the caller then tries the auth.json key). Any other
// unreadable state fails closed so credentials of two accounts are never mixed.
func readOpenCodeDatabase(ctx context.Context, path string, now time.Time) (*nativeCredential, error) {
	info, err := os.Lstat(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, unsupported("无法安全读取原生 Console 登录")
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() || info.Size() == 0 {
		return nil, unsupported("无法安全读取原生 Console 登录")
	}
	db, err := sql.Open("sqlite", readOnlyDSN(path))
	if err != nil {
		return nil, unsupported("无法安全读取原生 Console 登录")
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	_, _ = db.ExecContext(ctx, "PRAGMA query_only = ON")

	credentials, credentialsRead := readCredentialRows(ctx, db)
	if credentialsRead {
		login, err := consoleFromCredentials(credentials, now)
		if err != nil {
			return nil, err
		}
		if login != nil {
			return login, nil
		}
	}
	login, err := consoleFromLegacy(ctx, db, now)
	if err != nil {
		if _, statErr := os.Lstat(path); errors.Is(statErr, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	if login != nil {
		return login, nil
	}
	if credentialsRead {
		key, err := goKeyFromCredentials(credentials)
		if err != nil {
			return nil, err
		}
		if key != nil {
			return key, nil
		}
	}
	return nil, nil
}

func readOnlyDSN(path string) string {
	base := url.URL{Scheme: "file", Path: path}
	return base.String() + "?mode=ro&_pragma=query_only(ON)&_pragma=busy_timeout(5000)"
}

func readCredentialRows(ctx context.Context, db *sql.DB) ([]dbCredential, bool) {
	rows, err := db.QueryContext(ctx,
		"SELECT id, integration_id, label, value, active, time_created FROM credential ORDER BY active DESC, time_created DESC, id DESC")
	if err != nil {
		return nil, false
	}
	defer rows.Close()
	var credentials []dbCredential
	for rows.Next() {
		var rawID, rawIntegration, rawLabel, rawValue, rawActive any
		var created any
		if err := rows.Scan(&rawID, &rawIntegration, &rawLabel, &rawValue, &rawActive, &created); err != nil {
			return nil, false
		}
		id := nonempty(rawID, 256)
		integrationID := nonempty(rawIntegration, 256)
		label, labelOK := rawLabel.(string)
		value, valueOK := rawValue.(string)
		if id == "" || integrationID == "" || !labelOK || label == "" || len(label) > 256 || hasControl(label) || !valueOK || len(value) > 64*1024 {
			continue
		}
		var decoded map[string]any
		if json.Unmarshal([]byte(value), &decoded) != nil {
			continue
		}
		kind, _ := decoded["type"].(string)
		if kind != "key" && kind != "oauth" && kind != "external" {
			continue
		}
		credential := dbCredential{
			id:            id,
			integrationID: integrationID,
			kind:          kind,
			active:        rawActive == int64(1) || rawActive == true,
		}
		switch kind {
		case "key":
			credential.key = nonempty(decoded["key"], 16384)
			if credential.key == "" {
				continue
			}
		case "oauth":
			credential.access = nonempty(decoded["access"], 16384)
			if credential.access == "" {
				continue
			}
			if refresh, ok := decoded["refresh"].(string); ok && len(refresh) <= 16384 {
				credential.refresh = refresh
			}
			if expires, ok := decoded["expires"]; ok {
				credential.expires = expires
			}
		}
		if metadata, ok := object(decoded["metadata"]); ok {
			credential.metadata = metadata
		}
		credentials = append(credentials, credential)
	}
	if rows.Err() != nil {
		return nil, false
	}
	return credentials, true
}

func hasControl(text string) bool {
	for _, r := range text {
		if r <= 0x1f || r == 0x7f {
			return true
		}
	}
	return false
}

func consoleFromCredentials(credentials []dbCredential, now time.Time) (*nativeCredential, error) {
	var rows []dbCredential
	for _, credential := range credentials {
		if credential.integrationID == "opencode" {
			rows = append(rows, credential)
		}
	}
	if len(rows) == 0 {
		return nil, nil
	}
	var row dbCredential
	active := 0
	for _, candidate := range rows {
		if candidate.active {
			active++
			if active == 1 {
				row = candidate
			}
		}
	}
	if active > 1 {
		return nil, unsupported("OpenCode Console 登录账户不明确，不会使用其他账号凭据")
	}
	if active == 0 {
		row = rows[0]
	}
	token := row.access
	if token == "" {
		return nil, unauthenticated("OpenCode Console 登录无效，请在 OpenCode 中重新登录后手动刷新")
	}
	orgValue := row.metadata["orgID"]
	if orgValue == nil {
		orgValue = row.metadata["orgId"]
	}
	orgID := nonemptyID(orgValue)
	if orgID == "" {
		return nil, unsupported("OpenCode Console 登录组织缺失，不会使用其他账号凭据")
	}
	origin := ""
	if server, ok := row.metadata["server"]; ok {
		if text, ok := server.(string); ok {
			origin = normalizeOrigin(text)
		}
	}
	if origin == "" {
		origin = openCodeConsoleRoot
	}
	if origin != openCodeConsoleRoot {
		return nil, unsupported("原生 Console 登录来源不受支持，不会发送凭据")
	}
	if expires, ok := expiryMillis(row.expires); ok && expires <= now.UnixMilli() {
		if row.refresh != "" {
			return nil, renewalPending()
		}
		return nil, unauthenticated("原生 Console 登录已过期，请在 OpenCode 中重新登录后手动刷新")
	}
	return &nativeCredential{token: token, orgID: orgID, console: true}, nil
}

func goKeyFromCredentials(credentials []dbCredential) (*nativeCredential, error) {
	var rows []dbCredential
	for _, credential := range credentials {
		if credential.integrationID == "opencode-go" {
			rows = append(rows, credential)
		}
	}
	if len(rows) == 0 {
		return nil, nil
	}
	row := rows[0]
	for _, candidate := range rows {
		if candidate.active {
			row = candidate
			break
		}
	}
	if row.kind != "key" || row.key == "" {
		return nil, unsupported("OpenCode Go 当前登录方式没有可读的套餐额度；连接 Go 订阅后可查看套餐窗口")
	}
	return &nativeCredential{token: row.key}, nil
}

func consoleFromLegacy(ctx context.Context, db *sql.DB, now time.Time) (*nativeCredential, error) {
	rows, err := db.QueryContext(ctx, "SELECT active_account_id, active_org_id FROM account_state LIMIT 2")
	if err != nil {
		return nil, dbFailure(ctx)
	}
	var accountIDValues, orgIDValues []any
	for rows.Next() {
		var accountID, orgID any
		if err := rows.Scan(&accountID, &orgID); err != nil {
			rows.Close()
			return nil, dbFailure(ctx)
		}
		accountIDValues = append(accountIDValues, accountID)
		orgIDValues = append(orgIDValues, orgID)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, dbFailure(ctx)
	}
	rows.Close()
	if len(accountIDValues) == 0 {
		return nil, nil
	}
	if len(accountIDValues) != 1 {
		return nil, unsupported("原生 Console 登录账户不明确，不会使用其他账号凭据")
	}
	if blank(accountIDValues[0]) {
		return nil, nil
	}
	accountID := nonemptyID(accountIDValues[0])
	if accountID == "" {
		return nil, unsupported("原生 Console 登录账户不明确，不会使用其他账号凭据")
	}
	var orgID string
	if !blank(orgIDValues[0]) {
		orgID = nonemptyID(orgIDValues[0])
	}
	if orgID == "" {
		return nil, unsupported("原生 Console 登录组织缺失，不会使用其他账号凭据")
	}

	var rawURL, rawToken, rawExpiry, rawRefresh any
	err = db.QueryRowContext(ctx,
		"SELECT url, access_token, token_expiry, CASE WHEN refresh_token IS NOT NULL AND refresh_token != '' THEN 1 ELSE 0 END AS has_refresh FROM account WHERE id = ?",
		accountID).Scan(&rawURL, &rawToken, &rawExpiry, &rawRefresh)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, unauthenticated("原生 Console 登录无效，请在 OpenCode 中重新登录后手动刷新")
	}
	if err != nil {
		return nil, dbFailure(ctx)
	}
	rawURLText, _ := rawURL.(string)
	origin := normalizeOrigin(rawURLText)
	if origin != openCodeConsoleRoot {
		return nil, unsupported("原生 Console 登录来源不受支持，不会发送凭据")
	}
	token := nonempty(rawToken, 16384)
	if token == "" {
		return nil, unauthenticated("原生 Console 登录无效，请在 OpenCode 中重新登录后手动刷新")
	}
	expires, hasExpiry := expiryMillis(rawExpiry)
	if !hasExpiry && rawExpiry != nil {
		return nil, unsupported("无法确认 OpenCode Console 登录有效期")
	}
	if hasExpiry && expires <= now.UnixMilli() {
		if rawRefresh == int64(1) || rawRefresh == true {
			return nil, renewalPending()
		}
		return nil, unauthenticated("原生 Console 登录已过期，请在 OpenCode 中重新登录后手动刷新")
	}
	return &nativeCredential{token: token, orgID: orgID, console: true}, nil
}

func blank(value any) bool {
	if value == nil {
		return true
	}
	if text, ok := value.(string); ok {
		return strings.TrimSpace(text) == ""
	}
	return false
}

func dbFailure(ctx context.Context) *Error {
	if ctx.Err() != nil {
		return transient("额度请求已取消")
	}
	return unsupported("无法安全读取原生 Console 登录")
}

func normalizeOrigin(raw string) string {
	trimmed := strings.TrimRight(strings.TrimSpace(raw), "/")
	if trimmed == "" {
		return ""
	}
	parsed, err := url.Parse(trimmed)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return ""
	}
	if parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.RawFragment != "" {
		return ""
	}
	scheme := strings.ToLower(parsed.Scheme)
	host := strings.ToLower(parsed.Host)
	// The URL API used by the reference drops a default port. Do the same so
	// https://opencode.ai:443/console is the official origin.
	if scheme == "https" && strings.HasSuffix(host, ":443") || scheme == "http" && strings.HasSuffix(host, ":80") {
		host = host[:strings.LastIndexByte(host, ':')]
	}
	path := strings.TrimRight(parsed.EscapedPath(), "/")
	return scheme + "://" + host + path
}

func meterPercent(used, limit uint64) float64 {
	if limit == 0 || used >= limit {
		return 100
	}
	if used <= (^uint64(0))/10000 {
		return float64((used*10000)/limit) / 100
	}
	return meterPercentExact(used, limit)
}

func microCents(value any) (uint64, bool) {
	switch v := value.(type) {
	case float64:
		if math.IsNaN(v) || math.IsInf(v, 0) || v < 0 || v > 1_000_000_000_000_000 || v != math.Trunc(v) {
			return 0, false
		}
		return uint64(v), true
	case int64:
		if v < 0 {
			return 0, false
		}
		return uint64(v), true
	case string:
		if len(v) == 0 || len(v) > 24 {
			return 0, false
		}
		for _, r := range v {
			if r < '0' || r > '9' {
				return 0, false
			}
		}
		parsed, err := strconv.ParseUint(v, 10, 64)
		if err != nil || parsed > 1_000_000_000_000_000_000 {
			return 0, false
		}
		return parsed, true
	default:
		return 0, false
	}
}
