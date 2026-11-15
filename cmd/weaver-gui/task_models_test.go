package main

import (
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/MarioJames/weaver/internal/kernel"
)

func TestTaskPlainText(t *testing.T) {
	for _, tc := range []struct{ name, md, want string }{
		{"标题井号", "## 结论\n正文", "结论\n正文"},
		{"加粗", "这是 **重点** 内容", "这是 重点 内容"},
		{"行内代码", "运行 `go test` 通过", "运行 go test 通过"},
		{"列表符号", "- 一\n* 二\n+ 三\n1. 四\n12. 五", "一\n二\n三\n四\n五"},
		{"连续空行", "第一段\n\n\n\n第二段", "第一段\n第二段"},
		{"代码围栏", "```go\nx := 1\n```", "x := 1"},
		{"井号不是标题", "#标签 与 C#", "#标签 与 C#"},
		{"小数不是列表", "3.5 倍", "3.5 倍"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := taskPlainText(tc.md); got != tc.want {
				t.Fatalf("%q → %q，want %q", tc.md, got, tc.want)
			}
		})
	}
}

func TestTaskFilters(t *testing.T) {
	missions := []taskMission{
		{ID: "a", State: "running"}, {ID: "b", State: "attention"}, {ID: "c", State: "closed", ClosedAt: 1}, {ID: "d", State: "blocked"}, {ID: "e", State: "awaiting_verdict"},
	}
	archived := []taskMission{{ID: "z", State: "closed"}}
	counts := taskFilterCounts(missions, archived)
	if counts != [5]int{5, 3, 1, 1, 1} {
		t.Fatalf("计数 %v", counts)
	}
	ids := func(rows []taskMission) string {
		var out []string
		for _, m := range rows {
			out = append(out, m.ID)
		}
		return strings.Join(out, "")
	}
	for filter, want := range map[int]string{taskFilterAll: "abcde", taskFilterActive: "ade", taskFilterAttention: "b", taskFilterDone: "c", taskFilterArchived: "z"} {
		if got := ids(taskFilterRows(filter, missions, archived)); got != want {
			t.Errorf("筛选 %d：%s，want %s", filter, got, want)
		}
	}
}

func TestTaskGroupsOrderByLatestActivity(t *testing.T) {
	now := time.Date(2026, 11, 15, 12, 0, 0, 0, time.Local)
	at := func(d time.Time) int64 { return d.UnixMilli() }
	groups := taskGroups([]taskMission{
		{ID: "old", LastActivityAt: at(now.AddDate(0, 0, -10))},
		{ID: "early", LastActivityAt: at(now.Add(-5 * time.Hour))},
		{ID: "late", LastActivityAt: at(now.Add(-time.Hour))},
		{ID: "two-days", LastActivityAt: at(now.AddDate(0, 0, -2))},
	}, now)
	got := [3]string{}
	for i, g := range groups {
		for _, m := range g {
			got[i] += m.ID + " "
		}
	}
	if got != [3]string{"late early ", "two-days ", "old "} {
		t.Fatalf("分组 %q", got)
	}
}

func TestTaskSubtitleAndProgress(t *testing.T) {
	if got := taskMissionSubtitle(taskMission{Owner: &taskOwner{Engine: "codex"}, Workspace: "/work/weaver-gui/"}); got != "Codex · weaver-gui" {
		t.Fatal(got)
	}
	if got := taskMissionSubtitle(taskMission{Workspace: "/work/convorel"}); got != "未关联父会话 · convorel" {
		t.Fatal(got)
	}
	if p, c := taskProgress(taskMission{Total: 19, Counts: map[string]int{"accepted": 18, "cancelled": 1}}); p != "18 / 19" || c != "1 已取消" {
		t.Fatal(p, c)
	}
	if _, c := taskProgress(taskMission{Total: 2, Counts: map[string]int{"accepted": 2}}); c != "" {
		t.Fatal(c)
	}
}

func TestTaskDispatchSummaryAndElapsed(t *testing.T) {
	p := func(states ...string) []taskListedPackage {
		var out []taskListedPackage
		for _, s := range states {
			out = append(out, taskListedPackage{State: s})
		}
		return out
	}
	for _, tc := range []struct {
		packages []taskListedPackage
		want     string
	}{
		{p("running", "running", "pending", "pending"), "2 个在跑，2 个等依赖"},
		{p("accepted", "accepted"), "全部已采纳"},
		{p("accepted", "cancelled", "failed", "awaiting_verdict"), "1 个待结论，1 个失败，1 个已取消，1 个已采纳"},
		{p("launching", "accepted"), "1 个在跑，1 个已采纳"},
	} {
		if got := taskDispatchSummary(tc.packages); got != tc.want {
			t.Errorf("%q，want %q", got, tc.want)
		}
	}
	for ms, want := range map[int64]string{42_000: "42 秒", 60_000: "1 分钟", 18 * 60_000: "18 分钟", 65 * 60_000: "1 小时 5 分钟"} {
		if got := taskElapsed(ms); got != want {
			t.Errorf("%d → %q，want %q", ms, got, want)
		}
	}
	if taskElapsedExact(241_000) != "4 分 01 秒" || taskElapsedExact(9_000) != "9 秒" {
		t.Error(taskElapsedExact(241_000), taskElapsedExact(9_000))
	}
	now := time.UnixMilli(10_000_000)
	for _, tc := range []struct {
		p    taskListedPackage
		want int64
		ok   bool
	}{
		{taskListedPackage{StartedAt: 1_000, FinishedAt: 61_000}, 60_000, true},
		{taskListedPackage{StartedAt: 9_000_000}, 1_000_000, true},
		{taskListedPackage{}, 0, false},
	} {
		if got, ok := taskPackageSpan(tc.p, now); got != tc.want || ok != tc.ok {
			t.Errorf("%+v → %d %v", tc.p, got, ok)
		}
	}
}

func TestTaskMergeEntries(t *testing.T) {
	e := func(h ...string) []taskEntry {
		var out []taskEntry
		for _, s := range h {
			out = append(out, taskEntry{Hash: s})
		}
		return out
	}
	hashes := func(es []taskEntry) []string {
		var out []string
		for _, x := range es {
			out = append(out, x.Hash)
		}
		return out
	}
	for _, tc := range []struct {
		have, fresh []taskEntry
		keep        int
		want        []string
	}{
		{e("a", "b"), e("c"), 2, []string{"a", "b", "c"}},
		{e("a", "b", "c"), e("x"), 1, []string{"a", "x"}},
		{e("a"), nil, 1, []string{"a"}},
		{e("a"), e("x"), 9, []string{"a", "x"}},
	} {
		if got := hashes(taskMergeEntries(tc.have, tc.fresh, tc.keep)); !reflect.DeepEqual(got, tc.want) {
			t.Errorf("keep %d：%v，want %v", tc.keep, got, tc.want)
		}
	}
}

func TestTaskDialoguePackagesBySide(t *testing.T) {
	packages := []taskListedPackage{
		{Key: "unit-names.r2.a", Dialogue: true}, {Key: "unit-names.r1.a", Dialogue: true}, {Key: "unit-names.r1.b", Dialogue: true},
		{Key: "other.r1.a", Dialogue: true}, {Key: "shell"},
	}
	var keys []string
	for _, p := range taskDialoguePackages(packages, "unit-names", "a") {
		keys = append(keys, p.Key)
	}
	if !reflect.DeepEqual(keys, []string{"unit-names.r1.a", "unit-names.r2.a"}) {
		t.Fatal(keys)
	}
}

// The interface's decoding types are the service's own, so a field change there breaks the build here.
func TestTaskWireTypesAreTheKernelsOwn(t *testing.T) {
	for name, pair := range map[string][2]any{
		"mission":  {taskMission{}, kernel.Mission{}},
		"owner":    {taskOwner{}, kernel.Owner{}},
		"package":  {taskPackage{}, kernel.Package{}},
		"attempt":  {taskAttempt{}, kernel.Attempt{}},
		"timeline": {taskTimeline{}, kernel.TimelineResult{}},
		"input":    {taskTimelineInput{}, kernel.TimelineInput{}},
		"entry":    {taskEntry{}, kernel.TimelineEntry{}},
		"listed":   {taskListedPackage{}, kernel.TimelinePackage{}},
		"session":  {taskSession{}, kernel.TimelineSession{}},
		"text":     {taskTextResult{}, kernel.MissionTextResult{}},
	} {
		if reflect.TypeOf(pair[0]) != reflect.TypeOf(pair[1]) {
			t.Errorf("%s 不是服务的类型", name)
		}
	}
}

// Round 1 is the proposal, so the exchange rounds count from one.
func TestTaskRoundLabel(t *testing.T) {
	for _, tc := range []struct {
		e    taskEntry
		want string
	}{
		{taskEntry{Round: 1, RoundKind: "proposal"}, "方案"},
		{taskEntry{Round: 2, RoundKind: "exchange"}, "第 1 轮互评"},
		{taskEntry{Round: 3, RoundKind: "exchange"}, "第 2 轮互评"},
		{taskEntry{Round: 4, RoundKind: "final"}, "最终立场"},
	} {
		if got := taskRoundLabel(tc.e); !strings.HasPrefix(got, tc.want) {
			t.Errorf("第 %d 轮（%s）标成了 %q", tc.e.Round, tc.e.RoundKind, got)
		}
	}
}

// A side's row tells where that side stands: the round it is on, not the
// last round's package that is still waiting behind a failure.
func TestTaskDialogueSideState(t *testing.T) {
	pk := func(states ...string) []taskListedPackage {
		out := make([]taskListedPackage, len(states))
		for i, s := range states {
			out[i] = taskListedPackage{State: s}
		}
		return out
	}
	for _, tc := range []struct {
		states []string
		want   string
	}{
		{[]string{"failed", "pending"}, "失败"},
		{[]string{"accepted", "pending"}, "等依赖"},
		{[]string{"accepted", "running"}, "运行中"},
		{[]string{"accepted", "awaiting_verdict"}, "待结论"},
		{[]string{"accepted", "accepted"}, "已采纳"},
		{nil, "—"},
	} {
		if got := taskDialogueSideState(pk(tc.states...)); got != tc.want {
			t.Errorf("%v → %q，want %q", tc.states, got, tc.want)
		}
	}
}
