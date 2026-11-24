package quota

import (
	"strings"
	"time"
)

// creditFallbackFactor is returned when included subscription windows are
// exhausted (100%) but the account still has usable overage credits and is not
// globally spend-blocked. It stays positive so dispatch succeeds (e.g. pinned
// debaters or sole accounts) while keeping accounts with remaining included
// subscription quota preferred ahead of overage credits.
const creditFallbackFactor = 0.05

// Factor returns the scheduling quota coefficient in [0, 1]. It compares the
// remaining quota ratio with the remaining time ratio of each participating
// window and returns the smallest coefficient.
func Factor(snapshot *Snapshot, model string, now time.Time) float64 {
	if snapshot == nil {
		return 1
	}
	if snapshot.Status == statusExhausted {
		// A meter can reset after the cached snapshot was read. Only a
		// restriction without an exhausted meter needs a fresh server reading.
		metered := false
		for _, w := range snapshot.Windows {
			if (w.Scope == scopeAccount || w.Scope == scopeModel) && w.UsedPercent >= 100 {
				metered = true
				break
			}
		}
		if !metered {
			return 0
		}
	}
	creditFallback := snapshot.Status != statusExhausted && snapshot.Credits.Usable()
	nowMS := now.UnixMilli()
	model = strings.ToLower(model)
	best := 1.0
	participating := false
	for _, window := range snapshot.Windows {
		switch window.Scope {
		case scopeAccount:
		case scopeModel:
			if model == "" || window.Model == "" {
				continue
			}
			if !modelMatchesWindow(model, window.Model) {
				continue
			}
		default:
			continue
		}
		if window.ResetsAt != 0 && window.ResetsAt <= nowMS {
			continue
		}
		participating = true
		remaining := 1 - window.UsedPercent/100
		if remaining < 0 {
			remaining = 0
		}
		if remaining > 1 {
			remaining = 1
		}
		if remaining == 0 {
			if !creditFallback {
				return 0
			}
			if creditFallbackFactor < best {
				best = creditFallbackFactor
			}
			continue
		}
		coefficient := 1.0
		if window.ResetsAt != 0 && window.DurationMinutes > 0 {
			length := float64(window.DurationMinutes) * 60000
			timeRatio := float64(window.ResetsAt-nowMS) / length
			if timeRatio > 1 {
				timeRatio = 1
			}
			if timeRatio <= 0 {
				continue
			}
			coefficient = remaining / timeRatio
			if coefficient > 1 {
				coefficient = 1
			}
		}
		if coefficient < best {
			best = coefficient
		}
	}
	if !participating {
		return 1
	}
	return best
}

// modelMatchesWindow matches a model name against a window's model label.
// Labels may contain "/" to list multiple model families sharing one quota pool
// (e.g. Antigravity's "claude/gpt" pool).
func modelMatchesWindow(model, windowModel string) bool {
	for _, part := range strings.Split(strings.ToLower(windowModel), "/") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if strings.Contains(part, model) || strings.Contains(model, part) {
			return true
		}
	}
	return false
}
