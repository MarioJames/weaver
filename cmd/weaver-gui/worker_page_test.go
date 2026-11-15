package main

import (
	"encoding/json"
	"image/png"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/MarioJames/weaver/internal/rpc"
	"github.com/egoist/mygo/ui"
)

type workerRPC struct {
	f           *fakeService
	calls       []map[string]any
	configCalls []map[string]any
	removeCalls []map[string]any
	hold        <-chan struct{}
	reject      bool
}

func newWorkerRPC(t *testing.T) *workerRPC {
	f := newFake(t)
	f.stop()
	ids := []string{"codex_sol_medium", "opencode_deepseek", "claude_sonnet_high", "opencode_muse", "dsh_terra_xhigh", "dsh_haiku_xhigh"}
	engines := []string{"codex", "opencode", "claude", "opencode", "dsh", "dsh"}
	models := []string{"gpt-6.1-sol", "deepseek-v4.1-flash", "sonnet", "muse-spark-1.3-contributor", "gpt-6.1-terra", "claude-haiku-5-5"}
	efforts := []string{"medium", "max", "high", "max", "xhigh", "xhigh"}
	bindings := []int{1, 2, 0, 2, 5, 6}
	for i := range f.data.Accounts {
		f.data.Accounts[i].ID = "import_" + f.data.Accounts[i].ID
	}
	f.data.Accounts[5].ID = "dsh_openai"
	f.data.Workers = nil
	for i, id := range ids {
		intelligence := 0.0
		if i < 2 {
			intelligence = 5
		}
		f.data.Workers = append(f.data.Workers, worker{ID: id, Engine: engines[i], Model: models[i], Effort: efforts[i], Intelligence: intelligence, Enabled: true, Available: true, Accounts: []string{f.data.Accounts[bindings[i]].ID}})
	}
	f.data.Workers[0].Stats = workerStats{Samples: 20, FirstAcceptanceRate: 0.85, MedianSeconds: 480}
	w := &workerRPC{f: f}
	l, err := net.Listen("unix", rpc.SocketPath(f.home))
	if err != nil {
		t.Fatal(err)
	}
	f.listener = l
	f.wg.Add(1)
	go func() {
		defer f.wg.Done()
		for {
			conn, err := l.Accept()
			if err != nil {
				return
			}
			f.wg.Add(1)
			go func() {
				defer f.wg.Done()
				defer conn.Close()
				conn.SetDeadline(time.Now().Add(time.Second))
				var req rpc.Request
				if json.NewDecoder(conn).Decode(&req) != nil {
					return
				}
				if req.Method != "worker.set" && req.Method != "worker.remove" && req.Method != "account.config" && req.Method != "config.set" {
					f.respond(conn, req)
					return
				}
				if req.Method == "worker.set" {
					f.mu.Lock()
					hold := w.hold
					f.mu.Unlock()
					if hold != nil {
						<-hold
					}
				}
				w.respond(conn, req)
			}()
		}
	}()
	return w
}
func (w *workerRPC) respond(conn net.Conn, req rpc.Request) {
	f := w.f
	f.mu.Lock()
	defer f.mu.Unlock()
	var p map[string]any
	json.Unmarshal(req.Params, &p)
	var result any
	var failure *rpc.Error
	switch req.Method {
	case "config.set":
		w.configCalls = append(w.configCalls, p)
		f.data.Settings[p["key"].(string)] = p["value"].(string)
	case "account.config":
		result = map[string]any{"provider": "openai", "config": map[string]any{"models": []any{map[string]any{"id": "gpt-6.1-terra", "reasoningEfforts": map[string]any{"xhigh": map[string]any{}, "max": map[string]any{}}}}}}
	case "worker.set":
		w.calls = append(w.calls, p)
		if w.reject {
			failure = &rpc.Error{Code: "INVALID", Message: "模型 gpt-6.1-terra 的思考力度只有 max/xhigh"}
			break
		}
		pos := -1
		for i, v := range f.data.Workers {
			if v.ID == p["id"] {
				pos = i
				break
			}
		}
		if pos < 0 {
			f.data.Workers = append(f.data.Workers, worker{Enabled: true, Available: true})
			pos = len(f.data.Workers) - 1
		}
		data, _ := json.Marshal(p)
		json.Unmarshal(data, &f.data.Workers[pos])
		if p["id"] == "debater_a" || p["id"] == "debater_b" {
			f.data.Workers[pos].Role = "debater"
		}
		result = f.data.Workers[pos]
	case "worker.remove":
		w.removeCalls = append(w.removeCalls, p)
		for i, v := range f.data.Workers {
			if v.ID == p["id"] {
				f.data.Workers = append(f.data.Workers[:i], f.data.Workers[i+1:]...)
				break
			}
		}
	}
	body, _ := json.Marshal(result)
	json.NewEncoder(conn).Encode(rpc.Response{OK: failure == nil, Result: body, Error: failure})
}
func workersTester(t *testing.T) (*workerRPC, *app, *ui.Tester) {
	w := newWorkerRPC(t)
	a := testApp(t, w.f)
	a.page = "候选"
	tt := ui.NewTester(a.view, 1440, 1100)
	return w, a, tt
}
func TestWorkerIntelligenceAndInlineSave(t *testing.T) {
	w, a, tt := workersTester(t)
	for _, text := range []string{"6 个候选", "ChatGPT Pro 5x", "5 · codex_sol_medium", "5 · opencode_deepseek"} {
		if !tt.HasText(text) {
			t.Fatalf("缺少 %s: %v", text, tt.Texts())
		}
	}
	if strings.Contains(strings.Join(tt.Texts(), " "), "import_") {
		t.Fatal(tt.Texts())
	}
	edit(t, tt, "opencode_deepseek 能力分", "8.5", true)
	waitFor(t, tt, a, func() bool { return a.snapshot.Workers[1].Intelligence == 8.5 && !a.busy["worker:opencode_deepseek"] })
	if a.snapshot.Workers[0].Intelligence != 5 || a.snapshot.Workers[1].Intelligence != 8.5 {
		t.Fatal(tt.Texts())
	}
	w.f.mu.Lock()
	p := w.calls[0]
	w.f.mu.Unlock()
	if len(p) != 2 || p["id"] != "opencode_deepseek" || p["intelligence"] != float64(8.5) {
		t.Fatal(p)
	}
	edit(t, tt, "opencode_deepseek 能力分", "5", false)
	click(t, tt, "codex_sol_medium 能力分")
	waitFor(t, tt, a, func() bool { return a.snapshot.Workers[1].Intelligence == 5 })
	for _, id := range []string{"codex_sol_medium", "opencode_deepseek"} {
		click(t, tt, id+" 启用")
		waitFor(t, tt, a, func() bool { return !a.busy["worker:"+id+":enabled"] })
	}
	if a.snapshot.Workers[0].Enabled || a.snapshot.Workers[1].Enabled {
		t.Fatal("候选未停用")
	}
	click(t, tt, "codex_sol_medium 启用")
	waitFor(t, tt, a, func() bool { return a.snapshot.Workers[0].Enabled })
}
func TestWorkerCreateAndReadOnlyEngine(t *testing.T) {
	_, a, tt := workersTester(t)
	click(t, tt, "新建候选")
	click(t, tt, "claude")
	click(t, tt, "codex")
	// Modal accessibility and input lookup must expose only same-engine accounts.
	if _, ok := tt.Find("ChatGPT Pro 5x"); !ok {
		t.Fatal(tt.Texts())
	}
	texts := strings.Join(tt.Texts(), "|")
	dialog := texts[strings.LastIndex(texts, "候选编辑"):]
	if strings.Contains(dialog, "Claude 5x Max") || strings.Contains(dialog, "opencode no") {
		t.Fatal("其他引擎账号出现在抽屉中")
	}
	edit(t, tt, "ID", "codex_new", false)
	edit(t, tt, "模型", "gpt-6.1-sol", false)
	click(t, tt, "ChatGPT Pro 5x")
	click(t, tt, "保存")
	waitFor(t, tt, a, func() bool { return len(a.snapshot.Workers) == 7 && !a.busy["worker:save"] })
	click(t, tt, "编辑 codex_sol_medium")
	if !tt.HasText("codex（建好后不能改）") {
		t.Fatal(tt.Texts())
	}
	click(t, tt, "取消")
	click(t, tt, "删除 codex_new")
	if !tt.HasText("删除候选") {
		t.Fatal(tt.Texts())
	}
	click(t, tt, "取消")
	if len(a.snapshot.Workers) != 7 {
		t.Fatal("取消删除丢失候选")
	}
	click(t, tt, "删除 codex_new")
	click(t, tt, "确认移除")
	waitFor(t, tt, a, func() bool { return len(a.snapshot.Workers) == 6 })
}
func TestWorkerDSHEffortsAndServerRejection(t *testing.T) {
	w, a, tt := workersTester(t)
	click(t, tt, "编辑 dsh_terra_xhigh")
	waitFor(t, tt, a, func() bool { return !a.busy["worker:config:dsh_openai"] })
	click(t, tt, "xhigh")
	if _, ok := tt.Find("max"); !ok {
		t.Fatal(tt.Texts())
	}
	if _, ok := tt.Find("high"); ok {
		t.Fatal("出现不支持的 high")
	}
	click(t, tt, "max")
	w.f.mu.Lock()
	w.reject = true
	w.f.mu.Unlock()
	click(t, tt, "保存")
	waitFor(t, tt, a, func() bool { return !a.busy["worker:save"] && a.errors["worker:save"] != "" })
	if !tt.HasText("模型 gpt-6.1-terra 的思考力度只有 max/xhigh") || !tt.HasText("编辑 dsh_terra_xhigh") {
		t.Fatal(tt.Texts())
	}
	w.f.mu.Lock()
	w.reject = false
	w.f.mu.Unlock()
	click(t, tt, "保存")
	waitFor(t, tt, a, func() bool { return a.snapshot.Workers[4].Effort == "max" && !a.busy["worker:save"] })
	w.f.mu.Lock()
	p := w.calls[len(w.calls)-1]
	w.f.mu.Unlock()
	if len(p) != 2 || p["effort"] != "max" {
		t.Fatal(p)
	}
}
func TestWorkerExternalRefresh(t *testing.T) {
	w, a, tt := workersTester(t)
	a.start()
	// A command-line update is represented by a status change outside the GUI.
	w.f.mu.Lock()
	w.f.data.Workers[0].Intelligence = 9
	w.f.mu.Unlock()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		tt.Frame()
		a.mu.Lock()
		ok := a.snapshot.Workers[0].Intelligence == 9
		a.mu.Unlock()
		if ok {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("外部能力分变动未在 3 秒内反映")
}
func TestWorkerScreenshots(t *testing.T) {
	dir := os.Getenv("WEAVER_WORKER_SCREENSHOTS")
	if dir == "" {
		t.Skip("未设置截图目录")
	}
	_, a, tt := workersTester(t)
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	save := func(name string) {
		f, err := os.Create(filepath.Join(dir, name))
		if err != nil {
			t.Fatal(err)
		}
		defer f.Close()
		if err := png.Encode(f, tt.Image()); err != nil {
			t.Fatal(err)
		}
	}
	save("workers.png")
	click(t, tt, "编辑 dsh_terra_xhigh")
	waitFor(t, tt, a, func() bool { return !a.busy["worker:config:dsh_openai"] })
	save("worker-editor.png")
}

func TestWorkerUnavailableReasonAndModelRules(t *testing.T) {
	w, a, tt := workersTester(t)
	w.f.mu.Lock()
	w.f.data.Workers[0].Available = false
	w.f.data.Workers[0].Reason = "已暂停：测试"
	w.f.mu.Unlock()
	a.refresh()
	tt.Frame()
	if !tt.HasText("codex_sol_medium：已暂停：测试") {
		t.Fatal(tt.Texts())
	}
	for _, provider := range []string{"", "deepseek", "deepseek-official"} {
		s := workerPageState{accounts: []string{"native"}, configs: map[string]workerConfig{"native": {Provider: provider}}}
		_, efforts, constrained := s.options()
		if !constrained || strings.Join(efforts, ",") != "off,low,high,max" {
			t.Fatalf("DeepSeek 强度: %v", efforts)
		}
	}
	s := workerPageState{model: "outside", accounts: []string{"api"}, configs: map[string]workerConfig{"api": {Provider: "openai"}}}
	_, _, constrained := s.options()
	if constrained {
		t.Fatal("清单外模型应允许手填强度")
	}
}

func TestWorkerStatisticsVisible(t *testing.T) {
	_, _, tt := workersTester(t)
	for _, text := range []string{"首次采纳", "中位耗时", "85%", "20 次", "8 分"} {
		if !tt.HasText(text) {
			t.Fatalf("missing %q: %v", text, tt.Texts())
		}
	}
}

// An out-of-range rating is rejected in place and never reaches the service.
func TestWorkerRejectsInvalidIntelligence(t *testing.T) {
	w, a, tt := workersTester(t)
	edit(t, tt, "opencode_deepseek 能力分", "7.3", true)
	tt.Frame()
	if !tt.HasText("能力分只能为 0（未评分）或 1–10，步长 0.5") {
		t.Fatal(tt.Texts())
	}
	w.f.mu.Lock()
	calls := len(w.calls)
	w.f.mu.Unlock()
	if calls != 0 || a.snapshot.Workers[1].Intelligence != 5 {
		t.Fatalf("calls=%d intelligence=%v", calls, a.snapshot.Workers[1].Intelligence)
	}
}
