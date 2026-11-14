package kernel

import (
	"fmt"
	"strings"

	"github.com/MarioJames/weaver/internal/engine"
)

// routeWorker is one routing candidate with its live load.
type routeWorker struct {
	ID          string
	Engine      string
	Model       string
	Effort      string
	Weight      int
	MaxParallel int
	Running     int
	Accounts    []*routeAccount
}

type routeAccount struct {
	Account engine.Account
	Ready   bool
	Reason  string
	Running int
}

// routing is a snapshot of the candidates; pick mutates the load counters so
// a batch of packages spreads across candidates within one dispatch.
type routing struct {
	Workers []*routeWorker
	Active  int
	Cap     int
}

// pick selects the candidate with the least (running+1)/weight among those
// that are allowed and have a ready account; ties go to the earlier candidate.
// A package pinned to a worker uses it regardless of weight. A package pinned
// to an engine chooses among that engine's candidates; when all of them have
// weight 0 they count as equal.
func (r *routing) pick(pinWorker, pinEngine string) (*routeWorker, *routeAccount, string) {
	if r.Cap > 0 && r.Active >= r.Cap {
		return nil, nil, fmt.Sprintf("已达到并行上限 %d，等待在跑的包结束", r.Cap)
	}
	var pool []*routeWorker
	for _, w := range r.Workers {
		switch {
		case pinWorker != "":
			if w.ID == pinWorker {
				pool = append(pool, w)
			}
		case pinEngine != "":
			if w.Engine == pinEngine {
				pool = append(pool, w)
			}
		default:
			if w.Weight > 0 {
				pool = append(pool, w)
			}
		}
	}
	if len(pool) == 0 {
		switch {
		case pinWorker != "":
			return nil, nil, fmt.Sprintf("候选 %s 不存在或已停用", pinWorker)
		case pinEngine != "":
			return nil, nil, fmt.Sprintf("引擎 %s 没有启用的候选", pinEngine)
		}
		return nil, nil, "没有权重大于 0 的候选"
	}
	equal := pinWorker != ""
	if pinEngine != "" {
		equal = true
		for _, w := range pool {
			if w.Weight > 0 {
				equal = false
			}
		}
	}
	var best *routeWorker
	var bestAccount *routeAccount
	var bestScore float64
	var reasons []string
	for _, w := range pool {
		weight := w.Weight
		if equal {
			weight = 1
		}
		if weight <= 0 {
			continue
		}
		if w.MaxParallel > 0 && w.Running >= w.MaxParallel {
			reasons = append(reasons, fmt.Sprintf("%s 已达到并行上限 %d", w.ID, w.MaxParallel))
			continue
		}
		var account *routeAccount
		for _, a := range w.Accounts {
			if a.Ready && (account == nil || a.Running < account.Running) {
				account = a
			}
		}
		if account == nil {
			why := "没有绑定账号"
			if len(w.Accounts) > 0 {
				why = w.Accounts[0].Reason
			}
			reasons = append(reasons, fmt.Sprintf("%s：%s", w.ID, why))
			continue
		}
		score := float64(w.Running+1) / float64(weight)
		if best == nil || score < bestScore {
			best, bestAccount, bestScore = w, account, score
		}
	}
	if best == nil {
		return nil, nil, "没有就绪的候选（" + strings.Join(reasons, "；") + "）"
	}
	best.Running++
	bestAccount.Running++
	r.Active++
	return best, bestAccount, ""
}
