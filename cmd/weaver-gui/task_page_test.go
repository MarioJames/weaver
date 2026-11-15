package main

import (
	"encoding/json"
	"image/png"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/MarioJames/weaver/internal/kernel"
	"github.com/MarioJames/weaver/internal/rpc"
	"github.com/egoist/mygo/ui"
)

// Extends the shell's fake RPC service without changing its fixtures for the
// other concurrently developed pages. No daemon or engine files are touched.
type tasksFake struct {
	*fakeService
	taskMu             sync.Mutex
	missions, archived []taskMission
	packages           []taskPackage
	events             []taskEvent
	items              []taskItem
	artifacts          []taskArtifactGroup
	transcriptError    string
	methods            []string
	afters             []int64
}

func newTasksFake(t *testing.T) *tasksFake {
	t.Helper()
	home := t.TempDir()
	now := time.Now()
	at := now.Add(-30 * time.Minute).UnixMilli()
	f := &tasksFake{fakeService: &fakeService{home: home, data: fixture(home)}}
	f.missions = []taskMission{
		{ID: "old", Title: "更早的任务", State: "running", LastActivityAt: now.AddDate(0, 0, -10).UnixMilli()},
		{ID: "recent", Title: "两天前的任务", State: "closed", LastActivityAt: now.AddDate(0, 0, -2).UnixMilli()},
		{ID: "main", Title: "Weaver 桌面图形界面", State: "running", Owner: &taskOwner{Engine: "claude", Session: "session-main"}, LastActivityAt: now.UnixMilli(), Total: 2, Counts: map[string]int{"accepted": 1}},
		{ID: "today", Title: "今天较早的任务", State: "running", Owner: &taskOwner{Engine: "codex", Session: "session-codex"}, LastActivityAt: now.Add(-time.Minute).UnixMilli()},
	}
	f.archived = []taskMission{{ID: "archived", Title: "已完成的旧任务", State: "closed", Archived: true, LastActivityAt: now.AddDate(0, 0, -8).UnixMilli()}}
	f.packages = []taskPackage{
		{ID: "main/shell", Key: "shell", Title: "应用骨架", State: "accepted", Worker: "codex_sol_medium", Instruction: "## 指令\n实现应用骨架", CreatedAt: at, Current: &taskAttempt{N: 2, Worker: "codex_sol_medium", CreatedAt: at + 10000, FinishedAt: at + 20000}, Attempts: []*taskAttempt{{N: 1, State: "returned", Result: "## 第一次结果\n需要修订"}, {N: 2, State: "accepted", Result: "## 第二次结果\n检查通过"}}},
		{ID: "main/server", Key: "server", Title: "服务接口", State: "running", Worker: "opencode_deepseek", CreatedAt: at},
	}
	f.events = []taskEvent{{Seq: 1, Kind: "plan", At: at}}
	for attempt := 1; attempt <= 2; attempt++ {
		for j, kind := range []string{"launching", "handed", "running", "result", "returned"} {
			if attempt == 2 && kind == "returned" {
				kind = "accepted"
			}
			msg := ""
			if kind == "returned" {
				msg = "补上断线恢复说明"
			}
			f.events = append(f.events, taskEvent{Seq: int64(len(f.events) + 1), Package: "main/shell", Key: "shell", Kind: kind, Attempt: attempt, At: at + int64(attempt*10000+j*1000), Message: msg})
		}
	}
	f.items = []taskItem{{At: at - 3000, Role: "user", Text: "只做桌面端"}, {At: at - 2000, Role: "assistant", Text: "先实现骨架，再拆包。"}, {At: at - 1000, Role: "thinking", Text: "hidden-thinking"}, {At: at, Role: "tool", Tool: "Bash", Text: "Bash: weaver plan submit --mission main --file plan.json"}}
	f.items = append(f.items, taskItem{At: at + 1000, Role: "tool", Tool: "Read", Text: "Read: /src/main.go"})
	f.items[3].Weaver = &kernel.WeaverCall{Command: "plan submit", Mission: "main"}
	f.artifacts = []taskArtifactGroup{
		{GroupKey: "design", Items: []taskArtifact{{ID: "design-v2", Kind: "design", Title: "设计 v2", URL: "https://example.org/design-v2", Summary: map[string]any{"decisions": 3, "checks": 9}}, {ID: "design-v1", Kind: "design", Title: "设计 v1", URL: "https://example.org/design-v1"}}},
		{GroupKey: "report", Items: []taskArtifact{{ID: "report", Kind: "report", Title: "验收报告", Summary: map[string]any{"verdict": "未完成", "pass": 8, "fail": 1, "blocked": 0, "skipped": 0}, URL: "https://example.org/report"}}},
	}
	listener, err := net.Listen("unix", rpc.SocketPath(home))
	if err != nil {
		t.Fatal(err)
	}
	f.listener = listener
	f.wg.Add(1)
	go func() {
		defer f.wg.Done()
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			f.wg.Add(1)
			go func() {
				defer f.wg.Done()
				defer conn.Close()
				_ = conn.SetDeadline(time.Now().Add(time.Second))
				var req rpc.Request
				if json.NewDecoder(conn).Decode(&req) == nil {
					f.respondTasks(conn, req)
				}
			}()
		}
	}()
	t.Cleanup(f.stop)
	return f
}
func (f *tasksFake) respondTasks(conn net.Conn, req rpc.Request) {
	f.taskMu.Lock()
	defer f.taskMu.Unlock()
	f.methods = append(f.methods, req.Method)
	var p struct {
		ID, Mission, Package string
		Archived             bool
		After                int64
	}
	_ = json.Unmarshal(req.Params, &p)
	var result any
	var failure *rpc.Error
	switch req.Method {
	case "mission.list":
		result = f.missions
		if p.Archived {
			result = f.archived
		}
	case "mission.show":
		m := taskMission{}
		for _, candidate := range append(append([]taskMission{}, f.missions...), f.archived...) {
			if candidate.ID == p.ID {
				m = candidate
			}
		}
		// mission.show embeds Mission; it does not wrap it in a mission key.
		result = struct {
			kernel.Mission
			Packages []kernel.Package `json:"packages"`
			Timers   []kernel.Timer   `json:"timers"`
		}{Mission: m, Packages: f.packages, Timers: []kernel.Timer{}}
	case "package.show":
		for _, pkg := range f.packages {
			if pkg.ID == p.Package {
				result = pkg
			}
		}
	case "events":
		filtered := []taskEvent{}
		for _, e := range f.events {
			if e.Seq > p.After {
				filtered = append(filtered, e)
			}
		}
		result = filtered
	case "artifact.list":
		groups := []kernel.ArtifactGroup{}
		for _, group := range f.artifacts {
			g := kernel.ArtifactGroup{GroupKey: group.GroupKey, Items: []*kernel.Artifact{}}
			for _, item := range group.Items {
				summary, err := json.Marshal(item.Summary)
				if err != nil {
					panic(err)
				}
				g.Items = append(g.Items, &kernel.Artifact{ID: item.ID, Kind: item.Kind, Title: item.Title, Path: item.Path, URL: item.URL, CreatedAt: item.CreatedAt, Summary: summary})
			}
			groups = append(groups, g)
		}
		result = groups
	case "mission.transcript":
		f.afters = append(f.afters, p.After)
		if f.transcriptError != "" {
			failure = &rpc.Error{Code: "NOT_FOUND", Message: f.transcriptError}
		} else {
			start := min(int(p.After), len(f.items))
			result = taskTranscript{Session: "session-main", Path: "/sessions/main.jsonl", Items: f.items[start:], Next: int64(len(f.items))}
		}
	case "mission.archive", "mission.unarchive":
		archive := req.Method == "mission.archive"
		source, dest := &f.archived, &f.missions
		if archive {
			source, dest = &f.missions, &f.archived
		}
		for i, m := range *source {
			if m.ID == p.Mission {
				m.Archived = archive
				*dest = append(*dest, m)
				*source = append((*source)[:i], (*source)[i+1:]...)
				break
			}
		}
		// Archive endpoints return the updated Mission.
		for _, m := range *dest {
			if m.ID == p.Mission {
				result = m
			}
		}
	default:
		f.fakeService.respond(conn, req)
		return
	}
	body, _ := json.Marshal(result)
	_ = json.NewEncoder(conn).Encode(rpc.Response{OK: failure == nil, Result: body, Error: failure})
}
func tasksTester(t *testing.T, w, h int) (*tasksFake, *app, *ui.Tester) {
	t.Helper()
	f := newTasksFake(t)
	a := testApp(t, f.fakeService)
	a.page = "任务"
	tt := ui.NewTester(a.view, w, h)
	tasksWait(t, tt, "Weaver 桌面图形界面", 5*time.Second)
	return f, a, tt
}
func tasksWait(t *testing.T, tt *ui.Tester, text string, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		tt.Frame()
		if tt.HasText(text) {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("没有出现 %q: %q", text, tt.Texts())
}
func tasksContains(t *testing.T, tt *ui.Tester, texts ...string) {
	t.Helper()
	for _, text := range texts {
		if !tt.HasText(text) {
			t.Errorf("缺少 %q: %q", text, tt.Texts())
		}
	}
}
func openTasksMain(t *testing.T, tt *ui.Tester) {
	t.Helper()
	click(t, tt, "Weaver 桌面图形界面")
	tasksWait(t, tt, "只做桌面端", 5*time.Second)
}
func TestTasksGroupingTranscriptAndLifecycle(t *testing.T) {
	f, _, tt := tasksTester(t, 1440, 1000)
	tasksContains(t, tt, "今天", "3 天内", "更早", "Cl", "Cx")
	texts := strings.Join(tt.Texts(), "\n")
	if strings.Index(texts, "Weaver 桌面图形界面") > strings.Index(texts, "今天较早的任务") {
		t.Fatal("组内未倒序")
	}
	if tt.HasText("搜索") {
		t.Fatal("出现搜索框")
	}
	openTasksMain(t, tt)
	tasksContains(t, tt, "只做桌面端", "先实现骨架，再拆包。", "▸ Read · "+taskTime(f.items[4].At), "▸ weaver plan submit · "+taskTime(f.items[3].At), "子 Agent 2", "shell", "server", "第 1 次尝试", "第 2 次尝试", "补上断线恢复说明", "已采纳", "运行中", "进行中 · 1 / 2 已采纳")
	for _, fold := range []string{"▸ 指令全文", "▸ 第 1 次结果全文"} {
		if _, ok := tt.AccessByRole(ui.RoleButton, fold); ok {
			t.Fatalf("%q 仍然是按钮", fold)
		}
		if _, ok := tt.AccessByRole(ui.RoleText, fold); !ok {
			t.Fatalf("%q 不是左对齐折叠行：%q", fold, tt.Texts())
		}
	}
	if tt.HasText("hidden-thinking") {
		t.Fatal("显示了 thinking")
	}
	texts = strings.Join(tt.Texts(), "\n")
	if strings.Index(texts, "weaver plan submit") > strings.Index(texts, "shell") {
		t.Fatal("卡片未插在 submit 之后")
	}
	if _, exists := tt.Find("子 Agent"); exists {
		t.Fatal("已匹配的卡片落入末尾分组")
	}

	click(t, tt, "▸ weaver plan submit · "+taskTime(f.items[3].At))
	tasksContains(t, tt, "Bash: weaver plan submit --mission main --file plan.json")
	click(t, tt, "▸ 指令全文")
	tasksContains(t, tt, "实现应用骨架", "▾ 指令全文")
	click(t, tt, "▾ 指令全文")
	if tt.HasText("实现应用骨架") {
		t.Fatal("收起后仍显示指令全文")
	}
	for _, forbidden := range []string{"发消息", "采纳", "退回", "取消", "重试"} {
		if _, ok := tt.Find(forbidden); ok {
			t.Errorf("出现动作入口 %s", forbidden)
		}
	}
}
func TestTasksPollingIncremental(t *testing.T) {
	f, _, tt := tasksTester(t, 1440, 1000)
	openTasksMain(t, tt)
	click(t, tt, "server")
	f.taskMu.Lock()
	f.packages[1].State = "accepted"
	f.events = append(f.events, taskEvent{Seq: int64(len(f.events) + 1), Package: "main/server", Key: "server", Attempt: 1, Kind: "accepted", Message: "服务接口已复核", At: time.Now().UnixMilli()})
	f.items = append(f.items, taskItem{At: time.Now().UnixMilli(), Role: "assistant", Text: "服务包已采纳"})
	f.taskMu.Unlock()
	tasksWait(t, tt, "服务包已采纳", 3*time.Second)
	tasksContains(t, tt, "服务接口已复核", "已采纳")
	texts := strings.Join(tt.Texts(), "\n")
	if strings.Count(texts, "只做桌面端") != 1 {
		t.Fatal("增量读取重复显示消息")
	}
	f.taskMu.Lock()
	defer f.taskMu.Unlock()
	seen := false
	for _, after := range f.afters {
		if after > 0 {
			seen = true
		}
	}
	if !seen {
		t.Fatal("未使用 after")
	}
	for _, method := range f.methods {
		switch method {
		case "status", "mission.list", "mission.show", "mission.transcript", "events", "artifact.list", "package.show":
		default:
			t.Errorf("任务页调用了 %s", method)
		}
	}
}
func TestTasksTranscriptErrorsKeepCards(t *testing.T) {
	for _, message := range []string{"未记录父 Agent", "找不到父 Agent 的会话记录", "暂不支持读取 opencode 的对话记录"} {
		t.Run(message, func(t *testing.T) {
			f, _, tt := tasksTester(t, 1440, 1000)
			f.taskMu.Lock()
			f.transcriptError = message
			f.taskMu.Unlock()
			click(t, tt, "Weaver 桌面图形界面")
			tasksWait(t, tt, message, 5*time.Second)
			tasksContains(t, tt, "shell", "server", "子 Agent 2", "产物 3")
			if message == "找不到父 Agent 的会话记录" {
				tasksContains(t, tt, "~/.claude/projects/…/session-main.jsonl")
			}
		})
	}
}
func TestTasksArtifactsVersionsAndEmpty(t *testing.T) {
	_, _, tt := tasksTester(t, 1440, 1000)
	openTasksMain(t, tt)
	click(t, tt, "产物 3")
	tasksContains(t, tt, "设计 v2", "2 个版本", "待拍板 3 项 · 验收清单 9 项", "验收报告", "结论：未完成 · 通过 8 · 失败 1")
	for _, text := range tt.Texts() {
		if strings.Contains(text, "pass") || strings.Contains(text, "fail") {
			t.Errorf("报告显示英文状态键：%s", text)
		}
	}
	if tt.HasText("设计 v1") {
		t.Fatal("旧版本默认展开")
	}
	click(t, tt, "2 个版本")
	tasksContains(t, tt, "设计 v1")
}
func TestTasksArtifactsEmpty(t *testing.T) {
	f, _, tt := tasksTester(t, 1440, 1000)
	f.taskMu.Lock()
	f.artifacts = nil
	f.taskMu.Unlock()
	openTasksMain(t, tt)
	click(t, tt, "产物 0")
	tasksContains(t, tt, "还没有产物", "分享时加 --mission <主任务 ID>，或用 weaver artifact add 登记")
}
func TestTasksArchiveRestore(t *testing.T) {
	_, _, tt := tasksTester(t, 1440, 1000)
	click(t, tt, "已归档（1）")
	tasksContains(t, tt, "已完成的旧任务")
	click(t, tt, "恢复")
	tasksWait(t, tt, "已归档（0）", 5*time.Second)
	tasksContains(t, tt, "已完成的旧任务", "更早的任务")
}
func TestTasksNarrowAndDrawer(t *testing.T) {
	_, _, tt := tasksTester(t, 800, 900)
	if tt.HasText("选择一个任务，查看父 Agent 对话") {
		t.Fatal("窄屏显示了对话栏")
	}
	openTasksMain(t, tt)
	tasksContains(t, tt, "返回列表", "侧栏")
	if tt.HasText("今天较早的任务") {
		t.Fatal("窄屏保留列表")
	}
	click(t, tt, "侧栏")
	tasksContains(t, tt, "返回对话", "子 Agent 2")
	click(t, tt, "返回对话")
	click(t, tt, "返回列表")
	tasksContains(t, tt, "今天较早的任务")
	tt.SetSize(1000, 900)
	openTasksMain(t, tt)
	if tt.HasText("子 Agent 2") {
		t.Fatal("中等窗口侧栏没有收起")
	}
	click(t, tt, "侧栏")
	tasksContains(t, tt, "关闭侧栏", "子 Agent 2")
	click(t, tt, "关闭侧栏")
}
func TestTasksAutoArchiveSetting(t *testing.T) {
	f := newFake(t)
	a := testApp(t, f)
	tt := ui.NewTester(a.view, 1440, 1000)
	click(t, tt, "设置")
	tasksContains(t, tt, "自动归档", "已结束的任务在这么多天没有活动后归档，进行中的从不归档")
	click(t, tt, "7 天")
	click(t, tt, "30 天")
	waitFor(t, tt, a, func() bool {
		return a.snapshot.Settings["archive_after_days"] == "30" && !a.busy["config:archive_after_days"]
	})
}
func TestTaskArtifactLocalPreference(t *testing.T) {
	path := filepath.Join(t.TempDir(), "design.html")
	if err := os.WriteFile(path, []byte("design"), 0600); err != nil {
		t.Fatal(err)
	}
	item := taskArtifact{Path: path, URL: "https://example.org/design"}
	target, err := taskArtifactTarget(item)
	if err != nil || target != path {
		t.Fatalf("%s %v", target, err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	target, err = taskArtifactTarget(item)
	if err != nil || target != item.URL {
		t.Fatalf("%s %v", target, err)
	}
}
func TestTasksScreenshots(t *testing.T) {
	dir := os.Getenv("WEAVER_TASK_SCREENSHOTS")
	if dir == "" {
		t.Skip("未设置任务截图目录")
	}
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	_, _, tt := tasksTester(t, 1440, 1000)
	openTasksMain(t, tt)
	save := func(name string) {
		t.Helper()
		file, err := os.Create(filepath.Join(dir, name))
		if err != nil {
			t.Fatal(err)
		}
		err = png.Encode(file, tt.Image())
		_ = file.Close()
		if err != nil {
			t.Fatal(err)
		}
	}
	save("tasks-agents.png")
	click(t, tt, "产物 3")
	save("tasks-artifacts.png")
	tt.SetSize(800, 900)
	save("tasks-narrow.png")
}

func TestTaskReportSummary(t *testing.T) {
	for _, tc := range []struct {
		name    string
		summary map[string]any
		want    string
	}{
		{"all counts", map[string]any{"pass": float64(8), "fail": float64(1), "blocked": float64(2), "skipped": float64(3)}, "通过 8 · 失败 1 · 阻塞 2 · 未执行 3"},
		{"empty verdict and zero counts", map[string]any{"verdict": "", "pass": 0, "fail": 0}, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := taskSummary(taskArtifact{Kind: "report", Summary: tc.summary}); got != tc.want {
				t.Fatalf("summary %q, want %q", got, tc.want)
			}
		})
	}
}
