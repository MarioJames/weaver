package main

import (
	"fmt"
	"path/filepath"
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
type taskTimeline = kernel.TimelineResult
type taskTimelineInput = kernel.TimelineInput
type taskEntry = kernel.TimelineEntry
type taskListedPackage = kernel.TimelinePackage
type taskSession = kernel.TimelineSession
type taskTextResult = kernel.MissionTextResult
type taskArtifact struct {
	ID, Kind, Title, Path, URL string
	CreatedAt                  int64
	Summary                    map[string]any
}
type taskArtifactGroup struct {
	GroupKey string
	Items    []taskArtifact
}

// taskHeaderInfo is who is speaking, kept as data so the full-text drawer can
// draw the same header as the dialog it was opened from.
type taskHeaderInfo struct {
	Seed, Avoid, Name, Role, Meta, Time string
	Convorel                            bool
}

type taskDetail struct {
	mission  *taskMission
	packages []taskListedPackage
	session  taskSession
	entries  []taskEntry
	hasMore  bool
	loaded   bool
	err      string
	// gen counts prepends, so a long poll that started before one is dropped.
	gen         int
	loadingMore bool
	// scroll is written by layout outside app.mu, so it has its own allocation
	// and only the frame reads it; background work never touches it.
	scroll *ui.ScrollState
	pinned bool
	// grew marks a timeline update not laid out yet; seenMax is the content
	// extent the last frame saw.
	grew         bool
	seenMax      float32
	prepended    bool
	restoreOpen  bool
	restoreAbove float32
	restoreMax   float32
	expanded     map[string]bool

	artifactsOpen, artifactsLoading bool
	artifactsErr                    string
	artifacts                       []taskArtifactGroup

	textOpen, textLoading bool
	textSeq               int
	textErr               string
	textTitle, textBody   string
	textHeader            taskHeaderInfo

	packageOpen, packageLoading bool
	packageSeq                  int
	packageErr, packageKey      string
	packageData                 taskPackage
}

type taskState struct {
	revision           int64
	missions, archived []taskMission
	loaded             bool
	filter             int
	selected, error    string
	nextPoll           time.Time
	listScroll         ui.ScrollState
	d                  taskDetail
}

const (
	taskFilterAll = iota
	taskFilterActive
	taskFilterAttention
	taskFilterDone
	taskFilterArchived
)

func newTaskState() taskState { return taskState{} }

func newTaskDetail(m *taskMission) taskDetail {
	return taskDetail{mission: m, expanded: map[string]bool{}, scroll: &ui.ScrollState{}}
}

func taskMissionLabel(state string) string {
	labels := map[string]string{"empty": "待拆包", "awaiting_verdict": "待结论", "attention": "需关注", "dialogue_error": "对谈异常", "blocked": "等待依赖", "running": "进行中", "closed": "已完成", "done": "已完成", "completed": "已完成"}
	if label := labels[state]; label != "" {
		return label
	}
	return state
}

// taskNeedsAttention: something failed and waits for the owner; a failed dialogue side has its own label.
func taskNeedsAttention(m taskMission) bool {
	return m.State == "attention" || m.State == "dialogue_error"
}
func taskMissionDone(m taskMission) bool {
	return m.ClosedAt != 0 || m.State == "closed" || m.State == "done" || m.State == "completed"
}

// taskFilterMatches applies a filter to the unarchived list; archived uses its own list.
func taskFilterMatches(filter int, m taskMission) bool {
	switch filter {
	case taskFilterActive:
		return !taskNeedsAttention(m) && !taskMissionDone(m)
	case taskFilterAttention:
		return taskNeedsAttention(m)
	case taskFilterDone:
		return taskMissionDone(m)
	}
	return true
}
func taskFilterCounts(missions, archived []taskMission) [5]int {
	counts := [5]int{len(missions), 0, 0, 0, len(archived)}
	for _, m := range missions {
		for f := taskFilterActive; f <= taskFilterDone; f++ {
			if taskFilterMatches(f, m) {
				counts[f]++
			}
		}
	}
	return counts
}
func taskFilterRows(filter int, missions, archived []taskMission) []taskMission {
	if filter == taskFilterArchived {
		return archived
	}
	var out []taskMission
	for _, m := range missions {
		if taskFilterMatches(filter, m) {
			out = append(out, m)
		}
	}
	return out
}

func taskPackageLabel(state string) string {
	labels := map[string]string{"running": "运行中", "closed": "已完成", "done": "已完成", "completed": "已完成", "pending": "待定", "launching": "启动中", "awaiting_verdict": "待结论", "accepted": "已采纳", "returned": "已退回", "failed": "失败", "cancelled": "已取消"}
	if s := labels[state]; s != "" {
		return s
	}
	return state
}

// taskRosterState words are the ones the roster's status dot colors by.
func taskRosterState(p taskListedPackage) string {
	if p.State == "pending" {
		return "等依赖"
	}
	return taskPackageLabel(p.State)
}

// taskDialogueSideState is one side's standing: the first round it has not
// got through, or the last round once all are accepted.
func taskDialogueSideState(rounds []taskListedPackage) string {
	if len(rounds) == 0 {
		return "—"
	}
	for _, p := range rounds {
		if p.State != "accepted" {
			return taskRosterState(p)
		}
	}
	return taskRosterState(rounds[len(rounds)-1])
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

func taskEngineName(engine string) string {
	switch engine {
	case "claude":
		return "Claude"
	case "codex":
		return "Codex"
	}
	return engine
}

// taskMissionSubtitle names the parent Agent and the working directory's last segment.
func taskMissionSubtitle(m taskMission) string {
	dir := filepath.Base(strings.TrimRight(m.Workspace, "/"))
	if dir == "." || dir == "/" {
		dir = ""
	}
	if m.Owner == nil || m.Owner.Engine == "" {
		return strings.TrimSuffix("未关联父会话 · "+dir, " · ")
	}
	return strings.TrimSuffix(taskEngineName(m.Owner.Engine)+" · "+dir, " · ")
}

func taskProgress(m taskMission) (string, string) {
	cancelled := ""
	if n := m.Counts["cancelled"]; n > 0 {
		cancelled = fmt.Sprintf("%d 已取消", n)
	}
	return fmt.Sprintf("%d / %d", m.Counts["accepted"], m.Total), cancelled
}

// taskOwnerName is the parent Agent's display name; the mission's registered
// engine wins over the one the timeline reports.
func taskOwnerName(m *taskMission, s taskSession) string {
	engine := s.Engine
	if m != nil && m.Owner != nil && m.Owner.Engine != "" {
		engine = m.Owner.Engine
	}
	if name := taskEngineName(engine); name != "" {
		return name
	}
	return "父 Agent"
}

// taskPlainText turns the head of a Markdown source into preview text: no
// heading marks, bold stars, code ticks or list bullets, and blank lines gone.
func taskPlainText(md string) string {
	var lines []string
	for _, line := range strings.Split(strings.ReplaceAll(md, "\r\n", "\n"), "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "```") {
			continue
		}
		if rest := strings.TrimLeft(trimmed, "#"); len(rest) < len(trimmed) && strings.HasPrefix(rest, " ") {
			trimmed = strings.TrimSpace(rest)
		}
		switch {
		case strings.HasPrefix(trimmed, "- "), strings.HasPrefix(trimmed, "* "), strings.HasPrefix(trimmed, "+ "):
			trimmed = strings.TrimSpace(trimmed[2:])
		default:
			if i := strings.Index(trimmed, ". "); i > 0 && i <= 3 && strings.Trim(trimmed[:i], "0123456789") == "" {
				trimmed = strings.TrimSpace(trimmed[i+2:])
			}
		}
		trimmed = strings.ReplaceAll(strings.ReplaceAll(trimmed, "**", ""), "`", "")
		if trimmed != "" {
			lines = append(lines, trimmed)
		}
	}
	return strings.Join(lines, "\n")
}

// taskElapsed is the roster's cost column: whole minutes, seconds below one.
func taskElapsed(ms int64) string {
	if ms < 0 {
		ms = 0
	}
	if ms < 60_000 {
		return fmt.Sprintf("%d 秒", ms/1000)
	}
	if ms < 3_600_000 {
		return fmt.Sprintf("%d 分钟", ms/60_000)
	}
	return fmt.Sprintf("%d 小时 %d 分钟", ms/3_600_000, ms%3_600_000/60_000)
}

// taskElapsedExact is the dialogue roster's cost: minutes and zero padded seconds.
func taskElapsedExact(ms int64) string {
	secs := max(ms, 0) / 1000
	if secs < 60 {
		return fmt.Sprintf("%d 秒", secs)
	}
	return fmt.Sprintf("%d 分 %02d 秒", secs/60, secs%60)
}

// taskPackageSpan is the time a package has spent: end minus start for the
// finished, now minus start for the running, and "—" before it starts.
func taskPackageSpan(p taskListedPackage, now time.Time) (int64, bool) {
	if p.StartedAt == 0 {
		return 0, false
	}
	if p.FinishedAt != 0 {
		return p.FinishedAt - p.StartedAt, true
	}
	return now.UnixMilli() - p.StartedAt, true
}

func taskDispatchSummary(packages []taskListedPackage) string {
	if len(packages) == 0 {
		return ""
	}
	count := map[string]int{}
	for _, p := range packages {
		switch p.State {
		case "running", "launching":
			count["在跑"]++
		case "pending":
			count["等依赖"]++
		default:
			count[taskPackageLabel(p.State)]++
		}
	}
	if count["已采纳"] == len(packages) {
		return "全部已采纳"
	}
	var parts []string
	for _, word := range []string{"在跑", "等依赖", "待结论", "失败", "已取消", "已采纳"} {
		if n := count[word]; n > 0 {
			parts = append(parts, fmt.Sprintf("%d 个%s", n, word))
			delete(count, word)
		}
	}
	rest := make([]string, 0, len(count))
	for word := range count {
		rest = append(rest, word)
	}
	sort.Strings(rest)
	for _, word := range rest {
		parts = append(parts, fmt.Sprintf("%d 个%s", count[word], word))
	}
	return strings.Join(parts, "，")
}

// taskMergeEntries is the client half of the timeline's suffix replacement:
// keep the first keep entries and take the rest from the response.
func taskMergeEntries(have, fresh []taskEntry, keep int) []taskEntry {
	keep = max(0, min(keep, len(have)))
	out := make([]taskEntry, 0, keep+len(fresh))
	out = append(out, have[:keep]...)
	return append(out, fresh...)
}

// taskDialoguePackages returns one side's packages, in round order.
func taskDialoguePackages(packages []taskListedPackage, name, side string) []taskListedPackage {
	var out []taskListedPackage
	for _, p := range packages {
		if !p.Dialogue || !strings.HasSuffix(p.Key, "."+side) {
			continue
		}
		prefix := strings.TrimSuffix(p.Key, "."+side)
		if i := strings.LastIndex(prefix, ".r"); i > 0 && prefix[:i] == name {
			out = append(out, p)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Key < out[j].Key })
	return out
}
