package main

import (
	"fmt"
	"time"

	"github.com/egoist/mygo/ui"
	"github.com/lobehub/lobe-mygo/pkg/display"
	"github.com/lobehub/lobe-mygo/pkg/lucide"
	"github.com/lobehub/lobe-mygo/pkg/nav"
	"github.com/lobehub/lobe-mygo/pkg/theme"
)

// tasksPage is two levels: the task list, and one task's detail.
func (a *app) tasksPage(c *ui.Context) {
	root := ui.Column(c.Key("tasks")).Grow(1).Basis(0).MinWidth(0).MinHeight(0).Gap(12)
	s := ui.Local(root, "tasks", newTaskState)
	a.pollTasks(s, false)
	if s.selected == "" {
		c.After(max(50*time.Millisecond, time.Until(s.nextPoll)))
	}
	root.Children(func() {
		if s.selected != "" {
			a.taskDetailPage(c, s)
			return
		}
		a.taskListPage(c, s)
	})
}

func (a *app) taskListPage(c *ui.Context, s *taskState) {
	a.pageHeader(c, "任务", "父 Agent 对话、子 Agent 生命周期和产物", nil)
	if !s.loaded {
		if s.error != "" {
			stateError(c, "没能读取任务", s.error, func() { a.pollTasks(s, true) })
		} else {
			stateLoading(c, "正在读取任务")
		}
		return
	}
	if s.error != "" {
		inlineError(c, "没能读取任务", s.error)
	}
	if len(s.missions) == 0 && len(s.archived) == 0 {
		stateEmpty(c, lucide.ListTodo(), "还没有任务", "父 Agent 用 weaver mission create 创建主任务后，会出现在这里。", "", nil)
		return
	}
	counts := taskFilterCounts(s.missions, s.archived)
	names := []string{"全部", "进行中", "需关注", "已完成", "已归档"}
	items := make([]nav.TabItem, len(names))
	for i, name := range names {
		items[i] = nav.TabItem{Label: fmt.Sprintf("%s %d", name, counts[i])}
	}
	ui.Row(c).Children(func() {
		nav.Tabs(c, &s.filter, nav.TabsProps{Size: theme.Small, Items: items}, nil)
	})
	rows := taskFilterRows(s.filter, s.missions, s.archived)
	if len(rows) == 0 {
		stateEmpty(c, lucide.ListTodo(), "这个筛选下没有任务", "换一个筛选，或回到「全部」。", "", nil)
		return
	}
	w, _ := c.Size()
	narrow := w < 900
	if !narrow {
		a.taskListHead(c)
	}
	ui.Scroll(c.Key("task-list")).Grow(1).Basis(0).MinHeight(0).TrackScroll(&s.listScroll).Gap(6).Children(func() {
		groupNames := []string{"今天", "3 天内", "更早"}
		for i, group := range taskGroups(rows, time.Now()) {
			if len(group) == 0 {
				continue
			}
			display.Text(c, groupNames[i], display.TextProps{Type: display.TextSecondary, FontSize: 12}).Padding(6, 6, 2)
			for _, m := range group {
				a.taskMissionRow(c, s, m, narrow)
			}
		}
	})
}

const (
	taskColStatus   = 76
	taskColProgress = 128
	taskColArtifact = 60
	taskColTime     = 52
)

func (a *app) taskListHead(c *ui.Context) {
	tk := theme.TokensOf(c)
	label := func(text string, width float32) {
		t := ui.Text(c, text).FontSize(12).TextColor(tk.TextTertiary).SingleLine()
		if width > 0 {
			t.Width(width).Shrink(0)
		} else {
			t.Grow(1).Basis(0).MinWidth(0)
		}
	}
	ui.Row(c).Padding(0, 12).Gap(12).AlignItems(ui.Center).Children(func() {
		ui.Box(c).Width(32).Shrink(0)
		ui.Row(c).Grow(1.4).Basis(0).MinWidth(0).Children(func() { ui.Text(c, "任务").FontSize(12).TextColor(tk.TextTertiary) })
		label("状态", taskColStatus)
		label("进度", taskColProgress)
		ui.Row(c).Grow(1).Basis(0).MinWidth(0).Children(func() { ui.Text(c, "当前动态").FontSize(12).TextColor(tk.TextTertiary) })
		label("产物", taskColArtifact)
		ui.Text(c, "活动").FontSize(12).TextColor(tk.TextTertiary).Width(taskColTime).Shrink(0).TextAlign(ui.End)
	})
}

func taskStatusTag(c *ui.Context, m taskMission) {
	color := display.TagColor("")
	switch {
	case taskNeedsAttention(m):
		color = display.TagWarning
	case taskMissionDone(m):
		color = display.TagSuccess
	case m.State == "running" || m.State == "settled":
		color = display.TagProcessing
	}
	display.Tag(c, taskMissionLabel(m.State), display.TagProps{Color: color, Size: theme.Small})
}

func taskProgressView(c *ui.Context, m taskMission) {
	tk := theme.TokensOf(c)
	progress, cancelled := taskProgress(m)
	ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
		ui.Text(c, progress).FontSize(13).TextColor(tk.Text).SingleLine().FontFeatures("tnum")
		if cancelled != "" {
			ui.Text(c, cancelled).FontSize(12).TextColor(tk.TextTertiary).SingleLine()
		}
	})
}

// taskActivityView shows what the task is doing now. Attention gets the warning
// color and an icon, so it never rests on color alone.
func taskActivityView(c *ui.Context, m taskMission, lines int) {
	tk := theme.TokensOf(c)
	if m.Activity == "" {
		return
	}
	attention := taskNeedsAttention(m)
	color := tk.TextSecondary
	if attention {
		color = tk.Warning
	}
	ui.Row(c).Gap(6).AlignItems(ui.Start).MinWidth(0).Children(func() {
		if attention {
			display.Icon(c, lucide.TriangleAlert(), display.IconProps{Size: display.IconSmall}).TextColor(color).Margin(2, 0, 0, 0).Shrink(0)
		}
		ui.Text(c, m.Activity).FontSize(13).TextColor(color).MaxLines(lines).Grow(1).Basis(0).MinWidth(0)
	})
}

func (a *app) taskMissionRow(c *ui.Context, s *taskState, m taskMission, narrow bool) {
	tk := theme.TokensOf(c)
	restore := func() {
		a.button(c, "tasks:archive:"+m.ID, "恢复", func() {
			a.taskArchive(s, m.ID, false)
			if len(s.archived) <= 1 {
				s.filter = taskFilterAll
			}
		})
	}
	artifacts := fmt.Sprintf("产物 %d", m.Artifacts)
	at := taskActivity(m.LastActivityAt, time.Now())
	title := func(lines int) {
		ui.Column(c).Grow(1.4).Basis(0).MinWidth(0).Gap(3).Children(func() {
			ui.Text(c, m.Title).FontSize(14).FontWeight(500).TextColor(tk.Text).MaxLines(lines)
			ui.Text(c, taskMissionSubtitle(m)).FontSize(12).TextColor(tk.TextTertiary).SingleLine()
		})
	}
	ui.Column(c.Key(m.ID)).Gap(4).Children(func() {
		if narrow {
			card := ui.Column(c).Padding(12).Gap(8).Radius(12).Border(1, tk.BorderSecondary).Cursor(ui.CursorPointer)
			card.Children(func() {
				ui.Row(c).Gap(12).AlignItems(ui.Center).Children(func() {
					taskAvatar(c, m.ID, 32)
					title(2)
					taskStatusTag(c, m)
				})
				ui.Column(c).PaddingStart(44).Gap(6).Children(func() {
					ui.Row(c).Gap(12).AlignItems(ui.Center).Wrap().Children(func() {
						taskProgressView(c, m)
						ui.Text(c, artifacts).FontSize(12).TextColor(tk.TextTertiary).SingleLine()
						ui.Text(c, at).FontSize(12).TextColor(tk.TextTertiary).SingleLine()
					})
					taskActivityView(c, m, 2)
				})
			})
			if card.Clicked() {
				a.selectTask(s, m.ID)
			}
		} else {
			ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
				row := ui.Row(c).Grow(1).Basis(0).MinWidth(0).Padding(10, 12).Gap(12).AlignItems(ui.Center).Radius(10).Cursor(ui.CursorPointer)
				row.Children(func() {
					taskAvatar(c, m.ID, 32)
					title(1)
					ui.Row(c).Width(taskColStatus).Shrink(0).Children(func() { taskStatusTag(c, m) })
					ui.Row(c).Width(taskColProgress).Shrink(0).Children(func() { taskProgressView(c, m) })
					ui.Column(c).Grow(1).Basis(0).MinWidth(0).Children(func() { taskActivityView(c, m, 1) })
					ui.Text(c, artifacts).FontSize(12).TextColor(tk.TextTertiary).SingleLine().Width(taskColArtifact).Shrink(0)
					ui.Text(c, at).FontSize(12).TextColor(tk.TextTertiary).SingleLine().Width(taskColTime).Shrink(0).TextAlign(ui.End)
				})
				if row.Clicked() {
					a.selectTask(s, m.ID)
				}
				if s.filter == taskFilterArchived {
					restore()
				}
			})
		}
		if narrow && s.filter == taskFilterArchived {
			ui.Row(c).Children(restore)
		}
		fieldError(c, a.errors["tasks:archive:"+m.ID])
	})
}
