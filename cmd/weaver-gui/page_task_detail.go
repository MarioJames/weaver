package main

import (
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/egoist/mygo/ui"
	"github.com/lobehub/lobe-mygo/pkg/action"
	"github.com/lobehub/lobe-mygo/pkg/display"
	"github.com/lobehub/lobe-mygo/pkg/feedback"
	"github.com/lobehub/lobe-mygo/pkg/lucide"
	"github.com/lobehub/lobe-mygo/pkg/markdown"
	"github.com/lobehub/lobe-mygo/pkg/theme"
)

const (
	taskUserLines   = 6
	taskOwnerLines  = 6
	taskAgentLines  = 3
	taskReturnLines = 2
)

func (a *app) taskDetailPage(c *ui.Context, s *taskState) {
	d := &s.d
	// A running package's elapsed time is read off the clock, so repaint now and then.
	for _, p := range d.packages {
		if p.State == "running" || p.State == "launching" {
			c.After(10 * time.Second)
			break
		}
	}
	a.taskDetailHeader(c, s)
	ui.Column(c).FillWidth().Grow(1).Basis(0).MinHeight(0).Gap(0).Children(func() {
		switch {
		case !d.loaded && d.err != "":
			stateError(c, "没能读取任务", d.err+"，2 秒后自动重试", nil)
		case !d.loaded:
			stateLoading(c, "正在读取任务")
		default:
			if d.err != "" {
				inlineError(c, "没能更新任务", d.err)
			}
			a.taskTimelineView(c, s)
		}
	})
	a.taskDrawers(c, s)
}

func (a *app) taskDetailHeader(c *ui.Context, s *taskState) {
	d := &s.d
	tk := theme.TokensOf(c)
	m := d.mission
	if m == nil {
		m = &taskMission{ID: s.selected}
	}
	ui.Column(c).FillWidth().AlignItems(ui.Center).Gap(10).Children(func() {
		ui.Column(c).FillWidth().MaxWidth(860).Gap(10).Children(func() {
			ui.Row(c).FillWidth().Gap(12).AlignItems(ui.Center).Children(func() {
				back := action.StyleButton(c, ui.ButtonBase(c).Label("返回任务列表"), "", action.ButtonProps{})
				back.Children(func() {
					display.Icon(c, lucide.ArrowLeft(), display.IconProps{Size: display.IconSmall})
					ui.Text(c, "任务").SingleLine()
				})
				if back.Clicked() {
					a.leaveTask(s)
					return
				}
				taskAvatar(c, s.selected, 28)
				ui.Column(c).Grow(1).Basis(0).MinWidth(0).Gap(3).Children(func() {
					ui.Text(c, m.Title).FontSize(16).FontWeight(600).TextColor(tk.Text).MaxLines(2)
					ui.Row(c).Gap(8).AlignItems(ui.Center).Wrap().Children(func() {
						taskStatusTag(c, *m)
						progress := fmt.Sprintf("%d / %d 已采纳", m.Counts["accepted"], m.Total)
						if n := m.Counts["cancelled"]; n > 0 {
							progress += fmt.Sprintf(" · %d 已取消", n)
						}
						ui.Text(c, progress+" · "+taskMissionSubtitle(*m)).FontSize(12).TextColor(tk.TextTertiary)
					})
				})
				ui.Row(c).Gap(8).AlignItems(ui.Center).Shrink(0).Children(func() {
					artifacts := action.StyleButton(c, ui.ButtonBase(c), "", action.ButtonProps{})
					artifacts.Children(func() {
						display.Icon(c, lucide.Folder(), display.IconProps{Size: display.IconSmall})
						ui.Text(c, fmt.Sprintf("产物 %d", m.Artifacts)).SingleLine()
					})
					if artifacts.Clicked() {
						a.openArtifacts(s)
					}
					if !m.Archived {
						a.button(c, "tasks:archive:"+s.selected, "归档", func() { a.taskArchive(s, s.selected, true) })
					}
				})
			})
			fieldError(c, a.errors["tasks:archive:"+s.selected])
			ui.Box(c).Height(1).AlignSelf(ui.Stretch).Background(tk.Split)
			if notice := taskSessionNotice(d); notice != "" {
				ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
					display.Icon(c, lucide.Info(), display.IconProps{Size: display.IconSmall}).TextColor(tk.TextTertiary)
					ui.Text(c, notice).FontSize(12).TextColor(tk.TextTertiary)
				})
			}
		})
	})
}

func taskSessionNotice(d *taskDetail) string {
	if !d.loaded {
		return ""
	}
	switch d.session.State {
	case "none":
		return "未关联父 Agent 会话，只显示调度记录"
	case "unsupported":
		return "暂不支持读取这个父 Agent 的会话，只显示调度记录"
	case "missing":
		return "父会话文件已不在，对话显示到 " + taskTime(d.session.SyncedTo)
	case "rewritten":
		return "父会话文件被改写，对话显示到 " + taskTime(d.session.SyncedTo)
	}
	return ""
}

func (a *app) taskTimelineView(c *ui.Context, s *taskState) {
	d := &s.d
	d.followBottom()
	ui.Scroll(c.Key("task-timeline")).Grow(1).Basis(0).MinHeight(0).TrackScroll(d.scroll).Children(func() {
		ui.Column(c).FillWidth().AlignItems(ui.Center).Padding(14, 0, 32).Children(func() {
			ui.Column(c).FillWidth().MaxWidth(860).Gap(18).Children(func() {
				if d.hasMore {
					ui.Row(c.Key("earlier")).Justify(ui.Center).Children(func() {
						label := "显示更早的内容"
						if d.loadingMore {
							label = "正在读取…"
						}
						if action.Button(c, label, action.ButtonProps{Variant: action.Text, Size: theme.Small}).Clicked() {
							a.loadEarlier(s)
						}
					})
				}
				if !d.hasMore && d.earlierInfo != nil {
					a.taskEarlier(c, s)
				}
				a.taskEntries(c, s, d.entries)
			})
		})
	})
}

func (a *app) taskEntries(c *ui.Context, s *taskState, entries []taskEntry) {
	for i := 0; i < len(entries); {
		e := entries[i]
		next := i + 1
		if e.Kind == "owner" || e.Kind == "ops" {
			// One speaker header covers the owner's run of speech and operations.
			for next < len(entries) && (entries[next].Kind == "owner" || entries[next].Kind == "ops") {
				next++
			}
		}
		group := entries[i:next]
		ui.Column(c.Key(e.Ord)).FillWidth().Children(func() { a.taskEntryView(c, s, group) })
		i = next
	}
}

// taskEarlier heads a mission created later in a session: it names the
// mission this part follows and opens the conversation before it in place.
func (a *app) taskEarlier(c *ui.Context, s *taskState) {
	d := &s.d
	info := d.earlierInfo
	toggle := func(label string) {
		if action.Button(c, label, action.ButtonProps{Variant: action.Text, Size: theme.Small}).Disabled(d.earlierLoading).Clicked() {
			a.toggleEarlier(s)
		}
	}
	label := "展开此前的对话"
	if info.Count > 0 {
		label = fmt.Sprintf("展开此前 %d 条对话", info.Count)
	}
	if d.earlierOpen {
		label = "收起此前的对话"
	}
	ui.Column(c.Key("earlier-session")).FillWidth().Gap(18).Children(func() {
		taskProcessRowEnd(c, lucide.History(), taskToneNeutral, "接续自任务", info.Title, "", func() { toggle(label) }, nil)
		if !d.earlierOpen {
			return
		}
		switch {
		case d.earlierLoading:
			display.Text(c, "正在读取此前的对话…", display.TextProps{Type: display.TextSecondary, FontSize: 13}).PaddingStart(44)
		case d.earlierErr != "":
			ui.Column(c).PaddingStart(44).Children(func() { fieldError(c, d.earlierErr) })
		default:
			a.taskEntries(c, s, d.earlier)
			ui.Column(c).FillWidth().Gap(4).AlignItems(ui.Center).Children(func() {
				taskDivider(c, "以上是此前的对话", true)
				toggle("收起此前的对话")
			})
		}
	})
}

func taskPreviewOf(e taskEntry) (text string, clipped bool) {
	return taskPlainText(e.Text), e.Chars > utf8.RuneCountInString(e.Text)
}

func taskHeaderOf(c *ui.Context, h taskHeaderInfo, size float32) taskMessageHeader {
	out := taskMessageHeader{Name: h.Name, Role: h.Role, Meta: h.Meta, Time: h.Time}
	switch {
	case h.Convorel:
		out.Avatar = func() { taskConvorelMark(c, size) }
	case h.Seed != "":
		out.Avatar = func() { taskAvatarAvoid(c, h.Seed, h.Avoid, size) }
	}
	return out
}

func taskSideLabel(side string) string {
	switch side {
	case "b":
		return "乙方"
	case "c":
		return "丙方"
	default:
		return "甲方"
	}
}

// taskEntryTarget names who an entry is about: a package, or one side of a dialogue.
func taskEntryTarget(e taskEntry) string {
	if e.Name != "" {
		return e.Name + " · " + taskSideLabel(e.Side)
	}
	return e.Package
}

func (a *app) taskOwnerHeader(s *taskState, meta string, at int64) taskHeaderInfo {
	return taskHeaderInfo{Seed: s.selected, Name: taskOwnerName(s.d.mission, s.d.session), Role: taskRoleOwner, Meta: meta, Time: taskTime(at)}
}

// taskSpeech draws one dialog: the speaker, then the clipped text. The click on
// 查看全文 opens the drawer with the same header.
func (a *app) taskSpeech(c *ui.Context, s *taskState, h taskHeaderInfo, e taskEntry, lines int) {
	text, clipped := taskPreviewOf(e)
	taskMessage(c, taskHeaderOf(c, h, 32), func() {
		taskBubble(c, func() {
			if taskPreviewChars(c, text, lines, e.Chars, clipped) {
				a.openText(s, e.Ref, h)
			}
		})
	})
}

func (a *app) taskEntryView(c *ui.Context, s *taskState, group []taskEntry) {
	d := &s.d
	e := group[0]
	at := taskTime(e.At)
	id := s.selected
	kind := e.Kind
	if len(group) > 1 {
		// Operations followed by the owner's words: the header goes on top of both.
		kind = "owner"
	}
	switch kind {
	case "user":
		text, clipped := taskPreviewOf(e)
		if taskUserMessage(c, at, text, taskUserLines, e.Chars, clipped) {
			a.openText(s, e.Ref, taskHeaderInfo{Name: "你", Time: at})
		}
	case "owner":
		h := a.taskOwnerHeader(s, "", e.At)
		taskMessage(c, taskHeaderOf(c, h, 32), func() {
			for _, g := range group {
				ui.Column(c.Key(g.Ord)).Gap(6).Children(func() {
					if g.Kind == "ops" {
						a.taskOps(c, d, g, false)
						return
					}
					text, clipped := taskPreviewOf(g)
					taskBubble(c, func() {
						if taskPreviewChars(c, text, taskOwnerLines, g.Chars, clipped) {
							a.openText(s, g.Ref, a.taskOwnerHeader(s, "", g.At))
						}
					})
				})
			}
		})
	case "ops":
		ui.Column(c).PaddingStart(44).Gap(6).Children(func() { a.taskOps(c, d, e, true) })
	case "created":
		taskProcessRow(c, lucide.Flag(), taskToneNeutral, "创建主任务", "", at, nil)
	case "closed":
		taskProcessRow(c, lucide.CircleCheck(), taskToneNeutral, "任务结束", "", at, nil)
	case "timer":
		taskProcessRow(c, lucide.Clock(), taskToneNeutral, e.Text, "", at, nil)
	case "external":
		taskProcessRow(c, lucide.Bell(), taskToneNeutral, e.Text, "", at, nil)
	case "retry":
		taskProcessRow(c, lucide.RotateCcw(), taskToneNeutral, "重试", taskEntryTarget(e), at, nil)
	case "cancelled":
		taskProcessRow(c, lucide.Ban(), taskToneNeutral, "取消", taskEntryTarget(e), at, nil)
	case "dispatch":
		a.taskDispatch(c, s, e)
	case "dialogue":
		a.taskDialogue(c, s, e)
	case "result":
		meta := e.Worker
		if e.Attempt >= 2 {
			meta += fmt.Sprintf(" · 第 %d 次", e.Attempt)
		}
		a.taskSpeech(c, s, taskHeaderInfo{Seed: id + "/" + e.Package, Name: e.Package, Role: taskRoleWorker, Meta: meta, Time: at}, e, taskAgentLines)
	case "accepted":
		taskProcessRow(c, lucide.Check(), taskToneSuccess, "采纳", taskEntryTarget(e), at, a.taskNote(c, s, e, 0))
	case "returned":
		taskProcessRow(c, lucide.Undo2(), taskToneWarning, "退回", taskEntryTarget(e), at, a.taskNote(c, s, e, taskReturnLines))
	case "problem":
		steps := make([]taskProblemStep, len(e.Steps))
		for i, step := range e.Steps {
			steps[i] = taskProblemStep{Time: taskTime(step.At), Action: taskStepLabel(step.Action), Detail: step.Text}
		}
		attempt := ""
		if e.Attempt > 0 {
			attempt = fmt.Sprintf("第 %d 次尝试", e.Attempt)
		}
		taskProblem(c, taskProblemProps{Target: taskEntryTarget(e), Status: taskProblemLabel(e.Problem), Attempt: attempt, Time: at, Reason: e.Reason, Steps: steps})
	case "artifact":
		if e.Artifact == nil {
			return
		}
		item := taskArtifact{ID: e.Artifact.ID, Kind: e.Artifact.Kind, Title: e.Artifact.Title, Path: e.Artifact.Path, URL: e.Artifact.URL}
		taskProcessRowEnd(c, lucide.Paperclip(), taskToneNeutral, "登记产物", item.Title, at, func() { a.taskOpenButton(c, item, true) }, nil)
	case "round":
		taskDivider(c, taskRoundLabelFor(e, taskDialogueSideCount(d.entries, e.Name)), false)
	case "debater":
		avoid := ""
		switch e.Side {
		case "b":
			avoid = id + "/" + e.Name + ".a"
		case "c":
			avoid = id + "/" + e.Name + ".b"
		}
		name := e.Model
		if name == "" {
			name = e.Worker
		}
		a.taskSpeech(c, s, taskHeaderInfo{Seed: id + "/" + e.Name + "." + e.Side, Avoid: avoid, Name: name, Role: taskRoleDebater, Meta: taskSideLabel(e.Side) + " · " + e.Engine, Time: at}, e, taskAgentLines)
	case "ask":
		a.taskSpeech(c, s, a.taskOwnerHeader(s, "问 Convorel", e.At), e, taskAgentLines)
	case "review":
		h := taskHeaderInfo{Convorel: true, Name: "Convorel", Role: taskRoleReviewer, Meta: e.Model, Time: at}
		if e.State != "complete" {
			tk := theme.TokensOf(c)
			word := "审查状态未知"
			switch e.State {
			case "waiting":
				word = "等待回复…"
			case "not_sent":
				word = "尚未投递"
			case "rejected":
				word = "投递被拒绝"
			case "delivery_unknown":
				word = "投递结果尚未确认"
			case "blocked":
				word = "回复读取受阻"
			case "failed":
				word = "这一轮没有拿到回复"
			case "lost":
				word = "无法找到这一轮会话"
			case "superseded":
				word = "这一轮已被替代"
			case "incomplete":
				word = "回复尚不完整"
			}
			taskMessage(c, taskHeaderOf(c, h, 32), func() {
				taskBubble(c, func() {
					ui.Column(c).Gap(6).Children(func() {
						ui.Text(c, word).FontSize(14).LineHeight(1.6).TextColor(tk.TextSecondary)
						if e.Text != "" {
							text, clipped := taskPreviewOf(e)
							if taskPreviewChars(c, text, taskAgentLines, e.Chars, clipped) {
								a.openText(s, e.Ref, h)
							}
						}
					})
				})
			})
			return
		}
		a.taskSpeech(c, s, h, e, taskAgentLines)
	}
}

// taskOps is the operations row; steps list the tool in a muted weight before the summary.
func (a *app) taskOps(c *ui.Context, d *taskDetail, e taskEntry, standalone bool) {
	label := fmt.Sprintf("%d 步操作", len(e.Ops))
	if len(e.Ops) > 0 && e.To-e.Ops[0].At >= 60_000 {
		label += fmt.Sprintf(" · %d 分钟", (e.To-e.Ops[0].At)/60_000)
	}
	if standalone {
		label = "父 Agent 做了 " + label
	}
	steps := make([]taskOperation, len(e.Ops))
	for i, op := range e.Ops {
		steps[i] = taskOperation{Tool: op.Tool, Summary: strings.TrimPrefix(op.Text, op.Tool+": ")}
	}
	open := d.expanded[e.Ord]
	taskOperations(c, &open, label, steps)
	d.expanded[e.Ord] = open
}

// taskNote is the quote under 采纳 and 退回, in the owner's own words.
func (a *app) taskNote(c *ui.Context, s *taskState, e taskEntry, lines int) func() {
	if e.Note == "" {
		return nil
	}
	return func() {
		text := taskPlainText(e.Note)
		if lines == 0 {
			taskQuote(c, text, 0, "")
			return
		}
		if taskQuoteNote(c, text, e.NoteChars, lines, e.NoteChars > utf8.RuneCountInString(e.Note)) {
			a.openText(s, e.NoteRef, a.taskOwnerHeader(s, "", e.At))
		}
	}
}

func taskStepLabel(action string) string {
	labels := map[string]string{"retry": "重试", "failed": "再次失败", "cancelled": "取消", "result": "交回结果", "accepted": "已采纳"}
	if l := labels[action]; l != "" {
		return l
	}
	return action
}

func taskProblemLabel(problem string) string {
	labels := map[string]string{"failed": "失败", "stalled": "卡住", "anomaly": "异常", "account": "账号受限"}
	if l := labels[problem]; l != "" {
		return l
	}
	return problem
}

func taskDialogueSideCount(entries []taskEntry, name string) int {
	for _, e := range entries {
		if e.Kind == "dialogue" && e.Name == name && len(e.Sides) > 0 {
			return len(e.Sides)
		}
	}
	return 2
}

func taskRoundLabel(e taskEntry) string {
	return taskRoundLabelFor(e, 2)
}

func taskRoundLabelFor(e taskEntry, sideCount int) string {
	switch e.RoundKind {
	case "proposal":
		if sideCount >= 3 {
			return "方案 · 三方同时写，互相看不到"
		}
		return "方案 · 两方同时写，互相看不到"
	case "final":
		if sideCount >= 3 {
			return "最终立场 · 各自读完其他方的方案后，评对方并修订自己"
		}
		return "最终立场 · 各自读完对方的方案后，评对方并修订自己"
	}
	return fmt.Sprintf("第 %d 轮互评 · 各自读完对方上一轮后写", e.Round-1)
}

func (a *app) taskDispatch(c *ui.Context, s *taskState, e taskEntry) {
	d := &s.d
	now := time.Now()
	byKey := map[string]taskListedPackage{}
	for _, p := range d.packages {
		byKey[p.Key] = p
	}
	var listed []taskListedPackage
	rows := make([]taskRosterRow, 0, len(e.Packages))
	for _, key := range e.Packages {
		p, ok := byKey[key]
		if !ok {
			p = taskListedPackage{Key: key}
		}
		listed = append(listed, p)
		cost := "—"
		if ms, ok := taskPackageSpan(p, now); ok {
			cost = taskElapsed(ms)
		}
		rows = append(rows, taskRosterRow{Key: key, Seed: s.selected + "/" + key, Title: p.Title, Worker: p.Worker, State: taskRosterState(p), Cost: cost})
	}
	title := fmt.Sprintf("派出 %d 个 Agent", len(e.Packages))
	if key := taskRoster(c, lucide.Send(), title, taskDispatchSummary(listed), taskTime(e.At), rows); key != "" {
		a.openPackage(s, key)
	}
}

func (a *app) taskDialogue(c *ui.Context, s *taskState, e taskEntry) {
	d := &s.d
	now := time.Now()
	base := s.selected + "/" + e.Name
	rows := make([]taskRosterRow, 0, len(e.Sides))
	for _, side := range e.Sides {
		packages := taskDialoguePackages(d.packages, e.Name, side.Side)
		state, cost := taskDialogueSideState(packages), "—"
		if len(packages) > 0 {
			var total int64
			var any bool
			for _, p := range packages {
				if ms, ok := taskPackageSpan(p, now); ok {
					total, any = total+ms, true
				}
			}
			if any {
				cost = taskElapsedExact(total)
			}
		}
		var parts []string
		for _, part := range []string{side.Engine, side.Model, side.Effort} {
			if part != "" {
				parts = append(parts, part)
			}
		}
		row := taskRosterRow{Key: side.Side, Name: taskSideLabel(side.Side), Seed: base + "." + side.Side, Title: strings.Join(parts, " · "), Worker: side.Account, State: state, Cost: cost}
		switch side.Side {
		case "b":
			row.AvoidSeed = base + ".a"
		case "c":
			row.AvoidSeed = base + ".b"
		}
		rows = append(rows, row)
	}
	taskRoster(c, lucide.MessagesSquare(), "发起对谈 "+e.Name, fmt.Sprintf("%d 轮互评", e.Rounds), taskTime(e.At), rows)
}

// taskOpenButton opens an artifact with the system's default app. quiet gives
// the timeline's unframed text button; the panel uses the page's plain button.
func (a *app) taskOpenButton(c *ui.Context, item taskArtifact, quiet bool) {
	key := "artifact:open:" + item.ID
	open := func() {
		a.action(key, func() (string, error) {
			target, err := taskArtifactTarget(item)
			if err != nil {
				return "", err
			}
			return command(a.ctx, "xdg-open", target)
		}, nil)
	}
	if !quiet {
		a.button(c, key, "打开", open)
		return
	}
	label := "打开"
	if a.busy[key] {
		label = "打开中…"
	}
	if action.Button(c, label, action.ButtonProps{Variant: action.Text, Size: theme.Small}).Disabled(a.busy[key]).Clicked() {
		open()
	}
}

func (a *app) taskDrawers(c *ui.Context, s *taskState) {
	d := &s.d
	width, _ := c.Size()
	size := min(float32(520), float32(width))
	h := taskHeaderOf(c, d.textHeader, 28)
	taskDrawer(c, &d.textOpen, taskDrawerProps{Title: d.textTitle, Header: &h, Markdown: d.textBody, Loading: d.textLoading, Error: d.textErr})
	tk := theme.TokensOf(c)
	key := d.packageKey
	state := ""
	var worker string
	for _, p := range d.packages {
		if p.Key == key {
			state, worker = " · "+taskPackageLabel(p.State), p.Worker
		}
	}
	feedback.Drawer(c, &d.packageOpen, feedback.DrawerProps{Title: key + state, Size: size}, func() {
		ui.Column(c).Gap(14).Children(func() {
			ui.Row(c).Gap(10).AlignItems(ui.Center).Children(func() {
				taskAvatar(c, s.selected+"/"+key, 28)
				ui.Text(c, key).FontSize(14).FontWeight(600).TextColor(tk.Text).SingleLine().Shrink(0)
				taskRoleTag(c, taskRoleWorker)
				ui.Text(c, worker).FontSize(12).TextColor(tk.TextTertiary).SingleLine().Shrink(1).MinWidth(0)
			})
			ui.Box(c).Height(1).AlignSelf(ui.Stretch).Background(tk.Split)
			switch {
			case d.packageLoading:
				ui.Text(c, "正在读取工作包…").FontSize(13).TextColor(tk.TextSecondary)
			case d.packageErr != "":
				ui.Text(c, "读取失败").FontSize(13).TextColor(tk.ErrorText)
				ui.Text(c, d.packageErr).FontSize(13).TextColor(tk.TextSecondary).Selectable()
			default:
				taskAttempts(c, d.packageData)
			}
		})
	})
	feedback.Drawer(c, &d.artifactsOpen, feedback.DrawerProps{Title: "产物", Size: size}, func() {
		ui.Column(c).Gap(10).Children(func() {
			switch {
			case d.artifactsLoading:
				ui.Text(c, "正在读取产物…").FontSize(13).TextColor(tk.TextSecondary)
			case d.artifactsErr != "":
				ui.Text(c, "读取失败").FontSize(13).TextColor(tk.ErrorText)
				ui.Text(c, d.artifactsErr).FontSize(13).TextColor(tk.TextSecondary).Selectable()
			default:
				a.taskArtifacts(c, s)
			}
		})
	})
}

// taskAttempts lists each try in order: the instruction once, every result, and
// the return note that opened the next try.
func taskAttempts(c *ui.Context, p taskPackage) {
	tk := theme.TokensOf(c)
	attempts := p.Attempts
	if len(attempts) == 0 && p.Current != nil {
		attempts = []*taskAttempt{p.Current}
	}
	label := func(text string) {
		ui.Text(c, text).FontSize(12).FontWeight(600).TextColor(tk.TextTertiary)
	}
	for i, at := range attempts {
		ui.Column(c.Key(at.N)).Gap(10).Children(func() {
			if at.Note != "" {
				label("退回意见")
				markdown.Markdown(c, at.Note, markdown.MarkdownProps{Variant: markdown.Chat})
			}
			ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
				ui.Text(c, fmt.Sprintf("第 %d 次", at.N)).FontSize(14).FontWeight(600).TextColor(tk.Text)
				if at.Worker != "" {
					ui.Text(c, at.Worker).FontSize(12).TextColor(tk.TextTertiary)
				}
			})
			if i == 0 && p.Instruction != "" {
				label("指令")
				markdown.Markdown(c, p.Instruction, markdown.MarkdownProps{Variant: markdown.Chat})
			}
			if at.Result != "" {
				label("结果")
				markdown.Markdown(c, at.Result, markdown.MarkdownProps{Variant: markdown.Chat})
			} else if at.FailureMessage != "" {
				label("失败原因")
				ui.Text(c, at.FailureMessage).FontSize(13).LineHeight(1.6).TextColor(tk.ErrorText).Selectable()
			}
		})
	}
}

// taskArtifacts groups artifacts by kind; older versions fold behind a count.
func (a *app) taskArtifacts(c *ui.Context, s *taskState) {
	d := &s.d
	if len(d.artifacts) == 0 {
		display.Text(c, "还没有产物", display.TextProps{Strong: true})
		display.Text(c, "分享时加 --mission <主任务 ID>，或用 weaver artifact add 登记", display.TextProps{Type: display.TextSecondary, FontSize: 12})
		return
	}
	for _, folder := range []struct{ kind, label string }{{"design", "设计"}, {"report", "验收"}, {"evidence", "证据"}, {"doc", "其他"}} {
		type versions struct {
			key   string
			items []taskArtifact
		}
		var found []versions
		for _, group := range d.artifacts {
			items := []taskArtifact{}
			for _, item := range group.Items {
				if item.Kind == folder.kind || folder.kind == "doc" && item.Kind != "design" && item.Kind != "report" && item.Kind != "evidence" {
					items = append(items, item)
				}
			}
			if len(items) > 0 {
				found = append(found, versions{"versions:" + folder.kind + ":" + group.GroupKey, items})
			}
		}
		if len(found) == 0 {
			continue
		}
		display.Text(c, fmt.Sprintf("%s · %d", folder.label, len(found)), display.TextProps{FontSize: 12, Type: display.TextSecondary})
		for _, v := range found {
			key, items := v.key, v.items
			ui.Column(c.Key(key)).Padding(4, 0).Gap(8).Children(func() {
				a.taskArtifactRow(c, items[0])
				if len(items) > 1 {
					ui.Row(c).Children(func() {
						if ui.Button(c, fmt.Sprintf("%d 个版本", len(items))).Clicked() {
							d.expanded[key] = !d.expanded[key]
						}
					})
					if d.expanded[key] {
						for _, old := range items[1:] {
							a.taskArtifactRow(c, old)
						}
					}
				}
			})
		}
	}
}

func (a *app) taskArtifactRow(c *ui.Context, item taskArtifact) {
	ui.Column(c.Key(item.ID)).Gap(4).Children(func() {
		ui.Row(c).Gap(12).AlignItems(ui.Center).Children(func() {
			ui.Column(c).Grow(1).Basis(0).MinWidth(0).Gap(2).Children(func() {
				display.Text(c, item.Title, display.TextProps{FontSize: 13, Strong: true})
				if summary := taskSummary(item); summary != "" {
					display.Text(c, summary, display.TextProps{FontSize: 12, Type: display.TextSecondary})
				}
			})
			ui.Row(c).Shrink(0).Children(func() { a.taskOpenButton(c, item, false) })
		})
		fieldError(c, a.errors["artifact:open:"+item.ID])
	})
}
