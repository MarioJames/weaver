package main

import (
	"strings"
	"testing"
	"time"

	"github.com/MarioJames/weaver/internal/kernel"
)

func withDialogue(f *tasksFake) {
	m, tl := fxDialogueTimeline()
	f.missions = append(f.missions, m)
	f.timelines[m.ID] = tl
}

func withConvorel(f *tasksFake) {
	m, tl := fxConvorelTimeline()
	f.missions = append(f.missions, m)
	f.timelines[m.ID] = tl
}

// A15, A16: the starting card, two dividers, four speakers; nothing is wider than an 860 window.
func TestTaskDialogue(t *testing.T) {
	seeds := watchAvatars(t)
	f, _, tt := tasksTesterWith(t, 860, 3000, withDialogue)
	openTask(t, tt, "设计对谈 unit-names", "发起对谈 unit-names")
	tasksContains(t, tt, "发起对谈 unit-names", "1 轮互评",
		"甲方", "codex · gpt-6-astra · xhigh", "ChatGPT Pro 5x", "乙方", "claude · fable · max", "Claude 5x Max",
		"方案 · 两方同时写，互相看不到", "最终立场 · 各自读完对方的方案后，评对方并修订自己",
		"对谈人", "甲方 · codex", "乙方 · claude", "已采纳", "待结论", "4 分 01 秒", "2 分 35 秒")
	tasksAbsent(t, tt, "派出", "第 1 轮互评")
	if !(tasksOrdered(tt, "发起对谈 unit-names", "方案 · 两方同时写") && tasksOrdered(tt, "方案 · 两方同时写", "最终立场")) {
		t.Fatalf("顺序：%q", tt.Texts())
	}
	// Within a round the speeches follow the order they came back: fable, then gpt-6-astra.
	names := []string{}
	for _, text := range tt.Texts() {
		if text == "fable" || text == "gpt-6-astra" {
			names = append(names, text)
		}
	}
	if strings.Join(names, ",") != "fable,gpt-6-astra,fable,gpt-6-astra" {
		t.Fatalf("发言名字与顺序：%v", names)
	}
	// The two portraits use different backgrounds, and b steps aside from a.
	base := fxDialogue + "/unit-names"
	set := seeds.set()
	if !set[base+".a||22"] || !set[base+".b|"+base+".a|22"] || !set[base+".a||32"] || !set[base+".b|"+base+".a|32"] {
		t.Fatalf("对谈头像种子：%v", set)
	}
	if taskAvatarBackground(base+".b", base+".a") == taskAvatarBackground(base+".a", "") {
		t.Fatal("两位对谈人的底色相同")
	}
	// Nothing on the page, not even the clipped dialogs, runs past the window.
	for _, text := range tt.Texts() {
		r, ok := tt.Find(text)
		if ok && r.W > 0 && r.X+r.W > 860.5 {
			t.Errorf("%q 超出 860 宽窗口：%+v", text, r)
		}
	}
	f.taskMu.Lock()
	f.texts[fxDialogue+"|result:att-b-1"] = kernel.MissionTextResult{Title: "fable · 第 1 轮方案", Text: "完整方案正文"}
	f.taskMu.Unlock()
	click(t, tt, "查看全文 · 9100 字")
	tasksWait(t, tt, "fable · 第 1 轮方案", 3*time.Second)
	tasksContains(t, tt, "完整方案正文", "对谈人")
	if calls := f.callsOf("mission.text"); len(calls) != 1 || calls[0].Params["ref"] != "result:att-b-1" {
		t.Fatalf("mission.text：%+v", calls)
	}
}

// A17: one side failing shows the problem against that side, and the other side's speech stays.
func TestTaskDialogueOneSideFails(t *testing.T) {
	_, _, tt := tasksTesterWith(t, 1180, 3000, func(f *tasksFake) {
		withDialogue(f)
		tl := f.timelines[fxDialogue]
		for i, e := range tl.Entries {
			if e.Kind == "debater" && e.Side == "a" && e.Round == 2 {
				failed := taskEntry{Kind: "problem", At: e.At, Name: "unit-names", Side: "a", Package: "unit-names.r2.a", Attempt: 1, Problem: "failed", Reason: "引擎中途退出：codex 没有回应", Steps: []kernel.TimelineStep{{At: e.At, Action: "retry", Text: "重新发起甲方"}}}
				failed.Ord, failed.Hash = e.Ord, fxHash(failed)
				tl.Entries[i] = failed
			}
		}
		tl.Packages[2].State = "failed"
	})
	openTask(t, tt, "设计对谈 unit-names", "发起对谈 unit-names")
	tasksContains(t, tt, "unit-names · 甲方", "失败", "引擎中途退出：codex 没有回应", "重试", "Agree with the proposal to prefix every unit")
	tasksAbsent(t, tt, "Final position: prefix scope")
	tasksContains(t, tt, "失败")
}

// A23: two asks, each answered by Convorel's own mark, tag and model; a pending answer says so.
func TestTaskConvorel(t *testing.T) {
	f, _, tt := tasksTesterWith(t, 1180, 3000, withConvorel)
	openTask(t, tt, "定时任务调度方案审查", "问 Convorel")
	tasksContains(t, tt, "Convorel", "外部审查", "ChatGPT 6 Pro", "父 Agent", "问 Convorel", "等待回复…",
		"请审查 Weaver 新增定时任务管理的实现方案", "结论：方案方向可行", "查看全文 · 1800 字")
	// Convorel speaks under its own mark, not a lettered placeholder.
	tasksAbsent(t, tt, "Cv")
	if _, ok := tt.Find("Convorel 标志"); !ok {
		t.Errorf("没有画出 Convorel 标志")
	}
	if n := strings.Count(strings.Join(tt.Texts(), "\n"), "问 Convorel"); n != 2 {
		t.Errorf("提问 %d 次，want 2", n)
	}
	if !(tasksOrdered(tt, "请审查 Weaver", "结论：方案方向可行") && tasksOrdered(tt, "结论：方案方向可行", "补充：命令重试") && tasksOrdered(tt, "补充：命令重试", "等待回复…")) {
		t.Fatalf("问答顺序：%q", tt.Texts())
	}
	// The first answer's whole text comes from the service by its review ref.
	f.taskMu.Lock()
	f.texts[fxConvorel+"|review:cv1:1"] = kernel.MissionTextResult{Title: "Convorel · 第 1 轮回复", Text: "完整回复正文"}
	f.taskMu.Unlock()
	click(t, tt, "查看全文 · 1800 字")
	tasksWait(t, tt, "Convorel · 第 1 轮回复", 3*time.Second)
	tasksContains(t, tt, "完整回复正文", "外部审查")
	// A failed round says it got no answer.
	f.edit(fxConvorel, func(tl *taskTimeline) {
		last := len(tl.Entries) - 1
		e := tl.Entries[last]
		e.State = "failed"
		e.Hash = fxHash(e)
		tl.Entries[last] = e
	})
	tasksWait(t, tt, "这一轮没有拿到回复", 3*time.Second)
	tasksAbsent(t, tt, "等待回复…")
}

// A24: a task with no Convorel entries is an ordinary page.
func TestTaskWithoutConvorel(t *testing.T) {
	_, _, tt := detailTester(t, 1180)
	tasksAbsent(t, tt, "Convorel", "外部审查", "问 Convorel", "没能读取")
	tasksContains(t, tt, "创建主任务", "派出 6 个 Agent")
}
