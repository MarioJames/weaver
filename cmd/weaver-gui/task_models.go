package main

import (
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/MarioJames/weaver/internal/kernel"
	"github.com/egoist/mygo/ui"
)

// Reuse the service's wire types so fixtures and decoding share its contract.
type taskOwner = kernel.Owner
type taskMission = kernel.Mission
type taskAttempt = kernel.Attempt
type taskPackage = kernel.Package
type taskEvent = kernel.Event
type taskItem = kernel.TranscriptItem
type taskTranscript = kernel.Transcript
type taskArtifact struct {
	ID, Kind, Title, Path, URL string
	CreatedAt                  int64
	Summary                    map[string]any
}
type taskArtifactGroup struct {
	GroupKey string
	Items    []taskArtifact
}
type taskDetail struct {
	taskMission
	Packages []taskPackage
}
type taskState struct {
	revision                             int64
	missions, archived                   []taskMission
	selected, selectedPackage, tab, pane string
	detail                               taskDetail
	events                               []taskEvent
	transcript                           taskTranscript
	artifacts                            []taskArtifactGroup
	transcriptError, error               string
	nextPoll                             time.Time
	archiveOpen, drawer                  bool
	expanded                             map[string]bool
	scroll                               ui.ScrollState
	renderedNext                         int64
}

func newTaskState() taskState {
	return taskState{tab: "agents", pane: "list", expanded: map[string]bool{}}
}
func taskMissionLabel(state string) string {
	labels := map[string]string{"empty": "待拆包", "awaiting_verdict": "待结论", "attention": "需关注", "blocked": "等待依赖", "running": "进行中", "closed": "已完成", "done": "已完成", "completed": "已完成"}
	if label := labels[state]; label != "" {
		return label
	}
	return state
}
func taskPackageLabel(state string) string {
	labels := map[string]string{"running": "运行中", "closed": "已完成", "done": "已完成", "completed": "已完成", "pending": "待定", "launching": "启动中", "awaiting_verdict": "待结论", "accepted": "已采纳", "returned": "已退回", "failed": "失败", "cancelled": "已取消", "handed": "已交给引擎", "result": "有结果"}
	if s := labels[state]; s != "" {
		return s
	}
	return state
}
func taskTime(at int64) string {
	if at == 0 {
		return "—"
	}
	return time.UnixMilli(at).Local().Format("15:04")
}
func taskActivity(at int64, now time.Time) string {
	t := time.UnixMilli(at).In(now.Location())
	if t.Format("2006-01-02") == now.Format("2006-01-02") {
		return t.Format("15:04")
	}
	return t.Format("01-02")
}
func taskGroups(missions []taskMission, now time.Time) [3][]taskMission {
	var groups [3][]taskMission
	start := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	for _, m := range missions {
		i := 2
		t := time.UnixMilli(m.LastActivityAt)
		if !t.Before(start) {
			i = 0
		} else if !t.Before(start.AddDate(0, 0, -2)) {
			i = 1
		}
		groups[i] = append(groups[i], m)
	}
	for i := range groups {
		sort.SliceStable(groups[i], func(a, b int) bool { return groups[i][a].LastActivityAt > groups[i][b].LastActivityAt })
	}
	return groups
}
func taskSummary(a taskArtifact) string {
	if a.Kind == "design" {
		return fmt.Sprintf("待拍板 %v 项 · 验收清单 %v 项", taskNumber(a.Summary["decisions"]), taskNumber(a.Summary["checks"]))
	}
	if a.Kind == "report" {
		parts := []string{}
		if v, ok := a.Summary["verdict"].(string); ok && v != "" {
			parts = append(parts, "结论："+v)
		}
		for _, status := range []struct{ key, label string }{{"pass", "通过"}, {"fail", "失败"}, {"blocked", "阻塞"}, {"skipped", "未执行"}} {
			count := fmt.Sprint(taskNumber(a.Summary[status.key]))
			if count != "0" {
				parts = append(parts, status.label+" "+count)
			}
		}
		return strings.Join(parts, " · ")
	}
	return ""
}
func taskNumber(v any) any {
	if v == nil {
		return 0
	}
	return v
}

// Each package belongs to the plan nearest its creation. A submit can claim only
// its nearest plan, within the lookback window and clock skew allowance.
// Unmatched packages stay visible in the fallback group.
func taskPlanCards(items []taskItem, events []taskEvent, packages []taskPackage) map[int][]taskPackage {
	mission := ""
	if len(packages) > 0 {
		mission = packages[0].MissionID
		if mission == "" {
			mission, _, _ = strings.Cut(packages[0].ID, "/")
		}
	}
	planTools := map[int]int{}
	toolPlans := map[int]int{}
	toolDistances := map[int]int64{}
	for j, e := range events {
		if e.Kind != "plan" {
			continue
		}
		planMission := e.Mission
		if planMission == "" {
			planMission = mission
		}
		tool := -1
		distance := int64(1<<63 - 1)
		for i, item := range items {
			if item.Weaver == nil || item.Weaver.Command != "plan submit" {
				continue
			}
			if ref := item.Weaver.Mission; ref != "" && !strings.HasPrefix(planMission, ref) {
				continue
			}
			d := e.At - item.At
			if d < -5000 || d > 120000 {
				continue
			}
			if d < 0 {
				d = -d
			}
			if d < distance {
				tool, distance = i, d
			}
		}
		if tool < 0 {
			continue
		}
		if previous, claimed := toolPlans[tool]; claimed {
			if toolDistances[tool] <= distance {
				continue
			}
			delete(planTools, previous)
		}
		planTools[j] = tool
		toolPlans[tool] = j
		toolDistances[tool] = distance
	}
	out := map[int][]taskPackage{}
	for _, p := range packages {
		plan := -1
		distance := int64(1<<63 - 1)
		for j, e := range events {
			if e.Kind != "plan" {
				continue
			}
			d := e.At - p.CreatedAt
			if d < 0 {
				d = -d
			}
			if d < distance {
				plan = j
				distance = d
			}
		}
		tool := -1
		if matched, ok := planTools[plan]; ok {
			tool = matched
		}
		out[tool] = append(out[tool], p)
	}
	return out
}

func taskVerdict(item taskItem, events []taskEvent, packages []taskPackage) string {
	if item.Weaver == nil || item.Weaver.Command != "verdict" {
		return ""
	}
	for _, p := range packages {
		ref := item.Weaver.Package
		if ref != p.ID && ref != p.Key && !strings.HasSuffix(ref, "/"+p.Key) {
			continue
		}
		label := taskPackageLabel(p.State)
		distance := int64(120000)
		for _, e := range events {
			if e.Package != p.ID && e.Key != p.Key {
				continue
			}
			if e.Kind != "accepted" && e.Kind != "returned" {
				continue
			}
			d := e.At - item.At
			if d < 0 {
				d = -d
			}
			if d < distance {
				label = taskPackageLabel(e.Kind)
				distance = d
			}
		}
		return label
	}
	return ""
}
