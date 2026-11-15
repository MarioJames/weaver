package main

import (
	"fmt"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
	"github.com/lobehub/lobe-mygo/pkg/display"
	"github.com/lobehub/lobe-mygo/pkg/lucide"
	"github.com/lobehub/lobe-mygo/pkg/theme"
)

func TestTaskAvatar(t *testing.T) {
	if taskAvatarSource("shell", "") != taskAvatarSource("shell", "") {
		t.Fatal("same seed changed SVG")
	}
	colors := map[int]string{}
	var collision, avoid string
	for i := range 30 {
		seed := fmt.Sprintf("agent-%d", i)
		bg := taskAvatarBackground(seed, "")
		if other, ok := colors[bg]; ok {
			collision, avoid = seed, other
		}
		colors[bg] = seed
	}
	if len(colors) < 3 {
		t.Fatalf("only %d backgrounds", len(colors))
	}
	if collision == "" || taskAvatarBackground(collision, avoid) == taskAvatarBackground(avoid, "") {
		t.Fatal("colliding seeds were not separated")
	}
	if taskAvatarSVG("shell", "") != taskAvatarSVG("shell", "") {
		t.Fatal("parsed SVG was not cached")
	}
}

func TestTaskPreviewWraps(t *testing.T) {
	tt := ui.NewTester(func(c *ui.Context) {
		theme.Apply(c)
		ui.Column(c).Width(180).Children(func() {
			taskBubble(c, func() { taskPreview(c, strings.Repeat("正在核对真实配置和界面能力。", 8), 2) })
		})
	}, 400, 400)
	tt.Advance(time.Second)
	found := false
	for _, text := range tt.Texts() {
		found = found || strings.HasPrefix(text, "查看全文 · ")
	}
	if !found {
		t.Fatal("soft-wrapped preview has no full-text entry")
	}
}

func TestTaskDrawerStates(t *testing.T) {
	for _, state := range []struct {
		name  string
		props taskDrawerProps
		want  string
	}{
		{"loading", taskDrawerProps{Loading: true}, "正在读取全文…"},
		{"error", taskDrawerProps{Error: "原始读取错误"}, "原始读取错误"},
		{"markdown", taskDrawerProps{Markdown: "完整结果正文"}, "完整结果正文"},
	} {
		t.Run(state.name, func(t *testing.T) {
			open := true
			tt := ui.NewTester(func(c *ui.Context) {
				theme.Apply(c)
				ui.Column(c).Fill()
				taskDrawer(c, &open, state.props)
			}, 390, 600)
			tt.Advance(time.Second)
			if _, ok := tt.Find(state.want); !ok {
				t.Fatalf("missing drawer content: %q", tt.Texts())
			}
			closeRect, ok := tt.Find("Close")
			if !ok || closeRect.X < 0 || closeRect.X+closeRect.W > 390 {
				t.Fatalf("close button exceeds narrow window: %+v, found=%v", closeRect, ok)
			}
		})
	}
}

const taskKitResult = "我会在指定目录内完成应用骨架和测试，使用无窗口测试器验证，不操作本机正在运行的服务。\n\n仅新增 `cmd/weaver-gui/` 下 9 个文件：应用入口、状态与路由、RPC 客户端、共用组件、概览页、设置页、两个占位页及测试。完成两秒轮询、离线恢复、设置保存与错误回退、引擎控制及服务/技能操作。\n\n验证结果：\n\n- `go vet ./cmd/weaver-gui/...` 通过。\n- `go test -race ./cmd/weaver-gui/...` 通过，覆盖假 RPC 服务与无窗口交互。\n- GUI 构建成功：15,639,528 字节。"

func taskKitSheet(c *ui.Context, drawer *bool) {
	theme.Apply(c)
	tk := theme.TokensOf(c)
	owner := taskMessageHeader{Avatar: func() { taskAvatar(c, "m_4hse6cjvqu", 32) }, Name: "Claude", Role: taskRoleOwner, Time: "21:14"}
	worker := taskMessageHeader{Avatar: func() { taskAvatar(c, "m_4hse6cjvqu/shell", 32) }, Name: "shell", Role: taskRoleWorker, Meta: "codex_sol_medium", Time: "22:24"}
	ui.Column(c).Fill().Padding(8).Background(tk.BgLayout).Children(func() {
		ui.Column(c).Grow(1).Basis(0).MinHeight(0).Background(tk.BgContainer).Radius(tk.BorderRadiusLG).Border(1, tk.BorderSecondary).Clip().Children(func() {
			ui.Column(c).Padding(24).Gap(18).AlignItems(ui.Center).Children(func() {
				w, _ := c.Size()
				ui.Column(c).Width(min(float32(860), w-64)).Gap(18).Children(func() {
					ui.Row(c).Gap(12).AlignItems(ui.Center).Children(func() {
						taskAvatar(c, "m_4hse6cjvqu", 28)
						ui.Column(c).Gap(2).Children(func() {
							ui.Text(c, "1115｜FEA｜Weaver 桌面图形界面").FontSize(16).FontWeight(600).TextColor(tk.Text)
							ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
								display.Tag(c, "已完成", display.TagProps{Color: display.TagSuccess, Size: theme.Small})
								ui.Text(c, "18 / 19 已采纳 · 1 已取消 · Claude · weaver-gui").FontSize(12).TextColor(tk.TextTertiary)
							})
						})
					})
					ui.Box(c).Height(1).AlignSelf(ui.Stretch).Background(tk.Split)
					taskUser(c, "21:14", "基于最新版 Weaver 的能力，以及之前聊过的 Lobe My Go UI 框架和 My Go Framework，做一个 Weaver 图形化界面，覆盖目前所有的配置化能力。先做个方案出来")
					taskMessage(c, owner, func() {
						for i, s := range [][2]string{
							{"20 步操作", "正在梳理 Weaver 2.0 的全部可配置项（账号、候选、引擎、设置等）和 MyGo / Lobe MyGo 的组件能力，接下来读真实数据，然后出方案文档。"},
							{"12 步操作 · 3 分钟", "方案素材已齐（配置面、真实数据、MyGo 能力都核对过了），再确认几条真实报错文案和约束后就写设计文档。"},
							{"3 步操作 · 4 分钟", "设计文档已写好，正在浏览器里核对宽屏和窄屏的排版，然后上传给出链接。"},
						} {
							ui.Column(c.Key(i)).Gap(6).Children(func() {
								expanded := false
								taskOperations(c, &expanded, s[0], nil)
								taskBubble(c, func() { taskText(c, s[1]) })
							})
						}
					})
					taskDivider(c, "中间省略 · 21:57 起的一轮", true)
					taskUser(c, "22:09", "没问题，只做桌面端，不做页面端。用 weaver 做吧")
					taskProcessRow(c, lucide.Flag(), taskToneNeutral, "创建主任务", "", "22:12", nil)
					taskRoster(c, lucide.Send(), "派出 4 个 Agent", "2 个在跑，2 个等依赖", "23:09", []taskRosterRow{
						{Key: "server", Seed: "m_4hse6cjvqu/server", Title: "服务：渠道配置读回、模型拉取、用量查询", Worker: "opencode_deepseek", State: "已采纳", Cost: "18 分钟"},
						{Key: "tasks-gui", Seed: "m_4hse6cjvqu/tasks-gui", Title: "界面：任务页与自动归档设置", Worker: "codex_sol_medium", State: "运行中", Cost: "3 分钟"},
						{Key: "share-skill", Seed: "m_4hse6cjvqu/share-skill", Title: "分享脚本与技能：登记、公开目录、永久保留", Worker: "opencode_deepseek", State: "运行中", Cost: "3 分钟"},
						{Key: "cloudflare", Seed: "m_4hse6cjvqu/cloudflare", Title: "分享域名登录、公开目录、缓存、限流", Worker: "codex_sol_medium", State: "等依赖", Cost: "—"},
					})
					taskMessage(c, worker, func() {
						taskBubble(c, func() {
							if taskPreview(c, taskKitResult, 3) {
								*drawer = true
							}
						})
					})
					taskProcessRow(c, lucide.Check(), taskToneSuccess, "采纳", "shell", "22:25", func() {
						taskQuote(c, "骨架、概览、设置通过；导航样式和自定义数据目录下的服务按钮留到打磨包", 0, "")
					})
					taskProcessRow(c, lucide.Undo2(), taskToneWarning, "退回", "tasks-gui", "23:30", func() {
						taskQuote(c, "结构和功能通过，以下内容问题需要修（只改任务页自己的文件 page_tasks.go、task_*.go 及其测试，其他文件不动）：1) task_models.go 的状态词：包的 running 必须显示「运行中」，主任务的 running 才显示「进行中」。把主任务状态和包状态分成两个映射，别共用一个。", 2, "查看全部 3 条")
					})
					taskProblem(c, taskProblemProps{Target: "acceptance", Attempt: "第 1 次尝试", Time: "00:46", Reason: "引擎中途退出：opencode 常驻服务进程已退出，这次运行随之中断", Steps: []taskProblemStep{
						{"00:46", "重试", "上一次因 opencode 常驻服务进程退出中断，没有留下证据；按原指令从头执行。"},
						{"00:53", "再次失败", "第 2 次尝试，原因相同"},
						{"00:54", "改派", "取消 acceptance，派出 acceptance-2 · codex_sol_medium，已采纳"},
					}})
					taskDivider(c, "设计对谈", true)
					taskRoster(c, lucide.MessagesSquare(), "发起对谈 unit-names", "1 轮互评", "0:00", []taskRosterRow{
						{Key: "a", Name: "甲方", Seed: "unit-names.a", Title: "codex · gpt-6-astra · xhigh", Worker: "ChatGPT Pro 5x", State: "已采纳", Cost: "4 分 01 秒"},
						{Key: "b", Name: "乙方", Seed: "unit-names.b", AvoidSeed: "unit-names.a", Title: "claude · fable · max", Worker: "Claude 5x Max", State: "待结论", Cost: "3 分 30 秒"},
					})
					taskDivider(c, "方案 · 两方同时写，互相看不到", false)
					for i, d := range []struct{ seed, avoid, name, meta, at, text string }{
						{"unit-names.b", "unit-names.a", "fable", "乙方 · claude", "1:14", "systemd user units are one namespace per Linux user. Weaver 2 names them from IDs that are only unique inside one data directory: attempt and standby scopes, resident units. Two data directories on one machine therefore collide."},
						{"unit-names.a", "", "gpt-6-astra", "甲方 · codex", "2:09", "The collision is in the Linux user’s systemd namespace, while Weaver’s state is separated by data directory. internal/engine/cold.go derives attempt scope names solely from the attempt ID."},
					} {
						ui.Column(c.Key(i)).Children(func() {
							taskMessage(c, taskMessageHeader{Avatar: func() { taskAvatarAvoid(c, d.seed, d.avoid, 32) }, Name: d.name, Role: taskRoleDebater, Meta: d.meta, Time: d.at}, func() {
								taskBubble(c, func() { taskPreview(c, d.text, 2) })
							})
						})
					}
					taskDivider(c, "外部审查", true)
					taskMessage(c, taskMessageHeader{Avatar: func() { taskAvatar(c, "weaver-schedules", 32) }, Name: "Claude", Role: taskRoleOwner, Meta: "问 Convorel", Time: "00:48"}, func() {
						taskBubble(c, func() {
							taskPreview(c, "请审查 Weaver 新增定时任务管理的实现方案，重点找阻断用户目标的失败模式与更简单的既有能力复用。用户确认目标：提供定时任务页面，区分定时脚本与 Agent 任务，迁移适合的现有周期工作。", 2)
						})
					})
					taskMessage(c, taskMessageHeader{Avatar: func() { taskConvorelMark(c, 32) }, Name: "Convorel", Role: taskRoleReviewer, Meta: "ChatGPT 6 Pro", Time: "01:07"}, func() {
						taskBubble(c, func() {
							taskPreview(c, "结论：方案方向可行，可以继续按「单服务＋现有 SQLite/KV＋统一轮询器」实现。需要补齐的重点是命令重试、运行 claim、Agent 恢复和外部进程生命周期之间的契约。不需要增加调度进程、数据库或配置体系。", 3)
						})
					})
				})
			})
		})
	})
	drawerHeader := taskMessageHeader{Avatar: func() { taskAvatar(c, "m_4hse6cjvqu/shell", 28) }, Name: "shell", Role: taskRoleWorker, Meta: "codex_sol_medium · 22:14 → 22:24"}
	taskDrawer(c, drawer, taskDrawerProps{Title: "shell · 第 1 次结果", Header: &drawerHeader, Markdown: taskKitResult})
}

func TestTaskKitScreenshots(t *testing.T) {
	dir := os.Getenv("WEAVER_TASK_KIT_SCREENSHOTS")
	if dir == "" {
		t.Skip("未设置截图目录")
	}
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	for _, shot := range []struct {
		name          string
		width, height int
		dark, drawer  bool
	}{
		{"kit-light.png", 1180, 2240, false, false},
		{"kit-dark.png", 1180, 2240, true, false},
		{"kit-narrow.png", 760, 2280, false, false},
		{"kit-drawer.png", 1180, 820, false, true},
	} {
		t.Run(shot.name, func(t *testing.T) {
			open := shot.drawer
			tt := ui.NewTester(func(c *ui.Context) { taskKitSheet(c, &open) }, shot.width, shot.height)
			tt.SetDark(shot.dark)
			tt.Advance(time.Second)
			tt.Frame()
			file, err := os.Create(filepath.Join(dir, shot.name))
			if err != nil {
				t.Fatal(err)
			}
			defer file.Close()
			if err := png.Encode(file, tt.Image()); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestTaskKitInteractions(t *testing.T) {
	opened, expanded, selected := false, false, ""
	tt := ui.NewTester(func(c *ui.Context) {
		theme.Apply(c)
		ui.Column(c).Fill().Padding(20).Gap(18).Children(func() {
			if taskPreview(c, "第一行\n第二行\n第三行", 1) {
				opened = true
			}
			taskOperations(c, &expanded, "2 步操作 · 3 分钟", []taskOperation{{Tool: "read", Summary: "读取真实配置"}, {Tool: "test", Summary: "验证服务协议"}})
			if key := taskRoster(c, lucide.Send(), "派出 2 个 Agent", "2 个立即开工", "22:14", []taskRosterRow{
				{Key: "server", Seed: "server", Name: "server", Title: "服务：渠道配置读回", Worker: "opencode_deepseek", State: "运行中", Cost: "3 分钟"},
				{Key: "shell", Seed: "shell", Name: "界面骨架 Agent", Title: "界面：应用骨架", Worker: "codex_sol_medium", State: "已采纳", Cost: "10 分钟"},
			}); key != "" {
				selected = key
			}
		})
	}, 760, 700)
	tt.Frame()
	click(t, tt, "查看全文 · 11 字")
	if !opened {
		t.Fatal("preview click was not returned")
	}
	if _, ok := tt.Find("读取真实配置"); ok {
		t.Fatal("steps start expanded")
	}
	click(t, tt, "2 步操作 · 3 分钟")
	if _, ok := tt.Find("读取真实配置"); !ok || !expanded {
		t.Fatal("steps did not expand")
	}
	click(t, tt, "2 步操作 · 3 分钟")
	if _, ok := tt.Find("读取真实配置"); ok || expanded {
		t.Fatal("steps did not collapse")
	}
	click(t, tt, "界面骨架 Agent")
	if selected != "shell" {
		t.Fatalf("selected %q", selected)
	}
}

func TestTaskPreviewFits(t *testing.T) {
	tt := ui.NewTester(func(c *ui.Context) {
		theme.Apply(c)
		ui.Column(c).Width(300).Children(func() { taskPreview(c, "短正文", 3) })
	}, 400, 200)
	tt.Advance(time.Second)
	for _, text := range tt.Texts() {
		if strings.Contains(text, "查看全文") {
			t.Fatal("short text has a full-text entry")
		}
	}
}
