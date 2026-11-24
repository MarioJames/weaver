package quota

import (
	"math"
	"testing"
	"time"
)

func TestFactor(t *testing.T) {
	now := testNow
	window := func(scope, model string, used float64, resets time.Time, duration int) Window {
		return Window{Scope: scope, Model: model, UsedPercent: used, ResetsAt: resets.UnixMilli(), DurationMinutes: duration}
	}
	tests := []struct {
		name     string
		snapshot *Snapshot
		model    string
		want     float64
	}{
		{"nil snapshot", nil, "any", 1},
		{"no windows", &Snapshot{Status: statusUnknown}, "any", 1},
		{"exhausted", &Snapshot{Status: statusExhausted}, "any", 0},
		{"exhausted with expired windows", &Snapshot{Status: statusExhausted, Windows: []Window{
			window(scopeAccount, "", 100, now.Add(-time.Hour), 300),
		}}, "any", 1},
		{"exhausted model ignores other models", &Snapshot{Status: statusExhausted, Windows: []Window{
			window(scopeModel, "sonnet", 100, now.Add(time.Hour), 300),
		}}, "opus", 1},
		{"server restriction with unexhausted meters", &Snapshot{Status: statusExhausted, Windows: []Window{
			window(scopeAccount, "", 10, now.Add(time.Hour), 300),
		}}, "any", 0},
		{"account over pace", &Snapshot{Status: statusAvailable, Windows: []Window{
			window(scopeAccount, "", 90, now.Add(4*time.Hour), 300),
		}}, "any", 0.125},
		{"account under pace", &Snapshot{Status: statusAvailable, Windows: []Window{
			window(scopeAccount, "", 50, now.Add(3*time.Hour), 300),
		}}, "any", 0.5 / 0.6},
		{"account ahead of pace", &Snapshot{Status: statusAvailable, Windows: []Window{
			window(scopeAccount, "", 10, now.Add(time.Hour), 300),
		}}, "any", 1},
		{"used up", &Snapshot{Status: statusAvailable, Windows: []Window{
			window(scopeAccount, "", 100, now.Add(time.Hour), 300),
		}}, "any", 0},
		{"unknown reset", &Snapshot{Status: statusAvailable, Windows: []Window{
			window(scopeAccount, "", 99, time.Unix(0, 0), 300),
		}}, "any", 1},
		{"unknown duration", &Snapshot{Status: statusAvailable, Windows: []Window{
			window(scopeAccount, "", 99, now.Add(time.Minute), 0),
		}}, "any", 1},
		{"expired window ignored", &Snapshot{Status: statusAvailable, Windows: []Window{
			window(scopeAccount, "", 100, now.Add(-time.Minute), 300),
		}}, "any", 1},
		{"model substring matches case-insensitively", &Snapshot{Status: statusAvailable, Windows: []Window{
			window(scopeModel, "claude-opus-4", 50, now.Add(4*time.Hour), 300),
		}}, "OPUS", 0.5 / 0.8},
		{"model substring other direction", &Snapshot{Status: statusAvailable, Windows: []Window{
			window(scopeModel, "opus", 50, now.Add(4*time.Hour), 300),
		}}, "claude-opus-4-1", 0.5 / 0.8},
		{"model mismatch ignored", &Snapshot{Status: statusAvailable, Windows: []Window{
			window(scopeModel, "claude-opus", 99, now.Add(time.Hour), 300),
		}}, "gpt-5", 1},
		{"empty model ignores model windows", &Snapshot{Status: statusAvailable, Windows: []Window{
			window(scopeModel, "claude-opus", 99, now.Add(time.Hour), 300),
		}}, "", 1},
		{"minimum across account and model", &Snapshot{Status: statusAvailable, Windows: []Window{
			window(scopeAccount, "", 20, now.Add(4*time.Hour), 300),
			window(scopeModel, "gpt-5-codex", 90, now.Add(4*time.Hour), 300),
		}}, "gpt-5", 0.125},
		{"unknown scope ignored", &Snapshot{Status: statusAvailable, Windows: []Window{
			window(scopeUnknown, "", 99, now.Add(time.Hour), 300),
		}}, "any", 1},
		{"used up with usable credits uses fallback factor", &Snapshot{
			Status:  statusAvailable,
			Windows: []Window{window(scopeAccount, "", 100, now.Add(time.Hour), 10080)},
			Credits: &Credits{HasCredits: true, HasBalance: true, Balance: 500},
		}, "any", creditFallbackFactor},
		{"used up with unlimited credits uses fallback factor", &Snapshot{
			Status:  statusAvailable,
			Windows: []Window{window(scopeAccount, "", 100, now.Add(time.Hour), 10080)},
			Credits: &Credits{Unlimited: true},
		}, "any", creditFallbackFactor},
		{"used up with overage limit reached blocks", &Snapshot{
			Status:  statusExhausted,
			Windows: []Window{window(scopeAccount, "", 100, now.Add(time.Hour), 10080)},
			Credits: &Credits{HasCredits: true, HasBalance: true, Balance: 500, OverageLimitReached: true},
		}, "any", 0},
		{"used up with zero balance blocks", &Snapshot{
			Status:  statusExhausted,
			Windows: []Window{window(scopeAccount, "", 100, now.Add(time.Hour), 10080)},
			Credits: &Credits{HasCredits: true, HasBalance: true, Balance: 0},
		}, "any", 0},
		{"spend control exhausted blocks even with credits", &Snapshot{
			Status:  statusExhausted,
			Windows: []Window{window(scopeAccount, "", 100, now.Add(time.Hour), 10080)},
			Credits: &Credits{HasCredits: true, HasBalance: true, Balance: 500},
		}, "any", 0},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := Factor(tc.snapshot, tc.model, now)
			if math.Abs(got-tc.want) > 1e-9 {
				t.Fatalf("Factor = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestFactorClampsAboveOneHundredPercent(t *testing.T) {
	now := testNow
	snapshot := &Snapshot{Status: statusAvailable, Windows: []Window{{
		Scope: scopeAccount, UsedPercent: 140, ResetsAt: now.Add(time.Hour).UnixMilli(), DurationMinutes: 300,
	}}}
	if got := Factor(snapshot, "", now); got != 0 {
		t.Fatalf("Factor = %v, want 0", got)
	}
}
