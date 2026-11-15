package quota

import (
	"strings"
	"time"
)

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
			candidate := strings.ToLower(window.Model)
			if !strings.Contains(candidate, model) && !strings.Contains(model, candidate) {
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
			return 0
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
