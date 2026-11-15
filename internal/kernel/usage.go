package kernel

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/MarioJames/weaver/internal/engine"
)

// Usage queries read the spend APIs of the two vendors that offer them. The
// addresses are variables so tests can point them at httptest servers.
var (
	openAICostsURL   = "https://api.openai.com/v1/organization/costs"
	anthropicCostURL = "https://api.anthropic.com/v1/organizations/cost_report"
	usageHTTPClient  = &http.Client{Timeout: 15 * time.Second}
)

const (
	usageOpenAI    = "openai"
	usageAnthropic = "anthropic"

	unsupportedUsage = "这个渠道暂不支持用量查询（只支持 OpenAI、Anthropic 官方）"
)

// OptionalFloat tells an omitted JSON field apart from an explicit null.
// account.usage.set uses it for balance and alertBelow: absent keeps the stored
// value, null clears it.
type OptionalFloat struct {
	Set   bool
	Value *float64
}

func (o *OptionalFloat) UnmarshalJSON(b []byte) error {
	o.Set = true
	if string(b) == "null" {
		o.Value = nil
		return nil
	}
	var f float64
	if err := json.Unmarshal(b, &f); err != nil {
		return err
	}
	o.Value = &f
	return nil
}

// UsagePatch changes one account's usage configuration; nil fields keep their
// stored value.
type UsagePatch struct {
	AdminKey   *string       `json:"adminKey,omitempty"`
	Balance    OptionalFloat `json:"balance"`
	AlertBelow OptionalFloat `json:"alertBelow"`
	Interval   *int          `json:"interval,omitempty"`
}

// usageSupport returns the vendor whose spend API can be queried for this
// account, or "" when it is not an official OpenAI or Anthropic channel.
func usageSupport(a engine.Account) string {
	if a.Kind != "api" {
		return ""
	}
	base := accountBaseURL(a)
	switch {
	case (a.Engine == "dsh" && a.Provider == usageOpenAI) || a.Engine == "codex":
		if officialBase(base, "https://api.openai.com/v1") {
			return usageOpenAI
		}
	case (a.Engine == "dsh" && a.Provider == usageAnthropic) || a.Engine == "claude":
		if officialBase(base, "https://api.anthropic.com") {
			return usageAnthropic
		}
	}
	return ""
}

// accountBaseURL is the address the account will actually call: the explicit
// field wins, then the native config's baseURL, then the engine default.
func accountBaseURL(a engine.Account) string {
	if base := strings.TrimSpace(a.BaseURL); base != "" {
		return base
	}
	if a.Config == "" {
		return ""
	}
	var block map[string]any
	if json.Unmarshal([]byte(a.Config), &block) != nil {
		return ""
	}
	if base, _ := block["baseURL"].(string); strings.TrimSpace(base) != "" {
		return base
	}
	if env, _ := block["env"].(map[string]any); env != nil {
		for _, key := range []string{"ANTHROPIC_BASE_URL", "OPENAI_BASE_URL"} {
			if base, _ := env[key].(string); strings.TrimSpace(base) != "" {
				return base
			}
		}
	}
	return ""
}

func officialBase(base, official string) bool {
	base = strings.TrimRight(strings.TrimSpace(base), "/")
	if base == "" {
		return true
	}
	return base == strings.TrimRight(official, "/")
}

func utcDayStart(t time.Time) time.Time {
	t = t.UTC()
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
}

func utcMonthStart(t time.Time) time.Time {
	t = t.UTC()
	return time.Date(t.Year(), t.Month(), 1, 0, 0, 0, 0, time.UTC)
}

func moneyPtr(v float64) *float64 { return &v }

// usageView builds the JSON view of an account's usage. It returns nil when
// the account has neither an admin key nor a recorded balance.
func usageView(hasAdminKey bool, a engine.Account, balance sql.NullFloat64, balanceAt sql.NullInt64,
	alert sql.NullFloat64, interval int, spent, since sql.NullFloat64, checked sql.NullInt64, errText string) *AccountUsage {
	if !hasAdminKey && !balance.Valid {
		return nil
	}
	provider := usageSupport(a)
	u := &AccountUsage{Supported: provider != "", Provider: provider, Interval: interval}
	if spent.Valid {
		u.SpentMonth = moneyPtr(spent.Float64)
	}
	if balance.Valid {
		u.Balance = moneyPtr(balance.Float64)
	}
	if balanceAt.Valid {
		u.BalanceAt = balanceAt.Int64
	}
	if alert.Valid {
		u.AlertBelow = moneyPtr(alert.Float64)
	}
	if balance.Valid {
		added := 0.0
		if since.Valid {
			added = since.Float64
		}
		u.Remaining = moneyPtr(balance.Float64 - added)
		if alert.Valid && *u.Remaining < alert.Float64 {
			u.Low = true
		}
	}
	if checked.Valid {
		u.CheckedAt = checked.Int64
	}
	u.Error = errText
	return u
}

// usageAccountRow is the account material a usage query needs.
type usageAccountRow struct {
	engine.Account
	AdminKey  string
	Balance   sql.NullFloat64
	BalanceAt sql.NullInt64
	Baseline  sql.NullFloat64
	Interval  int
}

func readUsageAccount(q querier, id string) (*usageAccountRow, error) {
	a := &usageAccountRow{}
	err := q.QueryRow(`SELECT id, engine, kind, label, auth_dir, api_key, config, base_url, provider, protocol,
		admin_key, balance_usd, balance_at, balance_baseline_usd, usage_interval_s FROM accounts WHERE id=?`, id).
		Scan(&a.ID, &a.Engine, &a.Kind, &a.Label, &a.AuthDir, &a.APIKey, &a.Config, &a.BaseURL, &a.Provider, &a.Protocol,
			&a.AdminKey, &a.Balance, &a.BalanceAt, &a.Baseline, &a.Interval)
	if err == sql.ErrNoRows {
		return nil, errf("NOT_FOUND", "账号 %s 不存在", id)
	}
	return a, err
}

// SetAccountUsage changes the usage configuration of an official channel.
// Setting a balance also records its time and queries the spend baseline for
// that UTC day, so spend from before the record is not deducted twice.
func (k *Kernel) SetAccountUsage(id string, patch UsagePatch) (*Account, error) {
	err := k.write(func(t *tx) error {
		a, err := readUsageAccount(t, id)
		if err != nil {
			return err
		}
		if usageSupport(a.Account) == "" {
			return errf("INVALID", unsupportedUsage)
		}
		if patch.AdminKey != nil {
			// A different key invalidates the previous answer: forget the old
			// error and let the next query (or the scheduler) run promptly.
			if _, err := t.Exec(`UPDATE accounts SET admin_key=?, usage_error='', usage_checked_at=NULL WHERE id=?`, *patch.AdminKey, id); err != nil {
				return err
			}
		}
		if patch.Interval != nil {
			if *patch.Interval < 0 {
				return errf("INVALID", "自动查询间隔不能为负")
			}
			if _, err := t.Exec(`UPDATE accounts SET usage_interval_s=? WHERE id=?`, *patch.Interval, id); err != nil {
				return err
			}
		}
		if patch.AlertBelow.Set {
			if patch.AlertBelow.Value == nil {
				if _, err := t.Exec(`UPDATE accounts SET alert_below_usd=NULL WHERE id=?`, id); err != nil {
					return err
				}
			} else {
				if *patch.AlertBelow.Value < 0 {
					return errf("INVALID", "提示线不能为负")
				}
				if _, err := t.Exec(`UPDATE accounts SET alert_below_usd=? WHERE id=?`, *patch.AlertBelow.Value, id); err != nil {
					return err
				}
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if patch.Balance.Set {
		return k.setAccountBalance(id, patch.Balance.Value)
	}
	return k.Account(id)
}

// setAccountBalance records a recharge and immediately takes a baseline of the
// day's spend. A failed query still records the balance, with baseline 0 and
// the upstream error kept for display.
func (k *Kernel) setAccountBalance(id string, value *float64) (*Account, error) {
	var release func()
	for {
		var wait <-chan struct{}
		var owner bool
		release, wait, owner = k.acquireUsage(id)
		if owner {
			break
		}
		select {
		case <-wait:
		case <-k.stop:
			return nil, errf("SHUTDOWN", "服务正在停止")
		}
	}
	defer release()

	row, err := k.readUsageAccount(id)
	if err != nil {
		return nil, err
	}
	if value == nil {
		if err := k.write(func(t *tx) error {
			_, err := t.Exec(`UPDATE accounts SET balance_usd=NULL, balance_at=NULL, balance_baseline_usd=NULL, usage_since_balance_usd=NULL WHERE id=?`, id)
			return err
		}); err != nil {
			return nil, err
		}
		return k.Account(id)
	}

	now := k.now()
	baseline := 0.0
	checkedAt := now.UnixMilli()
	errText := ""
	provider := usageSupport(row.Account)
	switch {
	case provider == "":
		errText = unsupportedUsage
	case row.AdminKey == "":
		errText = "还没有配置管理密钥"
	default:
		cost, qerr := k.queryCosts(provider, row.AdminKey, utcDayStart(now), now)
		if qerr != nil {
			errText = clip(qerr.Error(), 1000)
		} else {
			baseline = cost
		}
	}
	if err := k.write(func(t *tx) error {
		_, err := t.Exec(`UPDATE accounts SET balance_usd=?, balance_at=?, balance_baseline_usd=?, usage_since_balance_usd=0,
			usage_checked_at=?, usage_error=? WHERE id=?`, *value, now.UnixMilli(), baseline, checkedAt, errText, id)
		return err
	}); err != nil {
		return nil, err
	}
	return k.Account(id)
}

func (k *Kernel) readUsageAccount(id string) (*usageAccountRow, error) {
	var row *usageAccountRow
	err := k.read(func() (err error) { row, err = readUsageAccount(k.db, id); return })
	return row, err
}

// QueryAccountUsage queries one account now and returns it with the refreshed
// usage data. A vendor failure is stored on the account and returned in
// usage.error; the call itself still succeeds so the account stays usable.
func (k *Kernel) QueryAccountUsage(id string) (*Account, error) {
	release, wait, owner := k.acquireUsage(id)
	if !owner {
		select {
		case <-wait:
		case <-k.stop:
			return nil, errf("SHUTDOWN", "服务正在停止")
		}
		return k.Account(id)
	}
	defer release()
	return k.refreshUsage(id)
}

func (k *Kernel) refreshUsage(id string) (*Account, error) {
	row, err := k.readUsageAccount(id)
	if err != nil {
		return nil, err
	}
	provider := usageSupport(row.Account)
	if provider == "" {
		return nil, errf("INVALID", unsupportedUsage)
	}
	if row.AdminKey == "" {
		return nil, errf("INVALID", "这个渠道还没有配置管理密钥")
	}
	now := k.now()
	spent, err := k.queryCosts(provider, row.AdminKey, utcMonthStart(now), now)
	if err != nil {
		if werr := k.write(func(t *tx) error {
			_, err := t.Exec(`UPDATE accounts SET usage_checked_at=?, usage_error=? WHERE id=?`, now.UnixMilli(), clip(err.Error(), 1000), id)
			return err
		}); werr != nil {
			return nil, werr
		}
		return k.Account(id)
	}

	var since any
	if row.Balance.Valid && row.BalanceAt.Valid {
		dayStart := utcDayStart(time.UnixMilli(row.BalanceAt.Int64))
		dayCost, derr := k.queryCosts(provider, row.AdminKey, dayStart, now)
		if derr != nil {
			if werr := k.write(func(t *tx) error {
				_, err := t.Exec(`UPDATE accounts SET usage_checked_at=?, usage_error=? WHERE id=?`, now.UnixMilli(), clip(derr.Error(), 1000), id)
				return err
			}); werr != nil {
				return nil, werr
			}
			return k.Account(id)
		}
		added := dayCost - row.Baseline.Float64
		if added < 0 {
			added = 0
		}
		since = added
	}
	if err := k.write(func(t *tx) error {
		_, err := t.Exec(`UPDATE accounts SET usage_spent_month_usd=?, usage_since_balance_usd=?, usage_checked_at=?, usage_error='' WHERE id=?`,
			spent, since, now.UnixMilli(), id)
		return err
	}); err != nil {
		return nil, err
	}
	return k.Account(id)
}

// acquireUsage serializes queries per account: one runs while others wait for
// its completion or skip it (the background loop skips).
func (k *Kernel) acquireUsage(id string) (release func(), wait <-chan struct{}, owner bool) {
	k.usageMu.Lock()
	defer k.usageMu.Unlock()
	if k.usageRuns == nil {
		k.usageRuns = map[string]chan struct{}{}
	}
	if ch, ok := k.usageRuns[id]; ok {
		return nil, ch, false
	}
	ch := make(chan struct{})
	k.usageRuns[id] = ch
	return func() {
		k.usageMu.Lock()
		delete(k.usageRuns, id)
		close(ch)
		k.usageMu.Unlock()
	}, nil, true
}

// usageLoop refreshes accounts that have an admin key and a positive interval.
// Queries run in their own goroutines so a slow vendor never holds the kernel
// lock or delays dispatch.
func (k *Kernel) usageLoop() {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	for {
		k.scheduleUsage()
		select {
		case <-ticker.C:
		case <-k.stop:
			return
		}
	}
}

func (k *Kernel) scheduleUsage() {
	now := k.ms()
	var due []string
	_ = k.read(func() error {
		rows, err := k.db.Query(`SELECT id, usage_interval_s, COALESCE(usage_checked_at,0) FROM accounts
			WHERE kind='api' AND admin_key<>'' AND usage_interval_s>0`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var id string
			var interval int
			var checked int64
			if err := rows.Scan(&id, &interval, &checked); err != nil {
				return err
			}
			if now-checked >= int64(interval)*1000 {
				due = append(due, id)
			}
		}
		return rows.Err()
	})
	for _, id := range due {
		go func(id string) {
			release, _, owner := k.acquireUsage(id)
			if !owner {
				return
			}
			defer release()
			_, _ = k.refreshUsage(id)
		}(id)
	}
}

func (k *Kernel) queryCosts(provider, key string, start, end time.Time) (float64, error) {
	if provider == usageAnthropic {
		return fetchAnthropicCosts(key, start, end)
	}
	return fetchOpenAICosts(key, start, end)
}

func fetchOpenAICosts(key string, start, end time.Time) (float64, error) {
	total := 0.0
	page := ""
	for n := 0; n < 100; n++ {
		u, err := url.Parse(openAICostsURL)
		if err != nil {
			return 0, err
		}
		q := u.Query()
		q.Set("start_time", strconv.FormatInt(start.Unix(), 10))
		q.Set("end_time", strconv.FormatInt(end.Unix(), 10))
		q.Set("bucket_width", "1d")
		q.Set("limit", "31")
		if page != "" {
			q.Set("page", page)
		}
		u.RawQuery = q.Encode()
		req, err := http.NewRequest(http.MethodGet, u.String(), nil)
		if err != nil {
			return 0, err
		}
		req.Header.Set("Authorization", "Bearer "+key)
		status, body, err := apiGet(req, "用量")
		if err != nil {
			return 0, err
		}
		if status < 200 || status >= 300 {
			return 0, fmt.Errorf("%s", upstreamMessage(status, body))
		}
		var out struct {
			Data []struct {
				Results []struct {
					Amount struct {
						Value    float64 `json:"value"`
						Currency string  `json:"currency"`
					} `json:"amount"`
				} `json:"results"`
			} `json:"data"`
			HasMore  bool    `json:"has_more"`
			NextPage *string `json:"next_page"`
		}
		if err := json.Unmarshal(body, &out); err != nil {
			return 0, fmt.Errorf("OpenAI 用量接口返回的不是合法 JSON：%v", err)
		}
		for _, bucket := range out.Data {
			for _, result := range bucket.Results {
				total += result.Amount.Value
			}
		}
		if !out.HasMore || out.NextPage == nil || *out.NextPage == "" || *out.NextPage == page {
			break
		}
		page = *out.NextPage
	}
	return moneyRound(total), nil
}

func fetchAnthropicCosts(key string, start, end time.Time) (float64, error) {
	total := 0.0
	page := ""
	for n := 0; n < 100; n++ {
		u, err := url.Parse(anthropicCostURL)
		if err != nil {
			return 0, err
		}
		q := u.Query()
		q.Set("starting_at", start.UTC().Format(time.RFC3339))
		q.Set("ending_at", end.UTC().Format(time.RFC3339))
		if page != "" {
			q.Set("page", page)
		}
		u.RawQuery = q.Encode()
		req, err := http.NewRequest(http.MethodGet, u.String(), nil)
		if err != nil {
			return 0, err
		}
		req.Header.Set("x-api-key", key)
		req.Header.Set("anthropic-version", "2023-06-01")
		status, body, err := apiGet(req, "用量")
		if err != nil {
			return 0, err
		}
		if status < 200 || status >= 300 {
			return 0, fmt.Errorf("%s", upstreamMessage(status, body))
		}
		var out struct {
			Data []struct {
				Results []struct {
					Amount json.RawMessage `json:"amount"`
				} `json:"results"`
			} `json:"data"`
			HasMore  bool    `json:"has_more"`
			NextPage *string `json:"next_page"`
		}
		if err := json.Unmarshal(body, &out); err != nil {
			return 0, fmt.Errorf("Anthropic 用量接口返回的不是合法 JSON：%v", err)
		}
		for _, bucket := range out.Data {
			for _, result := range bucket.Results {
				cents, err := decimalAmount(result.Amount)
				if err != nil {
					return 0, fmt.Errorf("Anthropic 用量接口返回的金额无法解析：%v", err)
				}
				total += cents / 100
			}
		}
		if !out.HasMore || out.NextPage == nil || *out.NextPage == "" || *out.NextPage == page {
			break
		}
		page = *out.NextPage
	}
	return moneyRound(total), nil
}

// decimalAmount reads a decimal amount that the vendor encodes as either a
// string or a JSON number.
func decimalAmount(raw json.RawMessage) (float64, error) {
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return strconv.ParseFloat(strings.TrimSpace(s), 64)
	}
	var f float64
	if err := json.Unmarshal(raw, &f); err != nil {
		return 0, err
	}
	return f, nil
}

// apiGet performs one vendor request with the shared 15 second timeout.
func apiGet(req *http.Request, what string) (int, []byte, error) {
	resp, err := usageHTTPClient.Do(req)
	if err != nil {
		return 0, nil, fmt.Errorf("请求%s接口失败：%v", what, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return resp.StatusCode, nil, fmt.Errorf("读取%s接口响应失败：%v", what, err)
	}
	return resp.StatusCode, body, nil
}

// upstreamMessage keeps the vendor's own explanation, falling back to the HTTP
// status and a clipped body.
func upstreamMessage(status int, body []byte) string {
	var parsed struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal(body, &parsed) == nil && strings.TrimSpace(parsed.Error.Message) != "" {
		return parsed.Error.Message
	}
	text := strings.TrimSpace(string(body))
	if text == "" {
		return fmt.Sprintf("HTTP %d", status)
	}
	return fmt.Sprintf("HTTP %d：%s", status, clip(text, 300))
}

// moneyRound keeps sums that go through float64 from showing noise.
func moneyRound(v float64) float64 { return math.Round(v*1e6) / 1e6 }
