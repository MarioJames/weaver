package main

import (
	"fmt"
	"image/png"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
)

// TestPolishScreenshots renders the five pages at the two acceptance sizes.
// WEAVER_POLISH_SCREENSHOTS names the evidence directory.
func TestPolishScreenshots(t *testing.T) {
	dir := os.Getenv("WEAVER_POLISH_SCREENSHOTS")
	if dir == "" {
		t.Skip("未设置截图目录")
	}
	f := newTasksFake(t)
	checked := time.Now().Add(-3 * time.Minute).UnixMilli()
	f.data.Accounts[2].Resident = "ready"
	f.data.Workers = []worker{
		{ID: "codex_sol_medium", Engine: "codex", Model: "gpt-6.1-sol", Effort: "medium", Intelligence: 5, Enabled: true, Available: true, Accounts: []string{"a1"}},
		{ID: "opencode_deepseek", Engine: "opencode", Model: "deepseek-v4.1-flash", Effort: "max", Intelligence: 5, Enabled: true, Available: true, Accounts: []string{"a2"}},
		{ID: "claude_sonnet_high", Engine: "claude", Model: "sonnet", Effort: "high", Intelligence: 0, Enabled: true, Available: true, Accounts: []string{"a0"}},
		{ID: "opencode_muse", Engine: "opencode", Model: "muse-spark-1.3-contributor", Effort: "max", Intelligence: 0, Enabled: true, Available: true, Accounts: []string{"a2"}},
		{ID: "dsh_terra_xhigh", Engine: "dsh", Model: "gpt-6.1-terra", Effort: "xhigh", Intelligence: 0, Enabled: true, Available: true, Accounts: []string{"a5"}},
		{ID: "dsh_haiku_xhigh", Engine: "dsh", Model: "claude-haiku-5-5", Effort: "xhigh", Intelligence: 0, Enabled: true, Available: true, Accounts: []string{"a6"}},
	}
	f.data.Accounts[5].Usage = &usage{Month: usageTotals{Runs: 12, InputTokens: 1_200_000, OutputTokens: 86_000},
		Balance: moneyPtr(50), BalanceAt: checked}
	f.data.Accounts[6].Usage = &usage{Month: usageTotals{Runs: 37, Cost: moneyPtr(3.10)},
		Balance: moneyPtr(50), BalanceAt: checked, Remaining: moneyPtr(1.90), AlertBelow: moneyPtr(5), Low: true}
	a := testApp(t, f.fakeService)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	tt := ui.NewTester(a.view, 1280, 820)
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
	names := map[string]string{"概览": "overview", "任务": "tasks", "账号": "accounts", "候选": "workers", "设置": "settings"}
	for _, size := range []struct {
		width, height int
		suffix        string
	}{{1280, 820, "1280x820"}, {860, 820, "860x820"}} {
		tt.SetSize(size.width, size.height)
		for _, page := range []string{"概览", "任务", "账号", "候选", "设置"} {
			click(t, tt, page)
			if page == "任务" {
				tasksWait(t, tt, fxTitle, 5*time.Second)
				click(t, tt, fxTitle)
				tasksWait(t, tt, "创建主任务", 5*time.Second)
			}
			menuOpen := page == "账号" && size.width == 1280
			if menuOpen {
				// Keep the menu over the subscription rows so the unconfigured
				// usage copy below stays visible in the screenshot.
				openAccountMore(t, tt, "Claude 5x Max")
			}
			tt.Advance(200 * time.Millisecond)
			save(names[page] + "-" + size.suffix + ".png")
			if menuOpen {
				tt.Key(0, ui.KeyEscape)
				tt.Advance(200 * time.Millisecond)
			}
		}
	}
}

// TestAccountActionsFitCommonWidths keeps the row actions inside the table
// from 1100 to 1600 DIPs, with the secondary actions behind the more menu.
func TestAccountActionsFitCommonWidths(t *testing.T) {
	for _, width := range []int{1100, 1280, 1440, 1600} {
		t.Run(fmt.Sprint(width), func(t *testing.T) {
			f := newAccountService(t)
			_, tt := openAccounts(t, f)
			tt.SetSize(width, 820)
			tt.Frame()
			limit := float32(width - 32) // the table's right edge
			for _, label := range []string{"更多操作 Anthropic API（dsh）", "编辑 Anthropic API（dsh）"} {
				rect, ok := tt.Find(label)
				if !ok {
					t.Fatalf("找不到 %q：%q", label, tt.Texts())
				}
				if rect.X < 0 || rect.X+rect.W > limit {
					t.Fatalf("%q 在 x=%.0f..%.0f，越过表格右缘 %.0f", label, rect.X, rect.X+rect.W, limit)
				}
			}
			if tt.HasText("删除 Anthropic API（dsh）") {
				t.Fatalf("%d 宽时删除仍在行内：%q", width, tt.Texts())
			}
			if id, ok := tt.Find("claude_sonnet_high"); !ok || id.W < 110 {
				t.Fatalf("%d 宽时候选 ID 被截断：%+v %v", width, id, ok)
			}
			openAccountMore(t, tt, "Anthropic API（dsh）")
			for _, item := range []string{"暂停 Anthropic API（dsh）", "删除 Anthropic API（dsh）"} {
				rect, ok := tt.Find(item)
				if !ok {
					t.Fatalf("%d 宽时更多菜单缺少 %q", width, item)
				}
				if rect.X < 0 || rect.X+rect.W > float32(width) || rect.Y < 0 || rect.Y+rect.H > 820 || rect.H <= 0 {
					t.Fatalf("%d 宽时菜单项 %q 越界：%+v", width, item, rect)
				}
			}
			if tt.HasText("登录 Anthropic API（dsh）") {
				t.Fatalf("API 账号出现了登录：%q", tt.Texts())
			}
			tt.Key(0, ui.KeyEscape)
			tt.Advance(time.Second)
		})
	}
	// A subscription account keeps login in the menu.
	f := newAccountService(t)
	_, tt := openAccounts(t, f)
	openAccountMore(t, tt, "Claude 5x Max")
	for _, item := range []string{"登录 Claude 5x Max", "暂停 Claude 5x Max", "删除 Claude 5x Max"} {
		if !tt.HasText(item) {
			t.Fatalf("订阅账号的更多菜单缺少 %q", item)
		}
	}
}

// TestAccountUsageCellsKeepCopyInsideColumn checks the compact usage cells:
// "本月没有运行" stays whole inside its column, and every "配置" link starts
// on the same left edge as the amount or hint above it.
func TestAccountUsageCellsKeepCopyInsideColumn(t *testing.T) {
	aligned := func(a, b float32) bool {
		diff := a - b
		return diff > -1.5 && diff < 1.5
	}
	for _, width := range []int{1100, 1280, 1600} {
		t.Run(fmt.Sprint(width), func(t *testing.T) {
			f := newAccountService(t)
			seedUsage(f, "a5", &usage{Month: usageTotals{Runs: 12, Cost: moneyPtr(3.10)},
				Balance: moneyPtr(50), Remaining: moneyPtr(1.90)})
			_, tt := openAccounts(t, f)
			tt.SetSize(width, 900)
			tt.Frame()

			header, ok := tt.Find("用量 / 额度")
			if !ok {
				t.Fatalf("找不到用量列表头：%q", tt.Texts())
			}
			columnRight := header.X + accountColumns[3].width
			empty, ok := tt.Find("本月没有运行")
			if !ok {
				t.Fatalf("找不到没有运行的文案：%q", tt.Texts())
			}
			// Six 11px characters measure 66; anything under 65 is a cut.
			if empty.W < 65 {
				t.Fatalf("本月没有运行被截断：%+v", empty)
			}
			if empty.X+empty.W > columnRight+0.5 {
				t.Fatalf("本月没有运行越过列宽 %.0f：%+v", columnRight, empty)
			}
			emptyConfig, ok := tt.Find("配置用量 dsh deepseek-official")
			if !ok {
				t.Fatalf("找不到没有运行行的配置按钮：%q", tt.Texts())
			}
			configText, ok := tt.Find("配置")
			if !ok {
				t.Fatalf("找不到配置链接文字：%q", tt.Texts())
			}
			if !aligned(configText.X, empty.X) {
				t.Fatalf("配置链接 x=%.1f 没有与上方文字 x=%.1f 对齐", configText.X, empty.X)
			}
			if emptyConfig.W > 32 {
				t.Fatalf("配置链接带了 %.0f 宽的内边距，文字没有左对齐", emptyConfig.W)
			}

			spent, ok := tt.Find("$3.10")
			if !ok {
				t.Fatalf("找不到本月用量：%q", tt.Texts())
			}
			runs, ok := tt.Find("12 次")
			if !ok {
				t.Fatalf("找不到运行次数：%q", tt.Texts())
			}
			config, ok := tt.Find("配置用量 OpenAI API（dsh）")
			if !ok {
				t.Fatalf("找不到有用量行的配置按钮：%q", tt.Texts())
			}
			if config.W > 32 {
				t.Fatalf("有用量行的配置链接带了 %.0f 宽的内边距", config.W)
			}
			for name, rect := range map[string]ui.Rect{"金额": spent, "次数": runs, "配置": config} {
				if !aligned(rect.X, spent.X) {
					t.Fatalf("%s x=%.1f 没有与金额 x=%.1f 左对齐", name, rect.X, spent.X)
				}
				if rect.X+rect.W > columnRight+0.5 {
					t.Fatalf("%s 越过列宽 %.0f：%+v", name, columnRight, rect)
				}
			}
		})
	}
}

// TestDrawerFormsAlignLabels checks the shared baseline and the footer order
// in the account, usage and candidate drawers.
func TestDrawerFormsAlignLabels(t *testing.T) {
	f := newAccountService(t)
	_, tt := openAccounts(t, f)
	click(t, tt, "接入账号")
	assertLabelAligned(t, tt, "名称")
	assertLabelAligned(t, tt, "接口地址")
	cancel, ok := tt.Find("取消")
	if !ok {
		t.Fatal("账号抽屉没有取消")
	}
	save, ok := tt.Find("保存并检查")
	if !ok || save.X <= cancel.X {
		t.Fatalf("账号抽屉主按钮不在右侧：取消 %+v 保存 %+v", cancel, save)
	}
	click(t, tt, "取消")

	click(t, tt, "配置用量 OpenAI API（dsh）")
	assertLabelAligned(t, tt, "当前余额")
	assertLabelAligned(t, tt, "低于多少提示")
	closeButton, _ := tt.Find("关闭")
	saveButton, ok := tt.Find("保存")
	if !ok || saveButton.X <= closeButton.X {
		t.Fatalf("用量面板主按钮不在右侧：关闭 %+v 保存 %+v", closeButton, saveButton)
	}
	click(t, tt, "关闭")

	click(t, tt, "候选")
	click(t, tt, "新建候选")
	assertLabelAligned(t, tt, "并行上限")
	cancel, ok = tt.Find("取消")
	if !ok {
		t.Fatal("候选编辑器没有取消")
	}
	save, ok = tt.Find("保存")
	if !ok || save.X <= cancel.X {
		t.Fatalf("候选编辑器主按钮不在右侧：取消 %+v 保存 %+v", cancel, save)
	}
	click(t, tt, "取消")
}

func assertLabelAligned(t *testing.T, tt *ui.Tester, name string) {
	t.Helper()
	label, ok := tt.Find(name)
	if !ok {
		t.Fatalf("找不到标签 %q", name)
	}
	info, ok := tt.AccessByRole(ui.RoleTextField, name)
	if !ok {
		t.Fatalf("找不到输入框 %q", name)
	}
	labelCenter := label.Y + label.H/2
	fieldCenter := info.Bounds.Y + info.Bounds.H/2
	if diff := labelCenter - fieldCenter; diff > 2 || diff < -2 {
		t.Fatalf("%q 标签中心 %.1f 与输入框中心 %.1f 相差 %.1f", name, labelCenter, fieldCenter, diff)
	}
}

// TestNarrowPagesStayUsable checks that under 900 DIPs the navigation moves to
// the top, each page keeps its title, and the primary actions stay on screen.
func TestNarrowPagesStayUsable(t *testing.T) {
	f := newTasksFake(t)
	a := testApp(t, f.fakeService)
	tt := ui.NewTester(a.view, 860, 820)
	subtitles := map[string]string{
		"概览": "版本 2.0.0 · 运行时长 5 小时 0 分钟",
		"任务": "父 Agent 对话、子 Agent 生命周期和产物",
		"账号": "7 个账号",
		"候选": "6 个候选",
		"设置": "调度、常驻引擎和服务",
	}
	for page, subtitle := range subtitles {
		click(t, tt, page)
		nav, ok := tt.Find(page)
		if !ok {
			t.Fatalf("%s 页找不到导航项", page)
		}
		content, ok := tt.Find(subtitle)
		if !ok {
			t.Fatalf("%s 页找不到副标题 %q：%q", page, subtitle, tt.Texts())
		}
		if nav.Y >= content.Y {
			t.Fatalf("%s 页导航没有移到顶部：nav %+v 内容 %+v", page, nav, content)
		}
	}
	// The account cards keep their actions on screen.
	click(t, tt, "账号")
	more, ok := tt.Find("更多操作 Anthropic API（dsh）")
	if !ok || more.X+more.W > 860 {
		t.Fatalf("窄屏账号卡片操作越界：%+v %v", more, ok)
	}
	// The task page is a list that opens into a detail, and the detail can go back.
	click(t, tt, "任务")
	tasksWait(t, tt, fxTitle, 5*time.Second)
	click(t, tt, fxTitle)
	tasksWait(t, tt, "创建主任务", 5*time.Second)
	if !tt.HasText("任务") {
		t.Fatalf("窄屏任务页缺少返回入口：%q", tt.Texts())
	}
	if _, ok := tt.Find("返回任务列表"); !ok {
		t.Fatalf("窄屏任务页缺少返回入口：%q", tt.Texts())
	}
	click(t, tt, "返回任务列表")
	tasksWait(t, tt, "Convorel 1.0：Go 常驻进程 + 直连 CDP", 5*time.Second)
}

// TestEmptyStatesShareOneComponent checks the empty state on the three list
// pages: the same centered Empty surface with a first action.
func TestEmptyStatesShareOneComponent(t *testing.T) {
	f := newFake(t)
	f.mu.Lock()
	f.data.Accounts = nil
	f.data.Workers = nil
	f.mu.Unlock()
	a := testApp(t, f)
	tt := ui.NewTester(a.view, 1280, 820)
	click(t, tt, "账号")
	if !tt.HasText("还没有账号") {
		t.Fatalf("账号空态：%q", tt.Texts())
	}
	click(t, tt, "候选")
	if !tt.HasText("还没有候选") {
		t.Fatalf("候选空态：%q", tt.Texts())
	}
	click(t, tt, "概览")
	if !tt.HasText("0 / 0") {
		t.Fatalf("空数据概览：%q", tt.Texts())
	}
}

func TestTaskEmptyState(t *testing.T) {
	f := newTasksFake(t)
	f.taskMu.Lock()
	f.missions = nil
	f.archived = nil
	f.taskMu.Unlock()
	a := testApp(t, f.fakeService)
	a.page = "任务"
	tt := ui.NewTester(a.view, 1280, 820)
	tasksWait(t, tt, "还没有任务", 5*time.Second)
}
