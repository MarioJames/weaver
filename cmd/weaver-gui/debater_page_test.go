package main

import (
	"encoding/json"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
)

func debatersTester(t *testing.T, both bool) (*workerRPC, *app, *ui.Tester) {
	w := newWorkerRPC(t)
	// Decode the wire shape to exercise the service role contract.
	raw := `{"id":"debater_a","role":"debater","engine":"codex","model":"gpt-6-astra","effort":"xhigh","intelligence":0,"enabled":true,"available":true,"accounts":["import_codex"]}`
	var seat worker
	if err := json.Unmarshal([]byte(raw), &seat); err != nil {
		t.Fatal(err)
	}
	seat.Accounts = []string{w.f.data.Accounts[1].ID}
	w.f.mu.Lock()
	w.f.data.Workers = append(w.f.data.Workers, seat)
	if both {
		seat.ID, seat.Engine, seat.Model, seat.Effort = "debater_b", "claude", "fable", "max"
		seat.Accounts = []string{w.f.data.Accounts[0].ID}
		seat.Available, seat.Reason = false, "账号已停用"
		w.f.data.Workers = append(w.f.data.Workers, seat)
	}
	w.f.mu.Unlock()
	a := testApp(t, w.f)
	a.page = "候选"
	return w, a, ui.NewTester(a.view, 1440, 1400)
}

func TestDebaterSections(t *testing.T) {
	for _, both := range []bool{false, true} {
		t.Run(map[bool]string{false: "missing", true: "configured"}[both], func(t *testing.T) {
			_, a, tt := debatersTester(t, both)
			for _, w := range a.snapshot.Workers[:6] {
				if _, ok := tt.Find(w.ID + " 能力分"); !ok {
					t.Fatalf("missing execution row %s", w.ID)
				}
			}
			for _, text := range []string{"6 个候选", "甲方", "乙方", "对谈人", "codex · gpt-6-astra", "其余 4 个未评分：只在包指定它时使用。", "ChatGPT Pro 5x"} {
				if !tt.HasText(text) {
					t.Fatalf("missing %s: %v", text, tt.Texts())
				}
			}
			for _, id := range []string{"debater_a", "debater_b"} {
				if _, ok := tt.Find(id + " 能力分"); ok {
					t.Fatal("seat in execution table")
				}
				if strings.Contains(strings.Join(tt.Texts(), "|"), " · "+id) {
					t.Fatal("seat in shares")
				}
			}
			if both {
				for _, text := range []string{"claude · fable", "max", "Claude 5x Max", "账号已停用"} {
					if !tt.HasText(text) {
						t.Fatal(tt.Texts())
					}
				}
			} else {
				if !tt.HasText("未配置") {
					t.Fatal(tt.Texts())
				}
				if _, ok := tt.Find("配置乙方"); !ok {
					t.Fatal(tt.Texts())
				}
			}
		})
	}
}

func TestDebaterEditAndFailure(t *testing.T) {
	w, a, tt := debatersTester(t, true)
	click(t, tt, "编辑甲方")
	edit(t, tt, "模型", "new-model", false)
	edit(t, tt, "强度", "high", false)
	w.f.mu.Lock()
	w.reject = true
	w.f.mu.Unlock()
	click(t, tt, "保存")
	waitFor(t, tt, a, func() bool { return !a.busy["worker:save"] && a.errors["worker:save"] != "" })
	if !tt.HasText("编辑甲方") || !tt.HasText("模型 gpt-6.1-terra 的思考力度只有 max/xhigh") {
		t.Fatal(tt.Texts())
	}
	w.f.mu.Lock()
	w.reject = false
	w.f.mu.Unlock()
	for label, want := range map[string]string{"模型": "new-model", "强度": "high"} {
		if got, ok := tt.AccessByRole(ui.RoleTextField, label); !ok || got.Value != want {
			t.Fatalf("lost %s: %+v", label, got)
		}
	}
	click(t, tt, "保存")
	waitFor(t, tt, a, func() bool { return !a.busy["worker:save"] && a.snapshot.Workers[6].Model == "new-model" })
	if _, ok := tt.Find("关闭候选编辑"); ok {
		t.Fatal("drawer remains open")
	}
	if !tt.HasText("codex · new-model") {
		t.Fatal(tt.Texts())
	}
	w.f.mu.Lock()
	p := w.calls[len(w.calls)-1]
	w.f.mu.Unlock()
	if _, exists := p["intelligence"]; exists {
		t.Fatal(p)
	}
	if p["id"] != "debater_a" || p["model"] != "new-model" || p["effort"] != "high" {
		t.Fatal(p)
	}
}

func TestDebaterConfigureClearAndRounds(t *testing.T) {
	w, a, tt := debatersTester(t, false)
	click(t, tt, "配置乙方")
	click(t, tt, "claude")
	click(t, tt, "codex")
	click(t, tt, "ChatGPT Pro 5x")
	edit(t, tt, "模型", "gpt-6-astra", false)
	click(t, tt, "保存")
	waitFor(t, tt, a, func() bool { return !a.busy["worker:save"] && len(a.snapshot.Workers) == 8 })
	w.f.mu.Lock()
	p := w.calls[len(w.calls)-1]
	w.f.mu.Unlock()
	if _, exists := p["intelligence"]; exists {
		t.Fatal(p)
	}
	if p["id"] != "debater_b" || p["engine"] != "codex" || len(p["accounts"].([]any)) != 1 {
		t.Fatal(p)
	}
	click(t, tt, "1 轮")
	click(t, tt, "2 轮")
	waitFor(t, tt, a, func() bool { return a.snapshot.Settings["dialogue_rounds"] == "2" && !a.busy["config:dialogue_rounds"] })
	w.f.mu.Lock()
	rounds := w.configCalls[len(w.configCalls)-1]
	w.f.mu.Unlock()
	if rounds["key"] != "dialogue_rounds" || rounds["value"] != "2" {
		t.Fatal(rounds)
	}
	click(t, tt, "编辑乙方")
	click(t, tt, "清空席位")
	w.f.mu.Lock()
	removed := len(w.removeCalls)
	w.f.mu.Unlock()
	if removed != 0 {
		t.Fatal("removed without confirmation")
	}
	click(t, tt, "确认移除")
	waitFor(t, tt, a, func() bool { return len(a.snapshot.Workers) == 7 && !a.busy["worker:clear"] })
	if !tt.HasText("未配置") {
		t.Fatal(tt.Texts())
	}
	w.f.mu.Lock()
	defer w.f.mu.Unlock()
	if len(w.removeCalls) != 1 || w.removeCalls[0]["id"] != "debater_b" {
		t.Fatal(w.removeCalls)
	}
}

func TestDebaterScreenshots(t *testing.T) {
	dir := os.Getenv("WEAVER_DEBATER_SCREENSHOTS")
	if dir == "" {
		t.Skip("未设置截图目录")
	}
	_, a, _ := debatersTester(t, true)
	for _, shot := range []struct {
		name  string
		width int
		dark  bool
	}{{"seats-light.png", 1180, false}, {"seats-dark.png", 1180, true}, {"seats-narrow.png", 760, false}} {
		tt := ui.NewTester(a.view, shot.width, 1750)
		tt.SetDark(shot.dark)
		tt.Advance(time.Second)
		tt.Frame()
		if err := os.MkdirAll(dir, 0755); err != nil {
			t.Fatal(err)
		}
		f, err := os.Create(filepath.Join(dir, shot.name))
		if err != nil {
			t.Fatal(err)
		}
		err = png.Encode(f, tt.Image())
		f.Close()
		if err != nil {
			t.Fatal(err)
		}
	}
}

func TestDebaterEngineAndAccountModelRules(t *testing.T) {
	w, a, tt := debatersTester(t, true)
	click(t, tt, "编辑甲方")
	for _, label := range []string{"ID", "能力分", "并行上限", "说明"} {
		if _, ok := tt.AccessByRole(ui.RoleTextField, label); ok {
			t.Fatalf("seat exposes %s", label)
		}
	}
	click(t, tt, "codex")
	click(t, tt, "dsh")
	if model, ok := tt.AccessByRole(ui.RolePopUpButton, "模型"); !ok || model.Value != "" {
		t.Fatalf("old model retained: %+v", model)
	}
	click(t, tt, "保存")
	if !tt.HasText("请选择模型和至少一个账号") {
		t.Fatal(tt.Texts())
	}
	w.f.mu.Lock()
	count := len(w.calls)
	w.f.mu.Unlock()
	if count != 0 {
		t.Fatal("engine change submitted without selecting model and accounts")
	}
	click(t, tt, "OpenAI API（dsh）")
	waitFor(t, tt, a, func() bool { return !a.busy["worker:config:dsh_openai"] })
	click(t, tt, "选择模型")
	click(t, tt, "gpt-6.1-terra")
	// The old codex account must not survive the engine change.
	click(t, tt, "xhigh")
	if _, ok := tt.Find("high"); ok {
		t.Fatal("unsupported effort")
	}
	click(t, tt, "max")
	click(t, tt, "保存")
	waitFor(t, tt, a, func() bool { return !a.busy["worker:save"] && a.snapshot.Workers[6].Engine == "dsh" })
	w.f.mu.Lock()
	p := w.calls[len(w.calls)-1]
	w.f.mu.Unlock()
	if _, exists := p["intelligence"]; exists {
		t.Fatal(p)
	}
	if p["engine"] != "dsh" || p["model"] != "gpt-6.1-terra" || p["effort"] != "max" || len(p["accounts"].([]any)) != 1 || p["accounts"].([]any)[0] != "dsh_openai" {
		t.Fatal(p)
	}
}

func TestDebaterSaveBusy(t *testing.T) {
	w, a, tt := debatersTester(t, true)
	release := make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	defer unblock()
	w.f.mu.Lock()
	w.hold = release
	w.f.mu.Unlock()
	click(t, tt, "编辑甲方")
	edit(t, tt, "模型", "updated", false)
	click(t, tt, "保存")
	if !tt.HasText("保存中…") {
		t.Fatal(tt.Texts())
	}
	_ = tt.Click("保存中…")
	tt.Frame()
	unblock()
	waitFor(t, tt, a, func() bool { return !a.busy["worker:save"] && a.snapshot.Workers[6].Model == "updated" })
	w.f.mu.Lock()
	count := len(w.calls)
	w.f.mu.Unlock()
	if count != 1 {
		t.Fatalf("duplicate submissions: %d", count)
	}
}

func TestDebaterNarrowSections(t *testing.T) {
	_, a, _ := debatersTester(t, true)
	tt := ui.NewTester(a.view, 760, 1750)
	for _, text := range []string{"6 个候选", "甲方", "乙方", "codex · gpt-6-astra", "claude · fable", "账号已停用", "其余 4 个未评分"} {
		if !tt.HasText(text) {
			t.Fatalf("missing %s: %v", text, tt.Texts())
		}
	}
	for _, id := range []string{"debater_a", "debater_b"} {
		if _, ok := tt.Find(id + " 能力分"); ok {
			t.Fatal("seat in execution cards")
		}
		if _, ok := tt.Find(id + " 启用"); ok {
			t.Fatal("seat in execution cards")
		}
	}
}

func TestDebaterExcludedFromRoutingWarnings(t *testing.T) {
	w, a, tt := debatersTester(t, true)
	w.f.mu.Lock()
	w.f.data.Workers[7].Intelligence = 9
	w.f.mu.Unlock()
	a.refresh()
	tt.Frame()
	if strings.Contains(strings.Join(tt.Texts(), "|"), "9 · debater_b") || tt.HasText("debater_b：账号已停用") {
		t.Fatal(tt.Texts())
	}
}
