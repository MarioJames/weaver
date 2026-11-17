package main

import (
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
)

// A1: five tasks make a full-page list with no conversation pane.
func TestTaskListIsTheLandingPage(t *testing.T) {
	seeds := watchAvatars(t)
	_, _, tt := tasksTester(t, 1180, 820)
	tasksContains(t, tt, "全部 5", "进行中 0", "需关注 0", "已完成 5", "已归档 0", "今天", "3 天内", "更早",
		fxTitle, "Claude · weaver-gui", "18 / 19", "1 已取消", "产物 2", "采纳 report-update", "未关联父会话 · convorel-go-1-0")
	rows := 0
	for _, text := range tt.Texts() {
		if text == "已完成" {
			rows++
		}
	}
	if rows != 5 {
		t.Fatalf("状态标签 %d 个，want 5 行：%q", rows, tt.Texts())
	}
	tasksAbsent(t, tt, "选择一个任务，查看父 Agent 对话", "返回对话", "返回任务列表", "搜索")
	if !tasksOrdered(tt, fxTitle, "Convorel 1.0") || !tasksOrdered(tt, "Convorel 1.0", "opencode 库清理后冒烟") || !tasksOrdered(tt, "opencode 库清理后冒烟", "2.0 切换冒烟") {
		t.Fatalf("组内或组间顺序不对：%q", tt.Texts())
	}
	// Every row carries its own task's portrait, seeded by the mission ID.
	if got := strings.Join(seeds.all(), "\n"); !strings.Contains(got, fxMain+"||32") || !strings.Contains(got, "m_convorel||32") {
		t.Fatalf("列表头像种子：%s", got)
	}
}

// A2: the filter and the scroll position survive a trip into a task.
func TestTaskListKeepsFilterAndScroll(t *testing.T) {
	_, _, tt := tasksTesterWith(t, 1180, 380, func(f *tasksFake) {
		f.missions[1].State, f.missions[1].ClosedAt = "running", 0
		f.missions[1].Title = "仍在进行的任务"
	})
	click(t, tt, "已完成 4")
	tasksAbsent(t, tt, "仍在进行的任务")
	last, ok := tt.Find("2.0 切换冒烟")
	if !ok {
		t.Fatalf("没有末行：%q", tt.Texts())
	}
	tt.Scroll(600, 250, 0, 1000)
	tt.Advance(time.Second)
	scrolled, _ := tt.Find("2.0 切换冒烟")
	if scrolled.Y >= last.Y-20 {
		t.Fatalf("列表没有滚动：%.0f → %.0f", last.Y, scrolled.Y)
	}
	openTask(t, tt, "2.0 切换冒烟", "任务结束")
	tasksAbsent(t, tt, "已完成 4")
	click(t, tt, "返回任务列表")
	tasksWait(t, tt, "已完成 4", 3*time.Second)
	tasksAbsent(t, tt, "仍在进行的任务")
	back, ok := tt.Find("2.0 切换冒烟")
	if !ok || back.Y != scrolled.Y {
		t.Fatalf("滚动位置变了：%.0f → %.0f（%v）", scrolled.Y, back.Y, ok)
	}
}

// A3: a task whose main state is attention says why, with an icon.
func TestTaskListAttention(t *testing.T) {
	_, _, tt := tasksTesterWith(t, 1180, 820, func(f *tasksFake) {
		f.missions[1].State, f.missions[1].ClosedAt = "attention", 0
		f.missions[1].Activity = "acceptance 失败：引擎中途退出"
	})
	tasksContains(t, tt, "需关注 1", "已完成 4", "进行中 0", "需关注", "acceptance 失败：引擎中途退出")
	click(t, tt, "需关注 1")
	tasksContains(t, tt, "Convorel 1.0：Go 常驻进程 + 直连 CDP", "acceptance 失败：引擎中途退出")
	tasksAbsent(t, tt, fxTitle)
}

// A failed dialogue side is named as such and counts as needing attention.
func TestTaskListDialogueError(t *testing.T) {
	_, _, tt := tasksTesterWith(t, 1180, 820, func(f *tasksFake) {
		f.missions[1].State, f.missions[1].ClosedAt = "dialogue_error", 0
		f.missions[1].Activity = "design.r1.b 失败：模型不可用"
	})
	tasksContains(t, tt, "需关注 1", "进行中 0", "对谈异常", "design.r1.b 失败：模型不可用")
	tasksAbsent(t, tt, "dialogue_error")
	click(t, tt, "需关注 1")
	tasksContains(t, tt, "对谈异常", "design.r1.b 失败：模型不可用")
	tasksAbsent(t, tt, fxTitle)
}

func TestTaskListReadFailure(t *testing.T) {
	f := newTasksFake(t)
	f.listError = "数据库暂时不可读"
	a := testApp(t, f.fakeService)
	a.page = "任务"
	tt := ui.NewTester(a.view, 1180, 820)
	tasksWait(t, tt, "没能读取任务", 5*time.Second)
	tasksContains(t, tt, "数据库暂时不可读", "重新读取")
	f.taskMu.Lock()
	f.listError = ""
	f.taskMu.Unlock()
	click(t, tt, "重新读取")
	tasksWait(t, tt, fxTitle, 5*time.Second)
}

// A18: archiving from the detail returns to the list, where 恢复 puts it back.
func TestTaskArchiveAndRestore(t *testing.T) {
	f, _, tt := tasksTester(t, 1180, 820)
	openTask(t, tt, fxTitle, "创建主任务")
	click(t, tt, "归档")
	tasksWait(t, tt, "已归档 1", 5*time.Second)
	// The list keeps the filter it had; the archived task is no longer in it.
	tasksAbsent(t, tt, "返回任务列表", "创建主任务", fxTitle, "恢复")
	tasksContains(t, tt, "全部 4", "今天")
	click(t, tt, "已归档 1")
	tasksWait(t, tt, "恢复", 5*time.Second)
	tasksContains(t, tt, fxTitle)
	if calls := f.callsOf("mission.archive"); len(calls) != 1 || calls[0].Params["mission"] != fxMain {
		t.Fatalf("归档请求：%+v", calls)
	}
	click(t, tt, "恢复")
	tasksWait(t, tt, "已归档 0", 5*time.Second)
	tasksWait(t, tt, "今天", 5*time.Second)
	tasksContains(t, tt, fxTitle, "全部 5", "采纳 report-update")
	tasksAbsent(t, tt, "恢复")
	if !tasksOrdered(tt, "今天", fxTitle) || !tasksOrdered(tt, fxTitle, "3 天内") {
		t.Fatalf("没有回到原分组：%q", tt.Texts())
	}
}

// A19: the narrow window keeps the same structure and keeps everything on screen.
func TestTaskNarrowWalkthrough(t *testing.T) {
	for _, width := range []int{860, 760} {
		t.Run(time.Duration(width).String(), func(t *testing.T) {
			_, _, tt := tasksTester(t, width, 900)
			onScreen := func(texts ...string) {
				t.Helper()
				for _, text := range texts {
					r, ok := tt.Find(text)
					if !ok {
						t.Errorf("找不到 %q", text)
						continue
					}
					if r.X < 0 || r.X+r.W > float32(width)+0.5 {
						t.Errorf("%q 超出窗口 %d：%+v", text, width, r)
					}
				}
			}
			tasksContains(t, tt, "18 / 19", "1 已取消", "产物 2", "采纳 report-update", "Claude · weaver-gui")
			onScreen("18 / 19", "1 已取消", "产物 2", "采纳 report-update", fxTitle)
			openTask(t, tt, fxTitle, "创建主任务")
			onScreen("返回任务列表", "产物 2", "归档", "派出 6 个 Agent", "计划已提交：服务端（opencode）和界面骨架（codex）并行开工，账号页、候选页、内嵌终端登录、构建分发按依赖排队。等待第一批结果。")
			click(t, tt, "产物 2")
			tasksWait(t, tt, "验收报告", 3*time.Second)
			tt.Advance(time.Second)
			onScreen("设计 v2", "验收报告")
			tt.Key(0, ui.KeyEscape)
			tt.Advance(time.Second)
			tasksAbsent(t, tt, "验收报告")
			onScreen("返回任务列表")
			click(t, tt, "返回任务列表")
			tasksWait(t, tt, "全部 5", 3*time.Second)
			onScreen(fxTitle)
		})
	}
}

// A27: dumps the review screenshots when WEAVER_TASK_SHOTS names a directory.
func shotTo(t *testing.T, dir, name string, tt *ui.Tester) {
	t.Helper()
	tt.Advance(400 * time.Millisecond)
	tt.Frame()
	file, err := os.Create(filepath.Join(dir, name))
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if err := png.Encode(file, tt.Image()); err != nil {
		t.Fatal(err)
	}
}

func tinted(c color.Color) bool {
	r, g, b, _ := c.RGBA()
	d := func(x, y uint32) int {
		if x > y {
			return int(x-y) >> 8
		}
		return int(y-x) >> 8
	}
	return d(r, b) >= 5 || d(r, g) >= 5
}

func TestTasksAutoArchiveSetting(t *testing.T) {
	f := newFake(t)
	a := testApp(t, f)
	tt := ui.NewTester(a.view, 1440, 1000)
	click(t, tt, "设置")
	tasksContains(t, tt, "自动归档", "父 Agent 已关闭的任务在这么多天没有活动后归档，未关闭的从不自动归档")
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

// TestTaskScreenshots writes the task page's review screenshots when
// WEAVER_GUI_SCREENSHOTS names a directory, the same switch TestScreenshots uses.
func TestTaskScreenshots(t *testing.T) {
	dir := os.Getenv("WEAVER_GUI_SCREENSHOTS")
	if dir == "" {
		t.Skip("未设置截图目录")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	both := func(f *tasksFake) { withDialogue(f); withConvorel(f) }
	run := func(name string, w, h int, dark bool, setup func(*tasksFake), steps func(*tasksFake, *ui.Tester)) {
		t.Run(name, func(t *testing.T) {
			f, _, tt := tasksTesterWith(t, w, h, setup)
			tt.SetDark(dark)
			steps(f, tt)
			shotTo(t, dir, name+".png", tt)
		})
	}
	list := func(*tasksFake, *ui.Tester) {}
	open := func(f *tasksFake, tt *ui.Tester) { openTask(t, tt, fxTitle, "创建主任务") }
	run("list-1180-light", 1180, 700, false, both, list)
	run("list-1180-dark", 1180, 700, true, both, list)
	run("list-760", 760, 900, false, both, list)
	run("detail-1180-light", 1180, 2760, false, nil, open)
	run("detail-1180-dark", 1180, 2760, true, nil, open)
	run("detail-760", 760, 3700, false, nil, open)
	run("drawer-text", 1180, 820, false, nil, func(f *tasksFake, tt *ui.Tester) {
		open(f, tt)
		tt.Scroll(600, 500, 0, 1300)
		tt.Advance(time.Second)
		click(t, tt, "查看全文 · 612 字")
		tasksWait(t, tt, "shell · 第 1 次结果", 3*time.Second)
	})
	run("drawer-package", 1180, 820, false, nil, func(f *tasksFake, tt *ui.Tester) {
		open(f, tt)
		tt.Scroll(600, 500, 0, 1300)
		tt.Advance(time.Second)
		click(t, tt, "tasks-gui")
		tasksWait(t, tt, "状态词已分开", 3*time.Second)
	})
	run("panel-artifacts", 1180, 820, false, nil, func(f *tasksFake, tt *ui.Tester) {
		open(f, tt)
		click(t, tt, "产物 2")
		tasksWait(t, tt, "验收报告", 3*time.Second)
	})
	run("dialogue-1180", 1180, 1400, false, both, func(f *tasksFake, tt *ui.Tester) {
		openTask(t, tt, "设计对谈 unit-names", "发起对谈 unit-names")
	})
	run("dialogue-1180-dark", 1180, 1400, true, both, func(f *tasksFake, tt *ui.Tester) {
		openTask(t, tt, "设计对谈 unit-names", "发起对谈 unit-names")
	})
	run("convorel-1180", 1180, 900, false, both, func(f *tasksFake, tt *ui.Tester) {
		openTask(t, tt, "定时任务调度方案审查", "问 Convorel")
	})
}
