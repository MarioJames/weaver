package kernel

import (
	"database/sql"
	"encoding/json"
	"math"
	"sort"
	"strings"
	"time"
)

// Usage is counted from what each run reported: tokens always, and the price
// when the engine gives one (Claude Code does). Runs without a price are
// valued at the hand-entered price of their model on that account: one
// account serves models of different prices. The balance is entered by hand
// too; nothing here calls a vendor's spend API.

// OptionalFloat tells an omitted JSON field apart from an explicit null.
// account.usage.set uses it: absent keeps the stored value, null clears it.
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

// UsagePatch changes one account's usage settings; omitted fields keep their
// stored value. Each entry of Prices replaces the prices of its model; an
// entry without any price removes them.
type UsagePatch struct {
	Balance    OptionalFloat `json:"balance"`
	AlertBelow OptionalFloat `json:"alertBelow"`
	Prices     []ModelPrice  `json:"prices"`
}

func badMoney(v *float64) bool {
	return v != nil && (*v < 0 || math.IsNaN(*v) || math.IsInf(*v, 0))
}

// SetAccountUsage changes the usage settings of an API account. A new balance
// is stamped with the current time; runs from before it are not deducted.
func (k *Kernel) SetAccountUsage(id string, patch UsagePatch) (*Account, error) {
	if badMoney(patch.Balance.Value) {
		return nil, errf("INVALID", "余额需要不小于 0 的数字")
	}
	if badMoney(patch.AlertBelow.Value) {
		return nil, errf("INVALID", "提示线需要不小于 0 的数字")
	}
	for i := range patch.Prices {
		p := &patch.Prices[i]
		p.Model = strings.TrimSpace(p.Model)
		if p.Model == "" {
			return nil, errf("INVALID", "单价要写明模型")
		}
		for _, v := range []*float64{p.Input, p.Output, p.CacheRead, p.CacheWrite} {
			if badMoney(v) {
				return nil, errf("INVALID", "%s 的单价需要不小于 0 的数字", p.Model)
			}
		}
	}
	err := k.write(func(t *tx) error {
		var kind string
		if err := t.QueryRow(`SELECT kind FROM accounts WHERE id=?`, id).Scan(&kind); err == sql.ErrNoRows {
			return errf("NOT_FOUND", "账号 %s 不存在", id)
		} else if err != nil {
			return err
		}
		if kind != "api" {
			return errf("INVALID", "只有 API 账号能配置用量")
		}
		if patch.AlertBelow.Set {
			if _, err := t.Exec(`UPDATE accounts SET alert_below_usd=? WHERE id=?`, nullable(patch.AlertBelow.Value), id); err != nil {
				return err
			}
		}
		if patch.Balance.Set {
			var at any
			if patch.Balance.Value != nil {
				at = t.now
			}
			if _, err := t.Exec(`UPDATE accounts SET balance_usd=?, balance_at=? WHERE id=?`, nullable(patch.Balance.Value), at, id); err != nil {
				return err
			}
		}
		for _, p := range patch.Prices {
			if !p.UsagePrices.set() {
				if _, err := t.Exec(`DELETE FROM model_prices WHERE account_id=? AND model=?`, id, p.Model); err != nil {
					return err
				}
				continue
			}
			if _, err := t.Exec(`INSERT INTO model_prices(account_id, model, input_usd, output_usd, cache_read_usd, cache_write_usd) VALUES(?,?,?,?,?,?)
				ON CONFLICT(account_id, model) DO UPDATE SET input_usd=excluded.input_usd, output_usd=excluded.output_usd,
				cache_read_usd=excluded.cache_read_usd, cache_write_usd=excluded.cache_write_usd`,
				id, p.Model, nullable(p.Input), nullable(p.Output), nullable(p.CacheRead), nullable(p.CacheWrite)); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return k.Account(id)
}

func nullable(v *float64) any {
	if v == nil {
		return nil
	}
	return *v
}

// usageSettings is the hand-entered part of an API account's usage.
type usageSettings struct {
	balance, alert sql.NullFloat64
	balanceAt      sql.NullInt64
}

func floatPtr(v sql.NullFloat64) *float64 {
	if !v.Valid {
		return nil
	}
	f := v.Float64
	return &f
}

func (p UsagePrices) set() bool {
	return p.Input != nil || p.Output != nil || p.CacheRead != nil || p.CacheWrite != nil
}

// cost values tokens at prices per million; a price left empty counts as 0.
func (p UsagePrices) cost(in, out, cacheRead, cacheWrite int64) float64 {
	price := func(v *float64) float64 {
		if v == nil {
			return 0
		}
		return *v
	}
	return (float64(in)*price(p.Input) + float64(out)*price(p.Output) +
		float64(cacheRead)*price(p.CacheRead) + float64(cacheWrite)*price(p.CacheWrite)) / 1e6
}

// usageTotals sums the runs of one account that finished at or after since,
// in total and per model. A run counts when it reported tokens or a price; a
// run without a reported price is valued at its model's prices.
func usageTotals(q querier, id string, since int64, prices map[string]UsagePrices) (UsageTotals, map[string]UsageTotals, error) {
	var total UsageTotals
	byModel := map[string]UsageTotals{}
	rows, err := q.Query(`SELECT model, COUNT(*), COALESCE(SUM(input_tokens),0), COALESCE(SUM(output_tokens),0),
		COALESCE(SUM(cache_read_tokens),0), COALESCE(SUM(cache_write_tokens),0), SUM(cost_usd), COUNT(cost_usd),
		COALESCE(SUM(CASE WHEN cost_usd IS NULL THEN input_tokens END),0), COALESCE(SUM(CASE WHEN cost_usd IS NULL THEN output_tokens END),0),
		COALESCE(SUM(CASE WHEN cost_usd IS NULL THEN cache_read_tokens END),0), COALESCE(SUM(CASE WHEN cost_usd IS NULL THEN cache_write_tokens END),0)
		FROM attempts WHERE account_id=? AND finished_at>=?
		AND (input_tokens+output_tokens+cache_read_tokens+cache_write_tokens>0 OR cost_usd IS NOT NULL)
		GROUP BY model`, id, since)
	if err != nil {
		return total, nil, err
	}
	defer rows.Close()
	totalCost, totalKnown := 0.0, false
	for rows.Next() {
		var model string
		var u UsageTotals
		var reported sql.NullFloat64
		var reportedRuns int
		var in, out, cacheRead, cacheWrite int64 // tokens of runs without a reported price
		if err := rows.Scan(&model, &u.Runs, &u.InputTokens, &u.OutputTokens, &u.CacheReadTokens, &u.CacheWriteTokens,
			&reported, &reportedRuns, &in, &out, &cacheRead, &cacheWrite); err != nil {
			return total, nil, err
		}
		cost, known := reported.Float64, reportedRuns > 0
		if rest := u.Runs - reportedRuns; rest > 0 {
			if p := prices[model]; p.set() {
				cost += p.cost(in, out, cacheRead, cacheWrite)
				known = true
			} else {
				u.Unpriced = rest
			}
		}
		if known {
			u.Cost = moneyPtr(moneyRound(cost))
			totalCost += cost
			totalKnown = true
		}
		byModel[model] = u
		total.Runs += u.Runs
		total.InputTokens += u.InputTokens
		total.OutputTokens += u.OutputTokens
		total.CacheReadTokens += u.CacheReadTokens
		total.CacheWriteTokens += u.CacheWriteTokens
		total.Unpriced += u.Unpriced
	}
	if totalKnown {
		total.Cost = moneyPtr(moneyRound(totalCost))
	}
	return total, byModel, rows.Err()
}

// modelPrices reads the prices an account has per model.
func modelPrices(q querier, id string) (map[string]UsagePrices, error) {
	rows, err := q.Query(`SELECT model, input_usd, output_usd, cache_read_usd, cache_write_usd FROM model_prices WHERE account_id=?`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]UsagePrices{}
	for rows.Next() {
		var model string
		var in, o, cr, cw sql.NullFloat64
		if err := rows.Scan(&model, &in, &o, &cr, &cw); err != nil {
			return nil, err
		}
		out[model] = UsagePrices{Input: floatPtr(in), Output: floatPtr(o), CacheRead: floatPtr(cr), CacheWrite: floatPtr(cw)}
	}
	return out, rows.Err()
}

// accountUsage builds the usage view of an API account at now. Its models are
// those with prices, those of the candidates using the account, and those
// that ran this month.
func accountUsage(q querier, id string, s usageSettings, now time.Time) (*AccountUsage, error) {
	prices, err := modelPrices(q, id)
	if err != nil {
		return nil, err
	}
	u := &AccountUsage{Balance: floatPtr(s.balance), AlertBelow: floatPtr(s.alert), Models: []ModelUsage{}}
	local := now.Local()
	monthStart := time.Date(local.Year(), local.Month(), 1, 0, 0, 0, 0, time.Local)
	month, byModel, err := usageTotals(q, id, monthStart.UnixMilli(), prices)
	if err != nil {
		return nil, err
	}
	u.Month = month
	candidates, err := queryStrings(q, `SELECT DISTINCT w.model FROM workers w JOIN worker_accounts wa ON wa.worker_id=w.id WHERE wa.account_id=?`, id)
	if err != nil {
		return nil, err
	}
	models := map[string]bool{}
	for _, m := range candidates {
		models[m] = true
	}
	for m := range prices {
		models[m] = true
	}
	for m := range byModel {
		models[m] = true
	}
	names := make([]string, 0, len(models))
	for m := range models {
		if strings.TrimSpace(m) != "" {
			names = append(names, m)
		}
	}
	sort.Strings(names)
	for _, m := range names {
		t := byModel[m]
		u.Models = append(u.Models, ModelUsage{Model: m, Prices: prices[m], Runs: t.Runs, Cost: t.Cost, Unpriced: t.Unpriced})
	}
	if !s.balance.Valid {
		return u, nil
	}
	u.BalanceAt = s.balanceAt.Int64
	since, _, err := usageTotals(q, id, s.balanceAt.Int64, prices)
	if err != nil {
		return nil, err
	}
	if since.Unpriced > 0 {
		// Some spend has no price yet: an estimate would only look precise.
		return u, nil
	}
	spent := 0.0
	if since.Cost != nil {
		spent = *since.Cost
	}
	u.SpentSinceBalance = moneyPtr(spent)
	u.Remaining = moneyPtr(moneyRound(s.balance.Float64 - spent))
	u.Low = s.alert.Valid && *u.Remaining < s.alert.Float64
	return u, nil
}

func moneyPtr(v float64) *float64 { return &v }

// moneyRound keeps sums that go through float64 from showing noise.
func moneyRound(v float64) float64 { return math.Round(v*1e6) / 1e6 }
