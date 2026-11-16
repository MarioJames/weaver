package main

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/MarioJames/weaver/internal/kernel"
	"github.com/egoist/mygo/ui"
)

// A tall window lays the whole conversation out at once.
func detailTester(t *testing.T, w int) (*tasksFake, *app, *ui.Tester) {
	t.Helper()
	f, a, tt := tasksTester(t, w, 4200)
	openTask(t, tt, fxTitle, "创建主任务")
	return f, a, tt
}

func rectOf(t *testing.T, tt *ui.Tester, text string) ui.Rect {
	t.Helper()
	r, ok := tt.Find(text)
	if !ok {
		t.Fatalf("找不到 %q：%q", text, tt.Texts())
	}
	return r
}

func nth(tt *ui.Tester, text string, n int) int {
	seen := 0
	for i, s := range tt.Texts() {
		if s == text {
			if seen == n {
				return i
			}
			seen++
		}
	}
	return -1
}

func indexOf(tt *ui.Tester, sub string) int {
	for i, s := range tt.Texts() {
		if strings.Contains(s, sub) {
			return i
		}
	}
	return -1
}

// lines is the most text rows a box of this height can hold.
func lines(r ui.Rect, size, lineHeight float32) int { return int((r.H + 1) / (size * lineHeight)) }

// A4, A20: the dispatch is one card; operations stay folded; the conversation starts with the first message.
func TestTaskDetailDispatchAndOrder(t *testing.T) {
	seeds := watchAvatars(t)
	_, _, tt := detailTester(t, 1180)
	tasksContains(t, tt, "返回任务列表", fxTitle, "已完成", "18 / 19 已采纳 · 1 已取消 · Claude · weaver-gui", "产物 2", "归档",
		"派出 6 个 Agent", "全部已采纳", "派出 2 个 Agent")
	for _, row := range [][]string{
		{"server", "服务：渠道配置读回、模型拉取、用量查询", "opencode_deepseek", "18 分钟"},
		{"shell", "界面：应用骨架、概览页与设置页", "codex_sol_medium", "10 分钟"},
		{"accounts", "界面：账号页", "opencode_deepseek", "38 分钟"},
		{"workers", "界面：候选页", "codex_sol_medium", "6 分钟"},
		{"login", "界面：订阅账号在窗口内嵌终端登录", "opencode_deepseek", "20 分钟"},
		{"dist", "构建与分发：产物、安装脚本与发布流水线", "codex_sol_medium", "4 分钟"},
	} {
		tasksContains(t, tt, row...)
		if !strings.Contains(strings.Join(seeds.all(), "\n"), fxMain+"/"+row[0]+"||22|") && !strings.Contains(strings.Join(seeds.all(), "\n"), fxMain+"/"+row[0]+"||22") {
			t.Errorf("%s 没有头像", row[0])
		}
	}
	if n := strings.Count(strings.Join(tt.Texts(), "\n"), "已采纳"); n < 6 {
		t.Errorf("派出卡片状态太少：%d", n)
	}
	tasksAbsent(t, tt, "weaver plan submit", "weaver wait", "任务创建前", "没能读取")
	if !tasksOrdered(tt, "基于最新版 Weaver 的能力", "正在梳理 Weaver 2.0") || !tasksOrdered(tt, "你 · 21:14", "4 步操作") {
		t.Fatalf("第一条不是最早的用户消息：%q", tt.Texts())
	}
	// Operations before the owner's first words belong under the owner's header.
	tasksAbsent(t, tt, "父 Agent 做了 4 步操作")
	if !tasksOrdered(tt, "Claude", "4 步操作") || !tasksOrdered(tt, "4 步操作", "正在梳理 Weaver 2.0") {
		t.Fatalf("开头的操作没有归到父 Agent 名下：%q", tt.Texts())
	}
	if !tasksOrdered(tt, "创建主任务", "派出 6 个 Agent") || !tasksOrdered(tt, "基于最新版 Weaver 的能力", "创建主任务") {
		t.Fatalf("创建主任务应在派出之前：%q", tt.Texts())
	}
	if i := indexOf(tt, "基于最新版"); i < 0 {
		t.Fatal("没有第一条用户消息")
	}
}

// A5: returned, the package's second speech, then accepted, in that order.
func TestTaskDetailReturnedResultAccepted(t *testing.T) {
	_, _, tt := detailTester(t, 1180)
	note := "结构和功能通过，以下内容问题需要修（只改任务页自己的文件 page_tasks.go、task_*.go 及其测试，其他文件不动）：1) task_models.go 的状态词：包的 running 必须显示「运行中」，主任务的 running 才显示「进行中」。把主任务状态和包状态分成两个映射，别共用一个。2) 列表行的进度写法。3) 归档按钮的位置。"
	tasksContains(t, tt, "退回", "codex_sol_medium · 第 2 次", "查看全文 · 380 字", "查看全文 · 734 字")
	returned, meta := indexOf(tt, "结构和功能通过"), indexOf(tt, "codex_sol_medium · 第 2 次")
	result, accepted := indexOf(tt, "我会按退回意见，只修改任务页文件"), nth(tt, "采纳", 1)
	if !(returned >= 0 && returned < meta && meta < result && result < accepted) {
		t.Fatalf("顺序不对：退回 %d 发言 %d 结果 %d 采纳 %d\n%q", returned, meta, result, accepted, tt.Texts())
	}
	quote := rectOf(t, tt, taskPlainText(note))
	if n := lines(quote, 13, 1.6); n != 2 {
		t.Errorf("退回意见 %d 行，want 2（%+v）", n, quote)
	}
	text := rectOf(t, tt, taskPlainText(strings.Split(`我会按退回意见，只修改任务页文件及对应测试，核对状态文案、行样式和报告摘要后重跑检查、覆盖三张截图。本次仅修改 page_tasks.go、task_models.go、task_page_test.go：分开主任务与包状态映射：包显示「运行中」，主任务保留「进行中」。

- 列表行进度改为 18 / 19
- 归档移到详情页右上角`, "\n")[0]+"\n\n"+"- 列表行进度改为 18 / 19\n- 归档移到详情页右上角"))
	if n := lines(text, 14, 1.6); n != 3 {
		t.Errorf("子 Agent 对话框 %d 行，want 3", n)
	}
}

// A6, A27: the problem card keeps the original reason and is the only tinted card.
func TestTaskDetailProblemCard(t *testing.T) {
	for _, dark := range []bool{false, true} {
		t.Run(fmt.Sprint("dark=", dark), func(t *testing.T) {
			_, _, tt := tasksTester(t, 1180, 4200)
			tt.SetDark(dark)
			openTask(t, tt, fxTitle, "创建主任务")
			tasksContains(t, tt, "acceptance", "失败", "第 1 次尝试", "引擎中途退出：opencode 常驻服务进程已退出，这次运行随之中断", "重试", "再次失败", "取消")
			if !(indexOf(tt, "上一次因 opencode") > nth(tt, "重试", 0) && nth(tt, "再次失败", 0) > nth(tt, "重试", 0) && nth(tt, "取消", 0) > nth(tt, "再次失败", 0)) {
				t.Fatalf("处置步骤顺序：%q", tt.Texts())
			}
			img := tt.Image()
			px := func(text string) bool {
				r := rectOf(t, tt, text)
				return tinted(img.At(int(r.X)-8, int(r.Y+r.H/2)))
			}
			if !px("引擎中途退出：opencode 常驻服务进程已退出，这次运行随之中断") {
				t.Error("问题卡片没有颜色底")
			}
			for _, text := range []string{"服务：渠道配置读回、模型拉取、用量查询", "我会按退回意见，只修改任务页文件", "方案素材已齐", "骨架、概览、设置通过"} {
				i := indexOf(tt, text)
				if i < 0 {
					t.Fatalf("没有 %q", text)
				}
				full := tt.Texts()[i]
				if px(full) && !strings.HasPrefix(full, "骨架") {
					t.Errorf("%q 带了颜色底", text)
				}
			}
		})
	}
}

// A7: the operations row folds and unfolds; a row outside the owner's group names the owner.
func TestTaskDetailOperationsFold(t *testing.T) {
	_, _, tt := detailTester(t, 1180)
	tasksContains(t, tt, "父 Agent 做了 6 步操作")
	tasksAbsent(t, tt, "weaver package result 1")
	click(t, tt, "父 Agent 做了 6 步操作")
	for i := 1; i <= 6; i++ {
		tasksContains(t, tt, fmt.Sprintf("weaver package result %d", i))
	}
	// The steps open under the label, not beside it.
	if label, step := rectOf(t, tt, "父 Agent 做了 6 步操作"), rectOf(t, tt, "weaver package result 1"); step.Y < label.Y+label.H || step.X > label.X+60 {
		t.Fatalf("展开的步骤没有排在标题下方：标题 %+v，第一步 %+v", label, step)
	}
	click(t, tt, "父 Agent 做了 6 步操作")
	tasksAbsent(t, tt, "weaver package result 1")
	// Inside the owner's group the label has no prefix, and a minute or more adds its length.
	tasksContains(t, tt, "12 步操作 · 1 分钟", "3 步操作", "3 步操作 · 8 分钟")
}

// A8: the artifact panel is read on demand; a dispatch row opens its package's attempts in order.
func TestTaskDetailPanelsAndPackageDrawer(t *testing.T) {
	f, _, tt := detailTester(t, 1180)
	if n := len(f.callsOf("artifact.list")); n != 0 {
		t.Fatalf("打开详情就读了产物：%d", n)
	}
	click(t, tt, "产物 2")
	tasksWait(t, tt, "验收报告", 3*time.Second)
	tasksContains(t, tt, "设计 · 1", "设计 v2", "待拍板 3 项 · 验收清单 9 项", "验收 · 1", "验收报告", "结论：未完成 · 通过 8 · 失败 1", "打开")
	if n := len(f.callsOf("artifact.list")); n != 1 || f.callsOf("artifact.list")[0].Params["mission"] != fxMain {
		t.Fatalf("artifact.list：%+v", f.callsOf("artifact.list"))
	}
	tasksAbsent(t, tt, "证据 · ", "其他 · ")
	tt.Key(0, ui.KeyEscape)
	tt.Advance(time.Second)
	tasksAbsent(t, tt, "待拍板 3 项")

	click(t, tt, "tasks-gui")
	tasksWait(t, tt, "状态词已分开", 3*time.Second)
	tasksContains(t, tt, "tasks-gui · 已采纳", "实现任务页", "列表和详情已完成", "按退回意见：把主任务状态和包状态分成两个映射", "状态词已分开", "第 1 次", "第 2 次")
	if !(tasksOrdered(tt, "实现任务页", "列表和详情已完成") && tasksOrdered(tt, "列表和详情已完成", "按退回意见：把主任务") && tasksOrdered(tt, "按退回意见：把主任务", "状态词已分开")) {
		t.Fatalf("抽屉里的顺序：%q", tt.Texts())
	}
	calls := f.callsOf("package.show")
	if len(calls) != 1 || calls[0].Params["package"] != fxMain+"/tasks-gui" {
		t.Fatalf("package.show：%+v", calls)
	}
}

// A25: 查看全文 opens the drawer with the service's title and body; the dialog stays clipped and the page keeps its place.
func TestTaskFullTextDrawer(t *testing.T) {
	f, _, tt := tasksTester(t, 1180, 800)
	openTask(t, tt, fxTitle, "创建主任务")
	tt.Scroll(600, 500, 0, 1400)
	tt.Advance(time.Second)
	more := "查看全文 · 612 字"
	tasksWait(t, tt, more, time.Second)
	anchor := rectOf(t, tt, more)
	if anchor.Y < 0 || anchor.Y > 700 || anchor.Y > 1500 {
		t.Fatalf("没有滚到这条发言：%+v", anchor)
	}
	click(t, tt, more)
	tasksWait(t, tt, "shell · 第 1 次结果", 3*time.Second)
	tasksContains(t, tt, "完整结果正文在这里。", "子 Agent")
	if calls := f.callsOf("mission.text"); len(calls) != 1 || calls[0].Params["ref"] != "result:att-shell-1" || calls[0].Params["mission"] != fxMain {
		t.Fatalf("mission.text：%+v", calls)
	}
	bubble := taskPlainText("仅新增 cmd/weaver-gui/ 下 9 个文件：应用入口、状态与路由、RPC 客户端、共用组件、概览页、设置页、两个占位页及测试。完成两秒轮询、离线恢复、设置保存与错误回退、引擎控制及服务/技能操作。验证结果：go vet 通过，race 测试通过。")
	if n := lines(rectOf(t, tt, bubble), 14, 1.6); n > 3 {
		t.Errorf("对话框被撑开到 %d 行", n)
	}
	tt.Key(0, ui.KeyEscape)
	tt.Advance(time.Second)
	tasksAbsent(t, tt, "shell · 第 1 次结果", "完整结果正文在这里。")
	if after := rectOf(t, tt, more); after.Y != anchor.Y {
		t.Errorf("关闭抽屉后滚动位置变了：%.0f → %.0f", anchor.Y, after.Y)
	}
	if n := lines(rectOf(t, tt, bubble), 14, 1.6); n > 3 {
		t.Errorf("关闭后对话框 %d 行", n)
	}
}

func TestTaskFullTextDrawerFailure(t *testing.T) {
	f, _, tt := tasksTester(t, 1180, 4200)
	f.taskMu.Lock()
	f.textErrors[fxMain+"|result:att-shell-1"] = "正文不属于这个主任务"
	f.taskMu.Unlock()
	openTask(t, tt, fxTitle, "创建主任务")
	click(t, tt, "查看全文 · 612 字")
	tasksWait(t, tt, "读取失败", 3*time.Second)
	tasksContains(t, tt, "正文不属于这个主任务")
	tasksAbsent(t, tt, "完整结果正文在这里。")
}

// A31: a body far longer than its preview keeps a six-row dialog and counts the whole body.
func TestTaskLongOwnerSpeech(t *testing.T) {
	f, _, tt := detailTester(t, 1180)
	preview := taskPlainText(fxLongReply)
	r := rectOf(t, tt, preview)
	if n := lines(r, 14, 1.6); n != 6 {
		t.Errorf("父 Agent 对话框 %d 行，want 6", n)
	}
	tasksContains(t, tt, "查看全文 · 1472 字")
	click(t, tt, "查看全文 · 1472 字")
	tasksWait(t, tt, "Claude · 21:23", 3*time.Second)
	tasksContains(t, tt, "方案设计文档", "父 Agent")
	if calls := f.callsOf("mission.text"); len(calls) != 1 || !strings.HasPrefix(fmt.Sprint(calls[0].Params["ref"]), "session:") {
		t.Fatalf("mission.text：%+v", calls)
	}
}

// A26: the four role tags each sit on the right speech; the user's message has none.
func TestTaskRoleTags(t *testing.T) {
	f, _, tt := detailTester(t, 1180)
	tasksContains(t, tt, "父 Agent", "子 Agent")
	tasksAbsent(t, tt, "对谈人", "外部审查")
	user := rectOf(t, tt, "你 · 21:14")
	// The user's header line stands alone: no tag shares its row, and it has no tinted chip.
	for _, tag := range []string{"父 Agent", "子 Agent"} {
		for i := 0; nth(tt, tag, i) >= 0; i++ {
			if r, ok := tt.Find(tag); ok && r.Y == user.Y {
				t.Errorf("用户消息旁出现标签 %s", tag)
			}
		}
	}
	img := tt.Image()
	if tinted(img.At(int(user.X)-6, int(user.Y)+4)) {
		t.Error("用户消息头带了颜色")
	}
	_ = f
	// The dialogue and Convorel tags are checked on their own tasks (TestTaskDialogue, TestTaskConvorel).
}

// A22: the parent's speech, the list row and the header all use the mission ID as the seed.
func TestTaskAvatarSeeds(t *testing.T) {
	seeds := watchAvatars(t)
	_, _, tt := tasksTester(t, 1180, 4200)
	listSeeds := seeds.set()
	if !listSeeds[fxMain+"||32"] || !listSeeds["m_convorel||32"] {
		t.Fatalf("列表行头像：%v", listSeeds)
	}
	seeds.reset()
	openTask(t, tt, fxTitle, "创建主任务")
	seeds.reset()
	tt.Frame()
	detail := seeds.set()
	// The header and every parent speech share the list row's seed; roster rows add the key.
	for _, want := range []string{fxMain + "||28", fxMain + "||32", fxMain + "/shell||32", fxMain + "/tasks-gui||32", fxMain + "/server||22", fxMain + "/dist||22"} {
		if !detail[want] {
			t.Errorf("缺少头像 %s：%v", want, detail)
		}
	}
	for seed := range detail {
		if strings.HasPrefix(seed, "m_convorel") {
			t.Errorf("另一个任务的头像出现在这里：%s", seed)
		}
	}
	click(t, tt, "返回任务列表")
	tasksWait(t, tt, "全部 5", 3*time.Second)
	if taskAvatarSource(fxMain, "") == taskAvatarSource("m_convorel", "") {
		t.Error("另一个任务的头像相同")
	}
	openTask(t, tt, "Convorel 1.0：Go 常驻进程 + 直连 CDP", "任务结束")
	click(t, tt, "返回任务列表")
	seeds.reset()
	openTask(t, tt, fxTitle, "创建主任务")
	seeds.reset()
	tt.Frame()
	again := seeds.set()
	for seed := range detail {
		if !again[seed] {
			t.Errorf("重开后缺少头像 %s", seed)
		}
	}
	if len(again) != len(detail) {
		t.Errorf("重开后头像集合变了：%v vs %v", again, detail)
	}
}

// A9, A14: a session that cannot be read is a one-line notice, not a page error.
func TestTaskSessionNotices(t *testing.T) {
	for _, tc := range []struct {
		state string
		want  string
	}{
		{"none", "未关联父 Agent 会话，只显示调度记录"},
		{"unsupported", "暂不支持读取这个父 Agent 的会话，只显示调度记录"},
		{"missing", "父会话文件已不在，对话显示到 " + taskTime(fxDay(23, 59))},
		{"rewritten", "父会话文件被改写，对话显示到 " + taskTime(fxDay(23, 59))},
		{"ok", ""},
	} {
		t.Run(tc.state, func(t *testing.T) {
			_, _, tt := tasksTesterWith(t, 1180, 4200, func(f *tasksFake) { f.timelines[fxMain].Session.State = tc.state })
			openTask(t, tt, fxTitle, "创建主任务")
			tasksContains(t, tt, "派出 6 个 Agent", "创建主任务", "基于最新版 Weaver 的能力")
			tasksAbsent(t, tt, "没能读取")
			for _, notice := range []string{"未关联父 Agent 会话", "暂不支持读取", "父会话文件"} {
				if has := tt.HasText(notice); has != strings.Contains(tc.want, notice) {
					t.Errorf("%s：%q 显示=%v want %q", tc.state, notice, has, tc.want)
				}
			}
			if tc.want != "" {
				tasksContains(t, tt, tc.want)
			}
		})
	}
	// A mission with no session at all still shows its dispatch record.
	_, _, tt := tasksTester(t, 1180, 820)
	openTask(t, tt, "2.0 切换冒烟", "任务结束")
	tasksContains(t, tt, "未关联父 Agent 会话，只显示调度记录", "创建主任务", "任务结束")
}

// A11, A12: one read opens the detail; after that only suffix long polls, and the list stops polling.
func TestTaskDetailFetchesOnceThenFollows(t *testing.T) {
	f, _, tt := tasksTester(t, 1180, 4200)
	listBefore := len(f.callsOf("mission.list"))
	f.taskMu.Lock()
	f.calls = nil
	f.taskMu.Unlock()
	openTask(t, tt, fxTitle, "创建主任务")
	first := f.callsOf("mission.timeline")
	if len(first) == 0 || first[0].Params["wait"] != nil || first[0].Params["from"] != nil || first[0].Params["mission"] != fxMain {
		t.Fatalf("首次读取：%+v", first)
	}
	total := len(f.timelines[fxMain].Entries)

	f.edit(fxMain, func(tl *taskTimeline) {
		fxAdd(tl, fxOwner(fxDay(23, 55), "新来的一句话：全部检查通过。", 0), taskEntry{Kind: "dispatch", At: fxDay(23, 56), Packages: []string{"login"}})
	})
	tasksWait(t, tt, "新来的一句话：全部检查通过。", 3*time.Second)
	tasksContains(t, tt, "派出 1 个 Agent")
	// The follower sent the entries it already had, and nothing else was read.
	var follow kernel.TimelineInput
	for _, call := range f.callsOf("mission.timeline") {
		if call.Params["wait"] == true && len(call.Params["have"].([]any)) == total {
			follow = kernel.TimelineInput{From: call.Params["from"].(string)}
		}
	}
	if follow.From != "000001" {
		t.Fatalf("没有带 from / have 的 wait 请求：%+v", f.callsOf("mission.timeline"))
	}
	time.Sleep(2300 * time.Millisecond)
	tt.Frame()
	for _, method := range f.methods() {
		if method != "mission.timeline" {
			t.Errorf("详情页还在调用 %s", method)
		}
	}
	if len(f.callsOf("mission.list")) != 0 || listBefore == 0 {
		t.Error("详情页还在轮询列表")
	}
	// Entries after the kept prefix are replaced, not appended.
	f.edit(fxMain, func(tl *taskTimeline) {
		n := len(tl.Entries)
		tl.Entries = tl.Entries[:n-2]
		fxAdd(tl, fxOwner(fxDay(23, 57), "改写后的结尾。", 0))
	})
	tasksWait(t, tt, "改写后的结尾。", 3*time.Second)
	tasksAbsent(t, tt, "新来的一句话：全部检查通过。", "派出 1 个 Agent")
	if got := strings.Count(strings.Join(tt.Texts(), "\n"), "基于最新版 Weaver 的能力"); got != 1 {
		t.Errorf("前缀被重复：%d", got)
	}
}

// Leaving the detail stops the follower; a late answer cannot land in the next task.
func TestTaskLeavingStopsFollowing(t *testing.T) {
	f, _, tt := tasksTester(t, 1180, 900)
	openTask(t, tt, fxTitle, "创建主任务")
	click(t, tt, "返回任务列表")
	tasksWait(t, tt, "全部 5", 3*time.Second)
	time.Sleep(600 * time.Millisecond)
	f.taskMu.Lock()
	f.calls = nil
	f.taskMu.Unlock()
	time.Sleep(900 * time.Millisecond)
	for _, call := range f.callsOf("mission.timeline") {
		t.Errorf("离开后还在读时间线：%+v", call)
	}
	openTask(t, tt, "2.0 切换冒烟", "任务结束")
	f.edit(fxMain, func(tl *taskTimeline) { fxAdd(tl, fxOwner(fxDay(23, 58), "不该出现在别的任务里", 0)) })
	time.Sleep(700 * time.Millisecond)
	tt.Frame()
	tasksAbsent(t, tt, "不该出现在别的任务里")
}

func entriesInViewport(t *testing.T, tt *ui.Tester, text string, h float32) bool {
	t.Helper()
	r, ok := tt.Find(text)
	return ok && r.Y >= 0 && r.Y+r.H <= h
}

func runningMain(f *tasksFake) {
	f.timelines[fxMain].Mission.State, f.timelines[fxMain].Mission.ClosedAt = "running", 0
	f.missions[0].State, f.missions[0].ClosedAt = "running", 0
}

// A running task opens at the bottom and follows; scrolling up stops it, and returning resumes it.
func TestTaskFollowsBottomOnlyWhileAtBottom(t *testing.T) {
	f, _, tt := tasksTesterWith(t, 1180, 800, runningMain)
	openTask(t, tt, fxTitle, "引擎中途退出：opencode 常驻服务进程已退出，这次运行随之中断")
	last := "引擎中途退出：opencode 常驻服务进程已退出，这次运行随之中断"
	if !entriesInViewport(t, tt, last, 800) {
		t.Fatalf("打开进行中的任务没有停在底部：%+v", rectOf(t, tt, last))
	}
	f.edit(fxMain, func(tl *taskTimeline) { fxAdd(tl, fxOwner(fxDay(23, 58), "第一条新内容", 0)) })
	tasksWait(t, tt, "第一条新内容", 3*time.Second)
	tt.Advance(time.Second)
	if !entriesInViewport(t, tt, "第一条新内容", 800) {
		t.Fatalf("新内容到达后没有跟到底部：%+v", rectOf(t, tt, "第一条新内容"))
	}
	// Reading earlier content: new entries must not move it.
	tt.Scroll(600, 500, 0, -700)
	tt.Advance(time.Second)
	anchor := rectOf(t, tt, "计划已提交：服务端（opencode）和界面骨架（codex）并行开工，账号页、候选页、内嵌终端登录、构建分发按依赖排队。等待第一批结果。")
	f.edit(fxMain, func(tl *taskTimeline) { fxAdd(tl, fxOwner(fxDay(23, 59), "第二条新内容", 0)) })
	tasksWait(t, tt, "第二条新内容", 3*time.Second)
	tt.Advance(time.Second)
	after := rectOf(t, tt, "计划已提交：服务端（opencode）和界面骨架（codex）并行开工，账号页、候选页、内嵌终端登录、构建分发按依赖排队。等待第一批结果。")
	if d := after.Y - anchor.Y; d > 1.5 || d < -1.5 {
		t.Fatalf("往上翻之后内容跳动：%.0f → %.0f", anchor.Y, after.Y)
	}
	// Back at the end, following resumes.
	tt.Scroll(600, 500, 0, 20000)
	tt.Advance(time.Second)
	f.edit(fxMain, func(tl *taskTimeline) { fxAdd(tl, fxOwner(fxDay(23, 59), "第三条新内容", 0)) })
	tasksWait(t, tt, "第三条新内容", 3*time.Second)
	tt.Advance(time.Second)
	if !entriesInViewport(t, tt, "第三条新内容", 800) {
		t.Fatalf("回到底部后没有恢复跟随：%+v", rectOf(t, tt, "第三条新内容"))
	}
}

// A mouse wheel glides: its first step is a pixel or two, and following must
// not snap the page back to the end before the glide gets anywhere.
func TestTaskFollowYieldsToMouseWheel(t *testing.T) {
	_, _, tt := tasksTesterWith(t, 1180, 800, runningMain)
	last := "引擎中途退出：opencode 常驻服务进程已退出，这次运行随之中断"
	openTask(t, tt, fxTitle, last)
	before := rectOf(t, tt, last)
	tt.Wheel(600, 500, 0, -300)
	for i := 0; i < 40; i++ {
		tt.Advance(16 * time.Millisecond)
	}
	if after := rectOf(t, tt, last); after.Y-before.Y < 200 {
		t.Fatalf("滚轮往上翻被跟随拉回了底部：%.0f → %.0f", before.Y, after.Y)
	}
}

// A follow request that returns with nothing new is not new content: it must
// not send the page to the end again, which would take a wheel turn that
// started in the same frame away from the reader.
func TestTaskFollowIgnoresAnEmptyAnswer(t *testing.T) {
	_, _, tt := tasksTesterWith(t, 1180, 800, runningMain)
	last := "引擎中途退出：opencode 常驻服务进程已退出，这次运行随之中断"
	openTask(t, tt, fxTitle, last)
	before := rectOf(t, tt, last)
	// The fake holds a follow request for 400 ms, then answers that nothing changed.
	time.Sleep(600 * time.Millisecond)
	tt.Wheel(600, 500, 0, -300)
	for i := 0; i < 40; i++ {
		tt.Advance(16 * time.Millisecond)
	}
	if after := rectOf(t, tt, last); after.Y-before.Y < 200 {
		t.Fatalf("空的跟随应答把滚轮往上翻拉回了底部：%.0f → %.0f", before.Y, after.Y)
	}
}

// A finished task opens at the top.
func TestTaskFinishedOpensAtTop(t *testing.T) {
	_, _, tt := tasksTester(t, 1180, 600)
	openTask(t, tt, fxTitle, "创建主任务")
	if !entriesInViewport(t, tt, "基于最新版 Weaver 的能力，以及之前聊过的 Lobe My Go UI 框架和 My Go Framework，做一个 Weaver 图形化界面，覆盖目前所有的配置化能力。先做个方案出来", 600) {
		t.Fatalf("已结束的任务没有停在顶部：%q", tt.Texts())
	}
}

// With more history than one page, the first entry is a button that prepends it without moving the view.
func TestTaskShowEarlierKeepsPlace(t *testing.T) {
	f, _, tt := tasksTesterWith(t, 1180, 800, func(f *tasksFake) { f.pageSize = 20 })
	total := len(f.timelines[fxMain].Entries)
	click(t, tt, fxTitle)
	head := f.timelines[fxMain].Entries[total-20]
	if head.Kind != "owner" {
		t.Fatalf("夹具变了：第一页第一条是 %s", head.Kind)
	}
	tasksWait(t, tt, "显示更早的内容", 3*time.Second)
	tt.Advance(500 * time.Millisecond)
	tasksAbsent(t, tt, "基于最新版 Weaver 的能力")
	anchor := rectOf(t, tt, taskPlainText(head.Text))
	click(t, tt, "显示更早的内容")
	tasksWait(t, tt, "基于最新版 Weaver 的能力", 3*time.Second)
	var before map[string]any
	for _, call := range f.callsOf("mission.timeline") {
		if call.Params["before"] != nil {
			before = call.Params
		}
	}
	if before == nil || before["before"] != f.timelines[fxMain].Entries[total-20].Ord {
		t.Fatalf("没有带 before 取上一页：%+v", f.callsOf("mission.timeline"))
	}
	tt.Advance(time.Second)
	tt.Frame()
	tasksAbsent(t, tt, "显示更早的内容")
	if after := rectOf(t, tt, taskPlainText(head.Text)); after.Y-anchor.Y > 2 || anchor.Y-after.Y > 2 {
		t.Fatalf("取上一页后阅读位置跳了：%.0f → %.0f", anchor.Y, after.Y)
	}
}

// Unreachable timelines show a retrying error, then recover.
func TestTaskDetailErrorRetries(t *testing.T) {
	f, _, tt := tasksTester(t, 1180, 900)
	f.taskMu.Lock()
	f.timelineError = "时间线暂时读不出来"
	f.taskMu.Unlock()
	click(t, tt, fxTitle)
	tasksWait(t, tt, "时间线暂时读不出来", 3*time.Second)
	tasksContains(t, tt, "返回任务列表", fxTitle)
	f.taskMu.Lock()
	f.timelineError = ""
	f.taskMu.Unlock()
	tasksWait(t, tt, "创建主任务", 5*time.Second)
}

// The timeline's 登记产物 row and the panel open artifacts the way the old page did; no artifacts is said plainly.
func TestTaskArtifactsOpenAndEmpty(t *testing.T) {
	f, a, tt := detailTester(t, 1180)
	opened := make(chan string, 4)
	runCommand = func(_ context.Context, name string, args ...string) ([]byte, error) {
		opened <- name + " " + strings.Join(args, " ")
		return nil, nil
	}
	f.edit(fxMain, func(tl *taskTimeline) {
		fxAdd(tl, taskEntry{Kind: "artifact", At: fxDay(23, 58), Artifact: &kernel.TimelineArtifact{ID: "design-v2", Kind: "design", Title: "设计 v2", URL: "https://example.org/design-v2"}})
	})
	tasksWait(t, tt, "登记产物", 3*time.Second)
	tasksContains(t, tt, "设计 v2")
	click(t, tt, "打开")
	select {
	case got := <-opened:
		if got != "xdg-open https://example.org/design-v2" {
			t.Fatalf("打开：%s", got)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("没有打开产物")
	}
	waitFor(t, tt, a, func() bool { return !a.busy["artifact:open:design-v2"] })
	f.taskMu.Lock()
	f.artifacts = nil
	f.taskMu.Unlock()
	click(t, tt, "产物 2")
	tasksWait(t, tt, "还没有产物", 3*time.Second)
	tasksContains(t, tt, "分享时加 --mission <主任务 ID>，或用 weaver artifact add 登记")
}
