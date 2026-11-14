package main

import (
	"image/png"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
)

func settle(tt *ui.Tester) {
	tt.Advance(time.Second)
	tt.Frame()
}

// 主任务切换：点左侧主任务，右侧标题和工作包跟着变。
func TestSelectMission(t *testing.T) {
	a := newApp(2000)
	tt := ui.NewTester(a.view, 1280, 820)
	if !tt.HasText("CPC 网关：设备网关上移到租户层") {
		t.Fatalf("首屏缺少第一个主任务的工作包：%q", tt.Texts())
	}
	if err := tt.Click("1111｜FEA｜企业级知识库"); err != nil {
		t.Fatal(err)
	}
	settle(tt)
	if a.selected != 2 {
		t.Errorf("selected = %d，期望 2", a.selected)
	}
	if tt.HasText("CPC 网关：租户契约 v2（mux、用户级票、订阅授权、在线汇总）") {
		t.Errorf("切换后仍显示上一个主任务的工作包")
	}
}

// 长列表只构建可见行：2000 行时界面里出现的行文本远少于 2000。
func TestLongListBuildsVisibleRowsOnly(t *testing.T) {
	a := newApp(2000)
	tt := ui.NewTester(a.view, 1280, 820)
	rows := 0
	for _, s := range tt.Texts() {
		if strings.HasSuffix(s, " 分钟") {
			rows++
		}
	}
	if rows == 0 || rows > 80 {
		t.Errorf("可见行 %d，期望在 1 到 80 之间", rows)
	}
}

// 搜索无结果时显示空态。
func TestSearchEmptyState(t *testing.T) {
	a := newApp(2000)
	a.query = "不存在的关键字"
	tt := ui.NewTester(a.view, 1280, 820)
	if !tt.HasText("没有匹配的工作包") {
		t.Errorf("缺少空态：%q", tt.Texts())
	}
}

// 设置 WEAVER_VIEW_SNAPSHOT 时把首屏画成 PNG，用于人工核对中文渲染。
func TestSnapshot(t *testing.T) {
	out := os.Getenv("WEAVER_VIEW_SNAPSHOT")
	if out == "" {
		t.Skip("未设置 WEAVER_VIEW_SNAPSHOT")
	}
	tt := ui.NewTester(newApp(2000).view, 1280, 820)
	settle(tt)
	f, err := os.Create(out)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := png.Encode(f, tt.Image()); err != nil {
		t.Fatal(err)
	}
}

func BenchmarkFrame2000(b *testing.B) {
	tt := ui.NewTester(newApp(2000).view, 1280, 820)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		tt.Frame()
	}
}
