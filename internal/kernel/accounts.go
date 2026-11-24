package kernel

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/MarioJames/weaver/internal/engine"
	"github.com/MarioJames/weaver/internal/quota"
)

// AccountInput creates an account. Secrets go in and never come back out.
type AccountInput struct {
	ID       string `json:"id,omitempty"`
	Engine   string `json:"engine"`
	Kind     string `json:"kind"`
	Label    string `json:"label,omitempty"`
	AuthDir  string `json:"authDir,omitempty"`
	APIKey   string `json:"apiKey,omitempty"`
	Config   string `json:"config,omitempty"`
	BaseURL  string `json:"baseUrl,omitempty"`
	Provider string `json:"provider,omitempty"`
	Protocol string `json:"protocol,omitempty"`
}

// AccountPatch changes the fields that are set.
type AccountPatch struct {
	Label    *string `json:"label,omitempty"`
	Enabled  *bool   `json:"enabled,omitempty"`
	APIKey   *string `json:"apiKey,omitempty"`
	Config   *string `json:"config,omitempty"`
	BaseURL  *string `json:"baseUrl,omitempty"`
	Provider *string `json:"provider,omitempty"`
	Protocol *string `json:"protocol,omitempty"`
}

var idPattern = keyPattern

func (k *Kernel) AddAccount(in AccountInput) (*Account, error) {
	if !engine.Known(in.Engine) {
		return nil, errf("INVALID", "不支持的引擎 %q，可用：%s", in.Engine, strings.Join(engine.Kinds(), "、"))
	}
	if in.Kind != "subscription" && in.Kind != "api" {
		return nil, errf("INVALID", "账号类型只能是 subscription 或 api")
	}
	if in.ID == "" {
		in.ID = newID("acct_")
	}
	if !idPattern.MatchString(in.ID) {
		return nil, errf("INVALID", "账号 ID %q 不合法", in.ID)
	}
	if in.Kind == "api" && in.APIKey == "" && in.Config == "" && in.AuthDir == "" {
		return nil, errf("INVALID", "API 账号需要密钥、原生配置或已有的认证目录")
	}
	if in.Kind == "subscription" && in.AuthDir == "" {
		in.AuthDir = filepath.Join(k.home, "accounts", in.ID)
		if err := os.MkdirAll(in.AuthDir, 0o700); err != nil {
			return nil, err
		}
	}
	if in.AuthDir != "" && !filepath.IsAbs(in.AuthDir) {
		return nil, errf("INVALID", "认证目录必须是绝对路径")
	}
	err := k.write(func(t *tx) error {
		_, err := t.Exec(`INSERT INTO accounts(id, engine, kind, label, auth_dir, api_key, config, base_url, provider, protocol, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
			in.ID, in.Engine, in.Kind, in.Label, in.AuthDir, in.APIKey, in.Config, in.BaseURL, in.Provider, in.Protocol, t.now)
		if err != nil && strings.Contains(err.Error(), "UNIQUE") {
			return errf("EXISTS", "账号 %s 已存在", in.ID)
		}
		return err
	})
	if err != nil {
		return nil, err
	}
	k.CheckAccounts(in.ID)
	return k.Account(in.ID)
}

func (k *Kernel) UpdateAccount(id string, patch AccountPatch) (*Account, error) {
	err := k.write(func(t *tx) error {
		if _, err := accountSecrets(t, id); err != nil {
			return err
		}
		set := func(col string, value any) error {
			_, err := t.Exec(`UPDATE accounts SET `+col+`=? WHERE id=?`, value, id)
			return err
		}
		for col, value := range map[string]*string{"label": patch.Label, "api_key": patch.APIKey, "config": patch.Config, "base_url": patch.BaseURL, "provider": patch.Provider, "protocol": patch.Protocol} {
			if value != nil {
				if err := set(col, *value); err != nil {
					return err
				}
			}
		}
		if patch.Enabled != nil {
			if err := set("enabled", b2i(*patch.Enabled)); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	k.CheckAccounts(id)
	_ = k.Dispatch()
	return k.Account(id)
}

func b2i(b bool) int {
	if b {
		return 1
	}
	return 0
}

// RemoveAccount deletes an account record. Its credential directory is left on disk.
func (k *Kernel) RemoveAccount(id string) error {
	return k.write(func(t *tx) error {
		if _, err := accountSecrets(t, id); err != nil {
			return err
		}
		var active int
		if err := t.QueryRow(`SELECT COUNT(*) FROM attempts WHERE account_id=? AND state IN (?,?)`, id, StateLaunch, StateRunning).Scan(&active); err != nil {
			return err
		}
		if active > 0 {
			return errf("ACTIVE", "账号上还有 %d 个包在运行", active)
		}
		_, err := t.Exec(`DELETE FROM accounts WHERE id=?`, id)
		return err
	})
}

func accountSecrets(q querier, id string) (engine.Account, error) {
	var a engine.Account
	err := q.QueryRow(`SELECT id, engine, kind, label, auth_dir, api_key, config, base_url, provider, protocol FROM accounts WHERE id=?`, id).
		Scan(&a.ID, &a.Engine, &a.Kind, &a.Label, &a.AuthDir, &a.APIKey, &a.Config, &a.BaseURL, &a.Provider, &a.Protocol)
	if err == sql.ErrNoRows {
		return a, errf("NOT_FOUND", "账号 %s 不存在", id)
	}
	return a, err
}

// EngineAccount returns the credential context of an account for the launch layer and the login command.
func (k *Kernel) EngineAccount(id string) (engine.Account, error) {
	var a engine.Account
	err := k.read(func() (err error) { a, err = accountSecrets(k.db, id); return })
	return a, err
}

func (k *Kernel) Account(id string) (*Account, error) {
	accounts, err := k.Accounts()
	if err != nil {
		return nil, err
	}
	for _, a := range accounts {
		if a.ID == id {
			return a, nil
		}
	}
	return nil, errf("NOT_FOUND", "账号 %s 不存在", id)
}

func (k *Kernel) Accounts() ([]*Account, error) {
	out := []*Account{}
	err := k.read(func() error {
		now := k.ms()
		rows, err := k.db.Query(`SELECT a.id, a.engine, a.kind, a.label, a.auth_dir, a.api_key<>'', a.config<>'', a.base_url, a.provider, a.protocol, a.enabled, a.ready, a.ready_reason,
			COALESCE(a.checked_at,0), COALESCE(a.paused_until,0), a.pause_reason,
			(SELECT COUNT(*) FROM attempts t WHERE t.account_id=a.id AND t.state IN (?,?)),
			a.balance_usd, a.balance_at, a.alert_below_usd, a.quota, COALESCE(a.quota_checked_at,0), a.quota_error
			FROM accounts a ORDER BY a.created_at, a.id`, StateLaunch, StateRunning)
		if err != nil {
			return err
		}
		settings := map[string]usageSettings{}
		for rows.Next() {
			a := &Account{}
			var s usageSettings
			var quotaText, quotaError string
			var quotaChecked int64
			if err := rows.Scan(&a.ID, &a.Engine, &a.Kind, &a.Label, &a.AuthDir, &a.HasAPIKey, &a.HasConfig, &a.BaseURL, &a.Provider, &a.Protocol, &a.Enabled, &a.Ready, &a.ReadyReason,
				&a.CheckedAt, &a.PausedUntil, &a.PauseReason, &a.Running,
				&s.balance, &s.balanceAt, &s.alert, &quotaText, &quotaChecked, &quotaError); err != nil {
				rows.Close()
				return err
			}
			if a.PausedUntil <= now {
				a.PausedUntil, a.PauseReason = 0, ""
			}
			if supportsQuota(a.Engine, a.Kind) {
				a.Quota = quotaView(quotaText, quotaChecked, quotaError, k.now())
			}
			if a.Kind == "api" {
				settings[a.ID] = s
			}
			out = append(out, a)
		}
		if err := rows.Close(); err != nil {
			return err
		}
		if err := rows.Err(); err != nil {
			return err
		}
		// The usage sums run after the account rows are closed: the database
		// has a single connection.
		at := k.now()
		for _, a := range out {
			s, ok := settings[a.ID]
			if !ok {
				continue
			}
			if a.Usage, err = accountUsage(k.db, a.ID, s, at); err != nil {
				return err
			}
		}
		return nil
	})
	return out, err
}

// CheckAccounts recomputes readiness from the credential material on disk.
// Dispatch only ever reads the stored answer, so it never touches the disk.
func (k *Kernel) CheckAccounts(ids ...string) {
	if k.check == nil {
		return
	}
	var accounts []engine.Account
	_ = k.read(func() error {
		all, err := queryStrings(k.db, `SELECT id FROM accounts ORDER BY id`)
		if err != nil {
			return err
		}
		for _, id := range all {
			if len(ids) > 0 && !contains(ids, id) {
				continue
			}
			if a, err := accountSecrets(k.db, id); err == nil {
				accounts = append(accounts, a)
			}
		}
		return nil
	})
	for _, a := range accounts {
		ready, reason := k.check(a)
		k.report("account-check", a.ID, func(t *tx) error {
			var was int
			var wasReason string
			if err := t.QueryRow(`SELECT ready, ready_reason FROM accounts WHERE id=?`, a.ID).Scan(&was, &wasReason); err != nil {
				return nil
			}
			if _, err := t.Exec(`UPDATE accounts SET ready=?, ready_reason=?, checked_at=? WHERE id=?`, b2i(ready), reason, t.now, a.ID); err != nil {
				return err
			}
			if was == b2i(ready) {
				return nil
			}
			label := a.Label
			if label == "" {
				label = a.ID
			}
			message := fmt.Sprintf("账号「%s」已就绪", label)
			if !ready {
				message = fmt.Sprintf("账号「%s」未就绪：%s", label, reason)
			}
			if err := t.accountEvent(message); err != nil {
				return err
			}
			return t.dispatch()
		})
	}
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// PauseAccount takes an account out of routing until the given time.
func (k *Kernel) PauseAccount(id string, until time.Time, reason string) (*Account, error) {
	err := k.write(func(t *tx) error {
		if _, err := accountSecrets(t, id); err != nil {
			return err
		}
		if until.UnixMilli() <= t.now {
			return errf("INVALID", "暂停的截止时间必须在将来")
		}
		if reason == "" {
			reason = "手动暂停"
		}
		_, err := t.Exec(`UPDATE accounts SET paused_until=?, pause_reason=? WHERE id=?`, until.UnixMilli(), reason, id)
		return err
	})
	if err != nil {
		return nil, err
	}
	return k.Account(id)
}

// ResumeAccount lifts a pause and resets the limit ladder.
func (k *Kernel) ResumeAccount(id string) (*Account, error) {
	err := k.write(func(t *tx) error {
		if _, err := accountSecrets(t, id); err != nil {
			return err
		}
		if _, err := t.Exec(`UPDATE accounts SET paused_until=NULL, pause_reason='', limit_level=0, limit_at=NULL WHERE id=?`, id); err != nil {
			return err
		}
		return t.dispatch()
	})
	if err != nil {
		return nil, err
	}
	return k.Account(id)
}

// WorkerInput creates or updates a routing candidate. Unset fields keep their value.
type WorkerInput struct {
	ID           string   `json:"id"`
	Engine       string   `json:"engine,omitempty"`
	Model        string   `json:"model,omitempty"`
	Effort       *string  `json:"effort,omitempty"`
	Intelligence *float64 `json:"intelligence,omitempty"`
	MaxParallel  *int     `json:"maxParallel,omitempty"`
	Enabled      *bool    `json:"enabled,omitempty"`
	Accounts     []string `json:"accounts,omitempty"`
	Description  *string  `json:"description,omitempty"`
}

func (k *Kernel) SetWorker(in WorkerInput) (*Worker, error) {
	if !idPattern.MatchString(in.ID) {
		return nil, errf("INVALID", "候选 ID %q 不合法", in.ID)
	}
	if isDebater(in.ID) && in.Intelligence != nil && *in.Intelligence != 0 {
		return nil, errf("INVALID", "对谈人不参与选路，不需要能力分")
	}
	err := k.write(func(t *tx) error {
		var engineKind string
		err := t.QueryRow(`SELECT engine FROM workers WHERE id=?`, in.ID).Scan(&engineKind)
		if err == sql.ErrNoRows {
			if !engine.Known(in.Engine) {
				return errf("INVALID", "新候选需要引擎，可用：%s", strings.Join(engine.Kinds(), "、"))
			}
			if in.Model == "" {
				return errf("INVALID", "新候选需要模型")
			}
			if len(in.Accounts) == 0 {
				return errf("INVALID", "新候选至少绑定一个账号")
			}
			var position int
			if err := t.QueryRow(`SELECT COALESCE(MAX(position),0)+1 FROM workers`).Scan(&position); err != nil {
				return err
			}
			if _, err := t.Exec(`INSERT INTO workers(id, engine, model, position) VALUES(?,?,?,?)`, in.ID, in.Engine, in.Model, position); err != nil {
				return err
			}
			engineKind = in.Engine
		} else if err != nil {
			return err
		} else {
			if in.Engine != "" && in.Engine != engineKind {
				if !isDebater(in.ID) {
					return errf("INVALID", "候选 %s 的引擎是 %s，不能改成 %s；请新建候选", in.ID, engineKind, in.Engine)
				}
				if !engine.Known(in.Engine) {
					return errf("INVALID", "不支持的引擎 %q，可用：%s", in.Engine, strings.Join(engine.Kinds(), "、"))
				}
				// The old engine's model and accounts mean nothing on the new one.
				if in.Model == "" || len(in.Accounts) == 0 {
					return errf("INVALID", "对谈人换引擎时需要同时指定模型和该引擎的账号")
				}
				if _, err := t.Exec(`UPDATE workers SET engine=? WHERE id=?`, in.Engine, in.ID); err != nil {
					return err
				}
				engineKind = in.Engine
			}
			if in.Model != "" {
				if _, err := t.Exec(`UPDATE workers SET model=? WHERE id=?`, in.Model, in.ID); err != nil {
					return err
				}
			}
		}
		if in.Effort != nil {
			if _, err := t.Exec(`UPDATE workers SET effort=? WHERE id=?`, *in.Effort, in.ID); err != nil {
				return err
			}
		}
		if in.Description != nil {
			if _, err := t.Exec(`UPDATE workers SET description=? WHERE id=?`, *in.Description, in.ID); err != nil {
				return err
			}
		}
		if in.Intelligence != nil {
			if *in.Intelligence != 0 && !validIntelligence(*in.Intelligence) {
				return errf("INVALID", "能力分只能为 0（未评分）或 1–10，步长 0.5")
			}
			if _, err := t.Exec(`UPDATE workers SET intelligence=? WHERE id=?`, *in.Intelligence, in.ID); err != nil {
				return err
			}
		}
		if in.MaxParallel != nil {
			if *in.MaxParallel < 0 {
				return errf("INVALID", "并行上限不能为负")
			}
			if _, err := t.Exec(`UPDATE workers SET max_parallel=? WHERE id=?`, *in.MaxParallel, in.ID); err != nil {
				return err
			}
		}
		if in.Enabled != nil {
			if _, err := t.Exec(`UPDATE workers SET enabled=? WHERE id=?`, b2i(*in.Enabled), in.ID); err != nil {
				return err
			}
		}
		if in.Accounts != nil {
			if _, err := t.Exec(`DELETE FROM worker_accounts WHERE worker_id=?`, in.ID); err != nil {
				return err
			}
			for i, account := range in.Accounts {
				a, err := accountSecrets(t, account)
				if err != nil {
					return err
				}
				if a.Engine != engineKind {
					return errf("INVALID", "账号 %s 属于引擎 %s，候选 %s 用的是 %s", account, a.Engine, in.ID, engineKind)
				}
				if _, err := t.Exec(`INSERT INTO worker_accounts(worker_id, account_id, position) VALUES(?,?,?)`, in.ID, account, i); err != nil {
					return err
				}
			}
		}
		if engineKind == "dsh" {
			if err := k.validateDshWorker(t, in.ID); err != nil {
				return err
			}
		}
		return t.dispatch()
	})
	if err != nil {
		return nil, err
	}
	return k.Worker(in.ID)
}

func (k *Kernel) RemoveWorker(id string) error {
	return k.write(func(t *tx) error {
		res, err := t.Exec(`DELETE FROM workers WHERE id=?`, id)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return errf("NOT_FOUND", "候选 %s 不存在", id)
		}
		return nil
	})
}

func (k *Kernel) Worker(id string) (*Worker, error) {
	workers, err := k.Workers()
	if err != nil {
		return nil, err
	}
	for _, w := range workers {
		if w.ID == id {
			return w, nil
		}
	}
	return nil, errf("NOT_FOUND", "候选 %s 不存在", id)
}

// Workers lists the candidates with their load and whether routing can use them right now.
func (k *Kernel) Workers() ([]*Worker, error) {
	out := []*Worker{}
	err := k.write(func(t *tx) error {
		rt, err := t.loadRouting()
		if err != nil {
			return err
		}
		live := map[string]*routeWorker{}
		for _, w := range rt.Workers {
			live[w.ID] = w
		}
		rows, err := t.Query(`SELECT id, engine, model, effort, intelligence, max_parallel, enabled, description FROM workers ORDER BY position, id`)
		if err != nil {
			return err
		}
		for rows.Next() {
			w := &Worker{Accounts: []string{}}
			if err := rows.Scan(&w.ID, &w.Engine, &w.Model, &w.Effort, &w.Intelligence, &w.MaxParallel, &w.Enabled, &w.Description); err != nil {
				rows.Close()
				return err
			}
			w.Role = "worker"
			if isDebater(w.ID) {
				w.Role = "debater"
			}
			out = append(out, w)
		}
		rows.Close()
		for _, w := range out {
			if w.Accounts, err = queryStrings(t, `SELECT account_id FROM worker_accounts WHERE worker_id=? ORDER BY position`, w.ID); err != nil {
				return err
			}
			if w.Accounts == nil {
				w.Accounts = []string{}
			}
			samples := rt.WorkerStats[w.ID]
			if samples == nil {
				samples = &statBuckets{}
			}
			w.Stats = samples.view()
			rw := live[w.ID]
			switch {
			case !w.Enabled:
				w.Reason = "已停用"
			case rw == nil || len(rw.Accounts) == 0:
				w.Reason = "没有绑定账号"
			default:
				w.Running = rw.Running
				for _, a := range rw.Accounts {
					if !a.Ready {
						if w.Reason == "" {
							w.Reason = a.Reason
						}
					} else if quota.Factor(a.Snapshot, w.Model, k.now()) <= 0 {
						if w.Reason == "" {
							name := a.Account.Label
							if name == "" {
								name = a.Account.ID
							}
							w.Reason = quotaExhaustedReason(name, a.Snapshot, w.Model, k.now())
						}
					} else {
						w.Available = true
					}
				}
				if w.Available {
					w.Reason = ""
				}
			}
			if !isDebater(w.ID) && w.Available && w.Intelligence == 0 {
				w.Reason = "未评分：只在包指定它时使用；用 weaver worker set <候选> --intelligence <1-10> 评分"
			}
		}
		return nil
	})
	return out, err
}

// Settings the kernel understands, with their defaults.
var settingDefaults = map[string]string{
	"archive_after_days":    "7",
	"dialogue_rounds":       "1",
	"max_parallel":          fmt.Sprint(defaultMaxParallel),
	"quota_refresh_minutes": fmt.Sprint(int(defaultQuotaInterval.Minutes())),
	"stall_seconds":         fmt.Sprint(int(defaultStall.Seconds())),
	"resident":              "on",
}

func (k *Kernel) Settings() (map[string]string, error) {
	out := map[string]string{}
	for key, value := range settingDefaults {
		out[key] = value
	}
	err := k.read(func() error {
		rows, err := k.db.Query(`SELECT key, value FROM settings`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var key, value string
			if err := rows.Scan(&key, &value); err != nil {
				return err
			}
			// Old databases keep rows for retired settings; only known ones count.
			if _, known := settingDefaults[key]; known {
				out[key] = value
			}
		}
		return rows.Err()
	})
	return out, err
}

// Setting returns one setting or its default.
func (k *Kernel) Setting(key string) string {
	all, err := k.Settings()
	if err != nil {
		return settingDefaults[key]
	}
	return all[key]
}

func (k *Kernel) SetSetting(key, value string) error {
	switch key {
	case "dialogue_rounds":
		if value != "1" && value != "2" && value != "3" {
			return errf("INVALID", "dialogue_rounds 只能是 1、2、3")
		}
	case "archive_after_days":
		switch value {
		case "0", "1", "3", "7", "30":
		default:
			return errf("INVALID", "archive_after_days 只能是 0、1、3、7、30")
		}
	case "max_parallel":
		if n, err := strconv.Atoi(value); err != nil || n < 0 {
			return errf("INVALID", "max_parallel 需要非负整数，0 表示不限")
		}
	case "stall_seconds":
		if n, err := strconv.Atoi(value); err != nil || n <= 0 {
			return errf("INVALID", "stall_seconds 需要正整数")
		}
	case "quota_refresh_minutes":
		if n, err := strconv.Atoi(value); err != nil || n < 1 || n > 1440 {
			return errf("INVALID", "quota_refresh_minutes 需要 1 到 1440 之间的整数（分钟）")
		}
	case "resident":
		if value != "on" && value != "off" {
			return errf("INVALID", "%s 只能是 on 或 off", key)
		}
	default:
		keys := make([]string, 0, len(settingDefaults))
		for key := range settingDefaults {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		return errf("INVALID", "未知设置 %q，可用：%s", key, strings.Join(keys, "、"))
	}
	return k.write(func(t *tx) error {
		if _, err := t.Exec(`INSERT INTO settings(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, key, value); err != nil {
			return err
		}
		return t.dispatch()
	})
}

// ImportResult lists what a legacy import added.
type ImportResult struct {
	Accounts []string `json:"accounts"`
	Workers  []string `json:"workers"`
	Skipped  []string `json:"skipped"`
}

// ImportLegacy copies accounts and routing candidates from a Weaver 0.7
// database. Credential directories are referenced in place, not copied.
// Imported candidates start unrated.
// Records whose ID already exists are skipped. No task history is imported.
func (k *Kernel) ImportLegacy(path, owner string) (*ImportResult, error) {
	old, err := sql.Open("sqlite", "file:"+path+"?mode=ro")
	if err != nil {
		return nil, err
	}
	defer old.Close()
	engines := map[string]string{}
	rows, err := old.Query(`SELECT id, kind FROM policy_engines`)
	if err != nil {
		return nil, errf("INVALID", "读不到旧库的引擎表：%v", err)
	}
	for rows.Next() {
		var id, kind string
		if err := rows.Scan(&id, &kind); err != nil {
			rows.Close()
			return nil, err
		}
		engines[id] = kind
	}
	rows.Close()

	type legacyChannel struct {
		Engine   string `json:"engine"`
		Kind     string `json:"kind"`
		Label    string `json:"label"`
		Enabled  bool   `json:"enabled"`
		Provider string `json:"provider"`
		Protocol string `json:"protocol"`
		BaseURL  string `json:"baseUrl"`
	}
	type legacySecret struct {
		AuthDir string `json:"authDir"`
		APIKey  string `json:"apiKey"`
		Config  string `json:"config"`
	}
	type account struct {
		in      AccountInput
		enabled bool
	}
	var accounts []account
	rows, err = old.Query(`SELECT c.id, c.body, COALESCE(s.body,'{}') FROM policy_channels c LEFT JOIN channel_secrets s ON s.id=c.id ORDER BY c.position`)
	if err != nil {
		return nil, errf("INVALID", "读不到旧库的账号表：%v", err)
	}
	for rows.Next() {
		var id, body, secretBody string
		if err := rows.Scan(&id, &body, &secretBody); err != nil {
			rows.Close()
			return nil, err
		}
		var c legacyChannel
		var s legacySecret
		if json.Unmarshal([]byte(body), &c) != nil || json.Unmarshal([]byte(secretBody), &s) != nil {
			continue
		}
		kind := engines[c.Engine]
		if kind == "" {
			kind = c.Engine
		}
		accounts = append(accounts, account{enabled: c.Enabled, in: AccountInput{ID: id, Engine: kind, Kind: c.Kind, Label: c.Label, AuthDir: s.AuthDir, APIKey: s.APIKey, Config: s.Config, BaseURL: c.BaseURL, Provider: c.Provider, Protocol: c.Protocol}})
	}
	rows.Close()

	type worker struct {
		id, model, effort, description string
		enabled                        bool
		channels                       []string
		maxParallel                    int
	}
	var workers []worker
	rows, err = old.Query(`SELECT id, enabled, channels, model, effort, COALESCE(description,''), COALESCE(max_parallel,0) FROM policy_workers ORDER BY position`)
	if err != nil {
		return nil, errf("INVALID", "读不到旧库的候选表：%v", err)
	}
	for rows.Next() {
		var w worker
		var channels string
		if err := rows.Scan(&w.id, &w.enabled, &channels, &w.model, &w.effort, &w.description, &w.maxParallel); err != nil {
			rows.Close()
			return nil, err
		}
		_ = json.Unmarshal([]byte(channels), &w.channels)
		workers = append(workers, w)
	}
	rows.Close()

	out := &ImportResult{Accounts: []string{}, Workers: []string{}, Skipped: []string{}}
	err = k.write(func(t *tx) error {
		engineOf := map[string]string{}
		for _, a := range accounts {
			engineOf[a.in.ID] = a.in.Engine
			var n int
			if err := t.QueryRow(`SELECT COUNT(*) FROM accounts WHERE id=?`, a.in.ID).Scan(&n); err != nil {
				return err
			}
			if n > 0 {
				out.Skipped = append(out.Skipped, "账号 "+a.in.ID+"（已存在）")
				continue
			}
			if !engine.Known(a.in.Engine) {
				out.Skipped = append(out.Skipped, "账号 "+a.in.ID+"（引擎 "+a.in.Engine+" 不支持）")
				continue
			}
			if _, err := t.Exec(`INSERT INTO accounts(id, engine, kind, label, auth_dir, api_key, config, base_url, provider, protocol, enabled, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
				a.in.ID, a.in.Engine, a.in.Kind, a.in.Label, a.in.AuthDir, a.in.APIKey, a.in.Config, a.in.BaseURL, a.in.Provider, a.in.Protocol, b2i(a.enabled), t.now); err != nil {
				return err
			}
			out.Accounts = append(out.Accounts, a.in.ID)
		}
		for i, w := range workers {
			var n int
			if err := t.QueryRow(`SELECT COUNT(*) FROM workers WHERE id=?`, w.id).Scan(&n); err != nil {
				return err
			}
			if n > 0 {
				out.Skipped = append(out.Skipped, "候选 "+w.id+"（已存在）")
				continue
			}
			if len(w.channels) == 0 || engineOf[w.channels[0]] == "" {
				out.Skipped = append(out.Skipped, "候选 "+w.id+"（没有可用账号）")
				continue
			}
			if kind := engineOf[w.channels[0]]; !engine.Known(kind) {
				out.Skipped = append(out.Skipped, "候选 "+w.id+"（引擎 "+kind+" 不支持）")
				continue
			}
			if _, err := t.Exec(`INSERT INTO workers(id, engine, model, effort, intelligence, max_parallel, enabled, position, description) VALUES(?,?,?,?,?,?,?,?,?)`,
				w.id, engineOf[w.channels[0]], w.model, w.effort, 0, w.maxParallel, b2i(w.enabled), i+1, w.description); err != nil {
				return err
			}
			for j, channel := range w.channels {
				if _, err := t.Exec(`INSERT OR IGNORE INTO worker_accounts(worker_id, account_id, position) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM accounts WHERE id=?)`, w.id, channel, j, channel); err != nil {
					return err
				}
			}
			out.Workers = append(out.Workers, w.id)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	k.CheckAccounts()
	_ = k.Dispatch()
	return out, nil
}
