package kernel

import (
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/MarioJames/weaver/internal/engine"
	"github.com/MarioJames/weaver/internal/quota"
)

// routeWorker is one routing candidate with its live load.
type routeWorker struct {
	ID           string
	Engine       string
	Model        string
	Effort       string
	Intelligence float64
	MaxParallel  int
	Running      int
	Accounts     []*routeAccount
	Stats        *statBuckets
}
type routeAccount struct {
	Account  engine.Account
	Ready    bool
	Reason   string
	Running  int
	Snapshot *quota.Snapshot
}

// routing mutates counters so a batch spreads within one dispatch.
type routing struct {
	Now         time.Time
	Workers     []*routeWorker
	Active      int
	Cap         int
	Stats       *statSample
	WorkerStats map[string]*statBuckets
}

func (r *routing) pick(pinWorker, pinEngine string, requirement float64) (*routeWorker, *routeAccount, string) {
	if r.Cap > 0 && r.Active >= r.Cap {
		return nil, nil, fmt.Sprintf("已达到并行上限 %d，等待在跑的包结束", r.Cap)
	}
	var best *routeWorker
	var bestAccount *routeAccount
	var bestStats PerformanceStats
	var bestScore, bestQuota float64
	now := r.Now
	if now.IsZero() {
		now = time.Now()
	}
	var reasons []string
	eligible := 0
	for _, w := range r.Workers {
		if pinWorker != "" {
			if w.ID != pinWorker {
				continue
			}
		} else {
			// Dialogue seats serve only packages pinned to them.
			if isDebater(w.ID) {
				continue
			}
			if pinEngine != "" && w.Engine != pinEngine {
				continue
			}
			if w.Intelligence == 0 {
				reasons = append(reasons, w.ID+"：未评分")
				continue
			}
			if w.Intelligence < requirement {
				reasons = append(reasons, fmt.Sprintf("%s：能力 %g，低于需求 %g", w.ID, w.Intelligence, requirement))
				continue
			}
		}
		if w.MaxParallel > 0 && w.Running >= w.MaxParallel {
			reasons = append(reasons, fmt.Sprintf("%s 已达到并行上限 %d", w.ID, w.MaxParallel))
			continue
		}
		var account *routeAccount
		var accountQuota float64
		var accountReasons []string
		for _, a := range w.Accounts {
			factor := quota.Factor(a.Snapshot, w.Model, now)
			if factor <= 0 {
				name := a.Account.Label
				if name == "" {
					name = a.Account.ID
				}
				accountReasons = append(accountReasons, quotaExhaustedReason(name, a.Snapshot, w.Model, now))
				continue
			}
			if !a.Ready {
				accountReasons = append(accountReasons, a.Reason)
				continue
			}
			if account == nil || factor > accountQuota || (factor == accountQuota && a.Running < account.Running) {
				account = a
				accountQuota = factor
			}
		}
		if account == nil {
			why := "没有绑定账号"
			if len(accountReasons) > 0 {
				why = strings.Join(accountReasons, "、")
			}
			reasons = append(reasons, w.ID+"："+why)
			continue
		}
		eligible++
		stats := w.Stats.performance(requirement, r.Stats)
		score := stats.FirstAcceptanceRate * accountQuota / (math.Max(stats.MedianSeconds, 0.001) * float64(w.Running+1))
		if best == nil || score > bestScore {
			best, bestAccount, bestStats, bestScore, bestQuota = w, account, stats, score, accountQuota
		}
	}
	if best == nil {
		if pinWorker != "" {
			return nil, nil, fmt.Sprintf("候选 %s 不存在、已停用或不可用（%s）", pinWorker, strings.Join(reasons, "；"))
		}
		return nil, nil, fmt.Sprintf("没有 intelligence ≥ %g 的可用候选（%s）", requirement, strings.Join(reasons, "；"))
	}
	note := fmt.Sprintf("包指定了候选 %s", best.ID)
	if pinWorker == "" {
		note = fmt.Sprintf("需求 %g → %s（能力 %g）：首次采纳 %.0f%%（%d 次）、中位耗时 %.0f 分、额度系数 %.2f", requirement, best.ID, best.Intelligence, bestStats.FirstAcceptanceRate*100, bestStats.Samples, bestStats.MedianSeconds/60, bestQuota)
		if eligible > 1 {
			note += fmt.Sprintf("；另有 %d 个够格候选得分较低", eligible-1)
		}
	}
	if runes := []rune(note); len(runes) > 200 {
		note = string(runes[:199]) + "…"
	}
	best.Running++
	bestAccount.Running++
	r.Active++
	return best, bestAccount, note
}
