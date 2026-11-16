package main

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/MarioJames/weaver/internal/kernel"
	"github.com/MarioJames/weaver/internal/rpc"
	"github.com/egoist/mygo/ui"
)

const (
	fxMain  = "m_4hse6cjvqu"
	fxTitle = "1115｜FEA｜Weaver 桌面图形界面"
)

type fakeCall struct {
	Method string
	Params map[string]any
}

// tasksFake answers the task page's RPC methods with the real interface's
// structures. mission.timeline applies the same from / have / before rules as
// the service, over timelines the tests own.
type tasksFake struct {
	*fakeService
	taskMu             sync.Mutex
	missions, archived []taskMission
	timelines          map[string]*taskTimeline
	texts              map[string]kernel.MissionTextResult
	textErrors         map[string]string
	packages           map[string]taskPackage
	artifacts          []taskArtifactGroup
	calls              []fakeCall
	pageSize           int
	timelineError      string
	listError          string
}

func fxHash(e taskEntry) string {
	e.Hash = ""
	b, _ := json.Marshal(e)
	h := sha256.Sum256(b)
	return fmt.Sprintf("%x", h[:4])
}

// fxAdd appends entries in order: Ord counts up, Hash follows the content.
func fxAdd(t *taskTimeline, entries ...taskEntry) {
	for _, e := range entries {
		e.Ord = fmt.Sprintf("%06d", len(t.Entries)+1)
		e.Hash = fxHash(e)
		t.Entries = append(t.Entries, e)
	}
}

// fxRecent is d ago, kept inside today: shortly after midnight "an hour ago"
// was yesterday, and the list would file the task under another group. A
// larger d is always earlier.
func fxRecent(d time.Duration) int64 {
	now := time.Now()
	today := now.Sub(time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location()))
	scaled := time.Duration(float64(today) * float64(d) / float64(24*time.Hour))
	return now.Add(-min(d, scaled)).UnixMilli()
}

// fxDay is today at h:m local, in unix milliseconds.
func fxDay(h, m int) int64 {
	n := time.Now()
	return time.Date(n.Year(), n.Month(), n.Day(), h, m, 0, 0, n.Location()).UnixMilli()
}

func fxOps(at int64, n int, tool, text string) taskEntry {
	e := taskEntry{Kind: "ops", At: at}
	for i := 0; i < n; i++ {
		e.Ops = append(e.Ops, kernel.TimelineOp{At: at + int64(i)*10_000, Tool: tool, Text: fmt.Sprintf("%s: %s %d", tool, text, i+1)})
	}
	e.To = e.Ops[len(e.Ops)-1].At
	return e
}

func fxOwner(at int64, text string, chars int) taskEntry {
	return taskEntry{Kind: "owner", At: at, Text: text, Chars: max(chars, len([]rune(text))), Ref: fmt.Sprintf("session:%d", at/1000)}
}

const fxLongReply = "方案设计文档已出，没有写代码，也没有动 Weaver 仓库。\n公网链接：https://claw-r2.shabby.in/2026-11-15/1115-weaver-gui-design.html\n文档以本机 Weaver 2.0.0 的真实配置为数据（7 个账号、6 个候选、4 项设置、1 个 opencode 常驻服务），按场景左右对比命令行现状与界面改后，附命令到界面位置的逐条覆盖对照和 19 项验收清单。\n宽屏和 390px 窄屏的排版都在浏览器里核对过。\n第五行：账号页、候选页、设置页各一张。\n第六行：任务页的两级结构。\n第七行：对谈与评审的样张。\n第八行：需要你拍板的三项：D1 界面形态，推荐先做桌面应用，网页版放下一步。"

func fxMainMission() taskMission {
	return taskMission{ID: fxMain, Title: fxTitle, State: "closed", Owner: &taskOwner{Engine: "claude", Session: "session-main"}, Workspace: "/home/mocha/opensource/weaver-gui",
		Counts: map[string]int{"accepted": 18, "cancelled": 1}, Total: 19, Artifacts: 2, Activity: "采纳 report-update", CreatedAt: fxDay(22, 12), ClosedAt: fxDay(23, 50),
		LastActivityAt: fxRecent(time.Hour)}
}

func fxPackage(key, title, worker, state string, startMin, endMin int) taskListedPackage {
	p := taskListedPackage{Key: key, Title: title, State: state, Attempt: 1, Worker: worker, CreatedAt: fxDay(22, 14)}
	if startMin >= 0 {
		p.StartedAt = fxDay(22, 14) + int64(startMin)*60_000
	}
	if endMin >= 0 {
		p.FinishedAt = fxDay(22, 14) + int64(endMin)*60_000
	}
	return p
}

// fxMainTimeline is the main mission's conversation as the design samples show it.
func fxMainTimeline() *taskTimeline {
	m := fxMainMission()
	tl := &taskTimeline{Mission: &m, Session: taskSession{Engine: "claude", State: "ok", SyncedTo: fxDay(23, 59)}}
	tl.Packages = []taskListedPackage{
		fxPackage("server", "服务：渠道配置读回、模型拉取、用量查询", "opencode_deepseek", "accepted", 0, 18),
		fxPackage("shell", "界面：应用骨架、概览页与设置页", "codex_sol_medium", "accepted", 0, 10),
		fxPackage("accounts", "界面：账号页", "opencode_deepseek", "accepted", 18, 56),
		fxPackage("workers", "界面：候选页", "codex_sol_medium", "accepted", 10, 16),
		fxPackage("login", "界面：订阅账号在窗口内嵌终端登录", "opencode_deepseek", "accepted", 18, 38),
		fxPackage("dist", "构建与分发：产物、安装脚本与发布流水线", "codex_sol_medium", "accepted", 56, 60),
		fxPackage("tasks-gui", "界面：任务页与自动归档设置", "codex_sol_medium", "accepted", 70, 90),
		fxPackage("acceptance", "验收：真实服务上走一遍", "codex_sol_medium", "cancelled", 100, 110),
	}
	fxAdd(tl,
		taskEntry{Kind: "user", At: fxDay(21, 14), Text: "基于最新版 Weaver 的能力，以及之前聊过的 Lobe My Go UI 框架和 My Go Framework，做一个 Weaver 图形化界面，覆盖目前所有的配置化能力。先做个方案出来", Ref: "session:1"},
		fxOps(fxDay(21, 14), 4, "Bash", "weaver mission list"),
		fxOwner(fxDay(21, 14), "正在梳理 Weaver 2.0 的全部可配置项（账号、候选、引擎、设置等）和 MyGo / Lobe MyGo 的组件能力，接下来读真实数据，然后出方案文档。", 0),
		fxOps(fxDay(21, 16), 12, "Read", "/src/config"),
		fxOwner(fxDay(21, 19), "方案素材已齐（配置面、真实数据、MyGo 能力都核对过了），再确认几条真实报错文案和约束后就写设计文档。", 0),
		fxOps(fxDay(21, 20), 3, "Edit", "/docs/design.html"),
		fxOwner(fxDay(21, 23), fxLongReply, 1472),
		taskEntry{Kind: "user", At: fxDay(22, 9), Text: "没问题，只做桌面端，不做页面端。用 weaver 做吧", Ref: "session:2"},
		fxOwner(fxDay(22, 9), "用户已拍板 D1–D5 按推荐、只做桌面端。先出设计文档定稿，再在独立工作树里经 Weaver 拆包实现。", 0),
		fxOps(fxDay(22, 10), 8, "Bash", "git worktree"),
		fxOwner(fxDay(22, 12), "现在建主任务并提交拆包计划。先建任务临时根和主任务。", 0),
		fxOps(fxDay(22, 12), 3, "Bash", "weaver mission create"),
		taskEntry{Kind: "created", At: fxDay(22, 12)},
	)
	fxAdd(tl,
		taskEntry{Kind: "dispatch", At: fxDay(22, 14), Packages: []string{"server", "shell", "accounts", "workers", "login", "dist"}},
		fxOwner(fxDay(22, 14), "计划已提交：服务端（opencode）和界面骨架（codex）并行开工，账号页、候选页、内嵌终端登录、构建分发按依赖排队。等待第一批结果。", 0),
	)
	wait := fxOps(fxDay(22, 14), 3, "Bash", "weaver wait --mission "+fxMain)
	wait.Ops[0].Text = "Bash: weaver plan submit --mission " + fxMain + " --file plan.json"
	wait.Ops[1].At, wait.Ops[2].At = fxDay(22, 15), fxDay(22, 22)
	wait.To = wait.Ops[2].At
	wait.Ops[1].Text = "Bash: weaver wait --mission " + fxMain
	fxAdd(tl, wait)
	fxAdd(tl,
		taskEntry{Kind: "result", At: fxDay(22, 24), Package: "shell", Attempt: 1, Worker: "codex_sol_medium", Text: "仅新增 cmd/weaver-gui/ 下 9 个文件：应用入口、状态与路由、RPC 客户端、共用组件、概览页、设置页、两个占位页及测试。完成两秒轮询、离线恢复、设置保存与错误回退、引擎控制及服务/技能操作。验证结果：go vet 通过，race 测试通过。", Chars: 612, Ref: "result:att-shell-1"},
		fxOps(fxDay(22, 24), 6, "Bash", "weaver package result"),
		taskEntry{Kind: "accepted", At: fxDay(22, 25), Package: "shell", Attempt: 1, Note: "骨架、概览、设置通过；导航样式和自定义数据目录下的服务按钮留到打磨包", NoteChars: 36, NoteRef: "event:7"},
		taskEntry{Kind: "dispatch", At: fxDay(23, 9), Packages: []string{"tasks-gui", "acceptance"}},
		taskEntry{Kind: "returned", At: fxDay(23, 30), Package: "tasks-gui", Attempt: 1, Note: "结构和功能通过，以下内容问题需要修（只改任务页自己的文件 page_tasks.go、task_*.go 及其测试，其他文件不动）：1) task_models.go 的状态词：包的 running 必须显示「运行中」，主任务的 running 才显示「进行中」。把主任务状态和包状态分成两个映射，别共用一个。2) 列表行的进度写法。3) 归档按钮的位置。", NoteChars: 380, NoteRef: "event:9"},
		taskEntry{Kind: "result", At: fxDay(23, 34), Package: "tasks-gui", Attempt: 2, Worker: "codex_sol_medium", Text: "我会按退回意见，只修改任务页文件及对应测试，核对状态文案、行样式和报告摘要后重跑检查、覆盖三张截图。本次仅修改 page_tasks.go、task_models.go、task_page_test.go：分开主任务与包状态映射：包显示「运行中」，主任务保留「进行中」。\n\n- 列表行进度改为 18 / 19\n- 归档移到详情页右上角", Chars: 734, Ref: "result:att-tasks-gui-2"},
		taskEntry{Kind: "accepted", At: fxDay(23, 37), Package: "tasks-gui", Attempt: 2},
		taskEntry{Kind: "problem", At: fxDay(22, 46), Package: "acceptance", Attempt: 1, Problem: "failed", Reason: "引擎中途退出：opencode 常驻服务进程已退出，这次运行随之中断", Steps: []kernel.TimelineStep{
			{At: fxDay(22, 46), Action: "retry", Text: "上一次因 opencode 常驻服务进程退出中断，没有留下证据；按原指令从头执行。"},
			{At: fxDay(22, 53), Action: "failed", Text: "第 2 次尝试：原因相同"},
			{At: fxDay(22, 54), Action: "cancelled", Text: "取消 acceptance"},
		}},
	)
	return tl
}

const (
	fxDialogue = "m_dialogue"
	fxConvorel = "m_review"
)

func fxSide(side, worker, engine, model, effort, account string) kernel.TimelineSide {
	return kernel.TimelineSide{Side: side, Package: "unit-names", Worker: worker, Engine: engine, Model: model, Effort: effort, Account: account}
}

// fxDialogueTimeline is one round of mutual review: both write a proposal, then both give a final stand.
func fxDialogueTimeline() (taskMission, *taskTimeline) {
	m := taskMission{ID: fxDialogue, Title: "设计对谈 unit-names", State: "running", Owner: &taskOwner{Engine: "claude", Session: "session-dialogue"}, Workspace: "/home/mocha/opensource/weaver", Counts: map[string]int{"accepted": 2}, Total: 4, Activity: "对谈 unit-names 进行到第 2 轮", CreatedAt: fxDay(0, 0), LastActivityAt: time.Now().UnixMilli()}
	tl := &taskTimeline{Mission: &m, Session: taskSession{Engine: "claude", State: "ok"}}
	dp := func(key, side, state, worker, engine, model, effort, account string, start, end int64) taskListedPackage {
		return taskListedPackage{Key: key, Title: key, State: state, Attempt: 1, Worker: worker, Engine: engine, Model: model, Effort: effort, Account: account, StartedAt: start, FinishedAt: end, Dialogue: true}
	}
	t0 := fxDay(0, 0)
	tl.Packages = []taskListedPackage{
		dp("unit-names.r1.a", "a", "accepted", "codex_sol_medium", "codex", "gpt-6-astra", "xhigh", "ChatGPT Pro 5x", t0, t0+129_000),
		dp("unit-names.r1.b", "b", "accepted", "claude_sonnet_high", "claude", "fable", "max", "Claude 5x Max", t0, t0+74_000),
		dp("unit-names.r2.a", "a", "accepted", "codex_sol_medium", "codex", "gpt-6-astra", "xhigh", "ChatGPT Pro 5x", t0+129_000, t0+241_000),
		dp("unit-names.r2.b", "b", "awaiting_verdict", "claude_sonnet_high", "claude", "fable", "max", "Claude 5x Max", t0+129_000, t0+210_000),
	}
	debate := func(side string, round int, kind string, at int64, text string, chars int) taskEntry {
		model, engine := "gpt-6-astra", "codex"
		if side == "b" {
			model, engine = "fable", "claude"
		}
		return taskEntry{Kind: "debater", At: at, Name: "unit-names", Side: side, Round: round, RoundKind: kind, Model: model, Engine: engine, Package: "unit-names.r" + fmt.Sprint(round) + "." + side, Worker: "w", Text: text, Chars: chars, Ref: fmt.Sprintf("result:att-%s-%d", side, round)}
	}
	fxAdd(tl,
		taskEntry{Kind: "created", At: t0},
		taskEntry{Kind: "dialogue", At: t0, Name: "unit-names", Rounds: 1, Sides: []kernel.TimelineSide{
			fxSide("a", "codex_sol_medium", "codex", "gpt-6-astra", "xhigh", "ChatGPT Pro 5x"),
			fxSide("b", "claude_sonnet_high", "claude", "fable", "max", "Claude 5x Max")}},
		taskEntry{Kind: "round", At: t0 + 73_000, Name: "unit-names", Round: 1, RoundKind: "proposal"},
		debate("b", 1, "proposal", t0+74_000, "systemd user units are one namespace per Linux user. Weaver 2 names them from IDs that are only unique inside one data directory: attempt and standby scopes, resident units. Two data directories on one machine therefore collide, and the second daemon cannot start its resident engines at all.", 9100),
		debate("a", 1, "proposal", t0+129_000, "The collision is in the Linux user’s systemd namespace, while Weaver’s state is separated by data directory. internal/engine/cold.go derives attempt scope names solely from the attempt ID, so two homes that mint the same ID collide.", 11800),
		taskEntry{Kind: "round", At: t0 + 209_000, Name: "unit-names", Round: 2, RoundKind: "final"},
		debate("b", 2, "final", t0+210_000, "Agree with the proposal to prefix every unit with a short hash of the data directory. I would keep the readable attempt ID after the prefix, so journalctl output stays greppable.", 9800),
		debate("a", 2, "final", t0+241_000, "Final position: prefix scope and resident unit names with an eight character digest of the home path, and migrate running units on the first start after the upgrade.", 12300),
	)
	return m, tl
}

// fxConvorelTimeline has two asks to Convorel; the second reply is still pending.
func fxConvorelTimeline() (taskMission, *taskTimeline) {
	m := taskMission{ID: fxConvorel, Title: "定时任务调度方案审查", State: "running", Owner: &taskOwner{Engine: "claude", Session: "session-review"}, Workspace: "/home/mocha/opensource/weaver", Total: 0, Activity: "问 Convorel", CreatedAt: fxDay(0, 0), LastActivityAt: time.Now().UnixMilli()}
	tl := &taskTimeline{Mission: &m, Session: taskSession{Engine: "claude", State: "ok"}}
	ask := func(round int, at int64, text string, chars int) taskEntry {
		return taskEntry{Kind: "ask", At: at, Convorel: "cv1", Round: round, Text: text, Chars: chars, Ref: fmt.Sprintf("ask:cv1:%d", round)}
	}
	review := func(round int, at int64, state, text string, chars int) taskEntry {
		return taskEntry{Kind: "review", At: at, Convorel: "cv1", Round: round, State: state, Model: "ChatGPT 6 Pro", Text: text, Chars: chars, Ref: fmt.Sprintf("review:cv1:%d", round)}
	}
	fxAdd(tl,
		taskEntry{Kind: "created", At: fxDay(0, 0)},
		ask(1, fxDay(0, 48), "请审查 Weaver 新增定时任务管理的实现方案，重点找阻断用户目标的失败模式与更简单的既有能力复用。用户确认目标：提供定时任务页面，区分定时脚本与 Agent 任务，迁移适合的现有周期工作。", 0),
		review(1, fxDay(1, 7), "complete", "结论：方案方向可行，可以继续按「单服务＋现有 SQLite/KV＋统一轮询器」实现。需要补齐的重点是命令重试、运行 claim、Agent 恢复和外部进程生命周期之间的契约。不需要增加调度进程、数据库或配置体系。", 1800),
		ask(2, fxDay(1, 20), "补充：命令重试放在统一轮询器里是否仍然满足幂等？", 0),
		review(2, fxDay(1, 21), "waiting", "", 0),
	)
	return m, tl
}

func fxOtherMissions() []taskMission {
	now := time.Now()
	return []taskMission{
		{ID: "m_convorel", Title: "Convorel 1.0：Go 常驻进程 + 直连 CDP", State: "closed", Workspace: "/home/mocha/opensource/convorel-go-1-0", Counts: map[string]int{"accepted": 11}, Total: 11, Activity: "任务结束", ClosedAt: 1, LastActivityAt: fxRecent(3 * time.Hour)},
		{ID: "m_smoke1", Title: "opencode 库清理后冒烟", State: "closed", Workspace: "/home/mocha/smoke", Counts: map[string]int{"accepted": 1, "cancelled": 1}, Total: 2, Activity: "任务结束", ClosedAt: 1, LastActivityAt: now.AddDate(0, 0, -2).UnixMilli()},
		{ID: "m_smoke2", Title: "清理后冒烟", State: "closed", Workspace: "/home/mocha/smoke", Counts: map[string]int{"accepted": 3, "cancelled": 1}, Total: 4, Activity: "任务结束", ClosedAt: 1, LastActivityAt: now.AddDate(0, 0, -2).Add(-time.Hour).UnixMilli()},
		{ID: "m_switch", Title: "2.0 切换冒烟", State: "closed", Workspace: "/home/mocha/smoke", Counts: map[string]int{"accepted": 2}, Total: 2, Activity: "任务结束", ClosedAt: 1, LastActivityAt: now.AddDate(0, 0, -5).UnixMilli()},
	}
}

func newTasksFake(t *testing.T) *tasksFake {
	t.Helper()
	home := t.TempDir()
	f := &tasksFake{fakeService: &fakeService{home: home, data: fixture(home)}, timelines: map[string]*taskTimeline{}, texts: map[string]kernel.MissionTextResult{}, textErrors: map[string]string{}, packages: map[string]taskPackage{}}
	tl := fxMainTimeline()
	f.missions = append([]taskMission{*tl.Mission}, fxOtherMissions()...)
	f.timelines[fxMain] = tl
	for _, m := range fxOtherMissions() {
		other := m
		f.timelines[m.ID] = &taskTimeline{Mission: &other, Session: taskSession{State: "none"}}
		fxAdd(f.timelines[m.ID], taskEntry{Kind: "created", At: m.LastActivityAt - 3600_000}, taskEntry{Kind: "closed", At: m.LastActivityAt})
	}
	f.texts[fxMain+"|result:att-shell-1"] = kernel.MissionTextResult{Title: "shell · 第 1 次结果", Text: "## 结果\n\n仅新增 `cmd/weaver-gui/` 下 9 个文件。\n\n- `go vet` 通过\n- `go test -race` 通过\n\n完整结果正文在这里。"}
	f.texts[fxMain+"|session:"+fmt.Sprint(fxDay(21, 23)/1000)] = kernel.MissionTextResult{Title: "Claude · 21:23", Text: "# 方案设计文档\n\n**全文**第一段。\n\n" + fxLongReply}
	f.packages[fxMain+"/tasks-gui"] = taskPackage{ID: fxMain + "/tasks-gui", Key: "tasks-gui", Title: "界面：任务页与自动归档设置", Instruction: "## 指令\n实现任务页", State: "accepted", Worker: "codex_sol_medium", Attempt: 2,
		Attempts: []*taskAttempt{{N: 1, State: "returned", Worker: "codex_sol_medium", Result: "## 第一次结果\n列表和详情已完成"}, {N: 2, State: "accepted", Worker: "codex_sol_medium", Note: "按退回意见：把主任务状态和包状态分成两个映射", Result: "## 第二次结果\n状态词已分开"}}}
	f.artifacts = []taskArtifactGroup{
		{GroupKey: "design", Items: []taskArtifact{{ID: "design-v2", Kind: "design", Title: "设计 v2", URL: "https://example.org/design-v2", Summary: map[string]any{"decisions": 3, "checks": 9}}}},
		{GroupKey: "report", Items: []taskArtifact{{ID: "report", Kind: "report", Title: "验收报告", Summary: map[string]any{"verdict": "未完成", "pass": 8, "fail": 1}, URL: "https://example.org/report"}}},
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
				_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
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

// addMission lists a mission and gives it a timeline.
func (f *tasksFake) addMission(m taskMission, tl *taskTimeline) {
	f.taskMu.Lock()
	defer f.taskMu.Unlock()
	f.missions = append(f.missions, m)
	f.timelines[m.ID] = tl
}

func (f *tasksFake) callsOf(method string) []fakeCall {
	f.taskMu.Lock()
	defer f.taskMu.Unlock()
	var out []fakeCall
	for _, c := range f.calls {
		if c.Method == method {
			out = append(out, c)
		}
	}
	return out
}

func (f *tasksFake) methods() []string {
	f.taskMu.Lock()
	defer f.taskMu.Unlock()
	var out []string
	for _, c := range f.calls {
		out = append(out, c.Method)
	}
	return out
}

func (f *tasksFake) mission(id string) (taskMission, bool) {
	for _, m := range append(append([]taskMission{}, f.missions...), f.archived...) {
		if m.ID == id {
			return m, true
		}
	}
	return taskMission{}, false
}

// edit changes a timeline under the lock the service handlers use.
func (f *tasksFake) edit(id string, change func(*taskTimeline)) {
	f.taskMu.Lock()
	defer f.taskMu.Unlock()
	change(f.timelines[id])
}

// timeline mirrors Kernel.Timeline's slicing; the caller holds taskMu.
func (f *tasksFake) timeline(in kernel.TimelineInput) (*taskTimeline, *rpc.Error) {
	t := f.timelines[in.Mission]
	if t == nil {
		return nil, &rpc.Error{Code: "NOT_FOUND", Message: "主任务 " + in.Mission + " 不存在"}
	}
	if f.timelineError != "" {
		return nil, &rpc.Error{Code: "INTERNAL", Message: f.timelineError}
	}
	out := &taskTimeline{Packages: t.Packages, Session: t.Session, Mission: t.Mission}
	if m, ok := f.mission(in.Mission); ok {
		out.Mission = &m
	}
	all := t.Entries
	if in.From != "" {
		start := sort.Search(len(all), func(i int) bool { return all[i].Ord >= in.From })
		out.HasMore = start > 0
		all = all[start:]
		for out.Keep < len(in.Have) && out.Keep < len(all) && in.Have[out.Keep] == all[out.Keep].Hash {
			out.Keep++
		}
		out.Entries = all[out.Keep:]
	} else {
		end := len(all)
		if in.Before != "" {
			end = sort.Search(len(all), func(i int) bool { return all[i].Ord >= in.Before })
		}
		limit := in.Limit
		if limit <= 0 {
			limit = f.pageSize
		}
		if limit <= 0 {
			limit = 300
		}
		start := max(0, end-limit)
		out.HasMore = start > 0
		out.Entries = all[start:end]
	}
	return out, nil
}

func (f *tasksFake) respondTasks(conn net.Conn, req rpc.Request) {
	var p map[string]any
	_ = json.Unmarshal(req.Params, &p)
	var in kernel.TimelineInput
	if req.Method == "mission.timeline" {
		_ = json.Unmarshal(req.Params, &in)
	}
	f.taskMu.Lock()
	if req.Method != "status" {
		f.calls = append(f.calls, fakeCall{req.Method, p})
	}
	f.taskMu.Unlock()
	var result any
	var failure *rpc.Error
	str := func(k string) string { s, _ := p[k].(string); return s }
	switch req.Method {
	case "mission.timeline":
		// A wait with nothing new holds the call, like the service, but only briefly.
		deadline := time.Now().Add(400 * time.Millisecond)
		for {
			f.taskMu.Lock()
			out, err := f.timeline(in)
			f.taskMu.Unlock()
			if err != nil {
				failure = err
				break
			}
			result = out
			if !in.Wait || in.From == "" || out.Keep != len(in.Have) || len(out.Entries) > 0 || time.Now().After(deadline) {
				break
			}
			time.Sleep(10 * time.Millisecond)
		}
	case "mission.list":
		f.taskMu.Lock()
		result = append([]taskMission{}, f.missions...)
		if archived, _ := p["archived"].(bool); archived {
			result = append([]taskMission{}, f.archived...)
		}
		if f.listError != "" {
			failure = &rpc.Error{Code: "INTERNAL", Message: f.listError}
		}
		f.taskMu.Unlock()
	case "mission.text":
		f.taskMu.Lock()
		key := str("mission") + "|" + str("ref")
		if msg := f.textErrors[key]; msg != "" {
			failure = &rpc.Error{Code: "NOT_FOUND", Message: msg}
		} else if text, ok := f.texts[key]; ok {
			result = text
		} else {
			failure = &rpc.Error{Code: "NOT_FOUND", Message: "正文不属于这个主任务"}
		}
		f.taskMu.Unlock()
	case "package.show":
		f.taskMu.Lock()
		if pkg, ok := f.packages[str("package")]; ok {
			result = pkg
		} else {
			failure = &rpc.Error{Code: "NOT_FOUND", Message: "工作包 " + str("package") + " 不存在"}
		}
		f.taskMu.Unlock()
	case "artifact.list":
		f.taskMu.Lock()
		groups := []kernel.ArtifactGroup{}
		for _, group := range f.artifacts {
			g := kernel.ArtifactGroup{GroupKey: group.GroupKey, Items: []*kernel.Artifact{}}
			for _, item := range group.Items {
				summary, _ := json.Marshal(item.Summary)
				g.Items = append(g.Items, &kernel.Artifact{ID: item.ID, Kind: item.Kind, Title: item.Title, Path: item.Path, URL: item.URL, CreatedAt: item.CreatedAt, Summary: summary})
			}
			groups = append(groups, g)
		}
		result = groups
		f.taskMu.Unlock()
	case "mission.archive", "mission.unarchive":
		archive := req.Method == "mission.archive"
		f.taskMu.Lock()
		source, dest := &f.archived, &f.missions
		if archive {
			source, dest = &f.missions, &f.archived
		}
		for i, m := range *source {
			if m.ID == str("mission") {
				m.Archived = archive
				*dest = append(*dest, m)
				*source = append((*source)[:i], (*source)[i+1:]...)
				result = m
				break
			}
		}
		f.taskMu.Unlock()
	default:
		f.fakeService.respond(conn, req)
		return
	}
	body, _ := json.Marshal(result)
	_ = json.NewEncoder(conn).Encode(rpc.Response{OK: failure == nil, Result: body, Error: failure})
}

func tasksTester(t *testing.T, w, h int) (*tasksFake, *app, *ui.Tester) {
	t.Helper()
	return tasksTesterWith(t, w, h, nil)
}

// tasksTesterWith lets a test shape the fixtures before the first list read.
func tasksTesterWith(t *testing.T, w, h int, setup func(*tasksFake)) (*tasksFake, *app, *ui.Tester) {
	t.Helper()
	f := newTasksFake(t)
	if setup != nil {
		setup(f)
	}
	a := testApp(t, f.fakeService)
	a.page = "任务"
	tt := ui.NewTester(a.view, w, h)
	tasksWait(t, tt, fxTitle, 5*time.Second)
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

// tasksGone waits for text to leave the page.
func tasksGone(t *testing.T, tt *ui.Tester, text string, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		tt.Frame()
		if !tt.HasText(text) {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("%q 没有消失: %q", text, tt.Texts())
}

func tasksContains(t *testing.T, tt *ui.Tester, texts ...string) {
	t.Helper()
	for _, text := range texts {
		if !tt.HasText(text) {
			t.Errorf("缺少 %q: %q", text, tt.Texts())
		}
	}
}

func tasksAbsent(t *testing.T, tt *ui.Tester, texts ...string) {
	t.Helper()
	for _, text := range texts {
		if tt.HasText(text) {
			t.Errorf("不该出现 %q: %q", text, tt.Texts())
		}
	}
}

// openTask opens a task from the list and waits for its first entry.
func openTask(t *testing.T, tt *ui.Tester, title, waitFor string) {
	t.Helper()
	click(t, tt, title)
	tasksWait(t, tt, waitFor, 5*time.Second)
	tt.Advance(300 * time.Millisecond)
	tt.Frame()
}

// before orders two texts on the page: true when a is listed before b.
func tasksOrdered(tt *ui.Tester, a, b string) bool {
	ia, ib := -1, -1
	for i, text := range tt.Texts() {
		if ia < 0 && strings.Contains(text, a) {
			ia = i
		}
		if ib < 0 && strings.Contains(text, b) {
			ib = i
		}
	}
	return ia >= 0 && ib >= 0 && ia < ib
}

// seedLog records the seeds the avatars on a page were drawn with.
type seedLog struct {
	mu    sync.Mutex
	seeds []string
}

func watchAvatars(t *testing.T) *seedLog {
	t.Helper()
	l := &seedLog{}
	taskAvatarObserver = func(seed, avoid string, size float32) {
		l.mu.Lock()
		l.seeds = append(l.seeds, fmt.Sprintf("%s|%s|%g", seed, avoid, size))
		l.mu.Unlock()
	}
	t.Cleanup(func() { taskAvatarObserver = nil })
	return l
}

func (l *seedLog) reset() {
	l.mu.Lock()
	l.seeds = nil
	l.mu.Unlock()
}

func (l *seedLog) set() map[string]bool {
	out := map[string]bool{}
	for _, s := range l.all() {
		out[s] = true
	}
	return out
}

func (l *seedLog) all() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string{}, l.seeds...)
}
