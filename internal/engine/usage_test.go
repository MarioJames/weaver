package engine

import "testing"

// Each engine reports usage in its own shape; the outcome must carry what the
// vendor bills: tokens per kind and the engine's own price when it gives one.
func TestNormalizersReportBillableUsage(t *testing.T) {
	cost := func(v float64) *float64 { return &v }
	cases := []struct {
		engine string
		lines  []string
		want   Outcome
	}{
		{
			// dsh reports each step's usage on its own step_end: the run is the sum.
			engine: "dsh",
			lines: []string{
				`{"type":"status","phase":"step_end","usage":{"inputTokens":1000,"outputTokens":200,"cacheReadTokens":3000}}`,
				`{"type":"status","phase":"step_end","usage":{"inputTokens":1000,"outputTokens":200,"cacheReadTokens":3000,"cacheWriteTokens":50}}`,
			},
			want: Outcome{InputTokens: 2000, OutputTokens: 400, CacheReadTokens: 6000, CacheWriteTokens: 50},
		},
		{
			// OpenAI counts cached input inside input_tokens.
			engine: "codex",
			lines:  []string{`{"type":"turn.completed","usage":{"input_tokens":5000,"cached_input_tokens":4000,"output_tokens":300}}`},
			want:   Outcome{InputTokens: 1000, OutputTokens: 300, CacheReadTokens: 4000},
		},
		{
			engine: "claude",
			lines: []string{
				`{"type":"assistant","message":{"usage":{"input_tokens":3,"output_tokens":1},"content":[{"type":"text","text":"hi"}]}}`,
				`{"type":"result","subtype":"success","result":"hi","total_cost_usd":0.42,` +
					`"usage":{"input_tokens":12,"output_tokens":40,"cache_read_input_tokens":9000,"cache_creation_input_tokens":800}}`,
			},
			want: Outcome{InputTokens: 12, OutputTokens: 40, CacheReadTokens: 9000, CacheWriteTokens: 800, CostUSD: cost(0.42)},
		},
		{
			engine: "opencode",
			lines: []string{
				`{"type":"step_finish","part":{"reason":"tool-calls","cost":0.01,"tokens":{"input":5,"output":3,"cache":{"read":7,"write":1}}}}`,
				`{"type":"step_finish","part":{"reason":"stop","cost":0.02,"tokens":{"input":5,"output":3,"cache":{"read":7,"write":0}}}}`,
			},
			want: Outcome{InputTokens: 10, OutputTokens: 6, CacheReadTokens: 14, CacheWriteTokens: 1, CostUSD: cost(0.03)},
		},
	}
	for _, c := range cases {
		n := newNormalizer(c.engine)
		for _, line := range c.lines {
			n.push(line)
		}
		got := n.outcome(false)
		if got.InputTokens != c.want.InputTokens || got.OutputTokens != c.want.OutputTokens ||
			got.CacheReadTokens != c.want.CacheReadTokens || got.CacheWriteTokens != c.want.CacheWriteTokens {
			t.Errorf("%s tokens = %d/%d/%d/%d, want %d/%d/%d/%d", c.engine, got.InputTokens, got.OutputTokens, got.CacheReadTokens, got.CacheWriteTokens,
				c.want.InputTokens, c.want.OutputTokens, c.want.CacheReadTokens, c.want.CacheWriteTokens)
		}
		switch {
		case c.want.CostUSD == nil && got.CostUSD != nil:
			t.Errorf("%s cost = %v, want none", c.engine, *got.CostUSD)
		case c.want.CostUSD != nil && (got.CostUSD == nil || *got.CostUSD-*c.want.CostUSD > 1e-9 || *c.want.CostUSD-*got.CostUSD > 1e-9):
			t.Errorf("%s cost = %v, want %v", c.engine, got.CostUSD, *c.want.CostUSD)
		}
	}
}
