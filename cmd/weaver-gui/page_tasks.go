package main

import (
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/egoist/mygo/ui"
	"github.com/lobehub/lobe-mygo/pkg/action"
	"github.com/lobehub/lobe-mygo/pkg/display"
	"github.com/lobehub/lobe-mygo/pkg/lucide"
	"github.com/lobehub/lobe-mygo/pkg/markdown"
	"github.com/lobehub/lobe-mygo/pkg/nav"
	"github.com/lobehub/lobe-mygo/pkg/theme"
)

func (a *app) tasksPage(c *ui.Context) {
	w, h := c.Size()
	a.pageHeader(c, "任务", "父 Agent 对话、子 Agent 生命周期和产物", nil)
	root := ui.Column(c.Key("tasks")).Height(max(340, h-210)).MinWidth(0).Gap(8)
	s := ui.Local(root, "tasks", newTaskState)
	a.pollTasks(s, false)
	c.After(max(50*time.Millisecond, time.Until(s.nextPoll)))
	root.Children(func() {
		if s.error != "" {
			inlineError(c, "没能读取任务", s.error)
		}
		ui.Row(c).Grow(1).Basis(0).MinHeight(0).AlignItems(ui.Stretch).Gap(12).Children(func() {
			if w < 900 {
				switch s.pane {
				case "chat":
					a.taskChat(c, s, true)
				case "side":
					ui.Column(c).Grow(1).MinWidth(0).Children(func() {
						if ui.Button(c, "返回对话").Clicked() {
							s.pane = "chat"
						}
						a.taskSide(c, s)
					})
				default:
					a.taskList(c, s)
				}
			} else {
				ui.Column(c).Width(240).Shrink(0).Children(func() { a.taskList(c, s) })
				a.taskChat(c, s, false)
				if w >= 1100 {
					ui.Column(c).Width(280).Shrink(0).Children(func() { a.taskSide(c, s) })
				}
			}
		})
	})
	if w >= 900 && w < 1100 {
		// A right anchored overlay keeps the conversation in place beneath it.
		ui.DialogBase(c, &s.drawer, func(backdrop, panel ui.Element) {
			backdrop.Background(ui.RGBA(0, 0, 0, 0.18)).AlignItems(ui.End).Justify(ui.Start)
			panel.Width(350).Height(h).Padding(16).Background(theme.TokensOf(c).BgContainer).Children(func() {
				if ui.Button(c, "关闭侧栏").Clicked() {
					s.drawer = false
				}
				a.taskSide(c, s)
			})
		})
	}
}
func (a *app) taskList(c *ui.Context, s *taskState) {
	ui.Scroll(c.Key("task-list")).Grow(1).Basis(0).MinHeight(0).Gap(10).Children(func() {
		groups := taskGroups(s.missions, time.Now())
		names := []string{"今天", "3 天内", "更早"}
		for i, rows := range groups {
			if len(rows) == 0 {
				continue
			}
			display.Text(c, names[i], display.TextProps{Type: display.TextSecondary, FontSize: 12}).Padding(6)
			for _, m := range rows {
				a.taskMissionRow(c, s, m, false)
			}
		}
		if len(s.missions) == 0 {
			stateEmpty(c, lucide.ListTodo(), "还没有任务", "父 Agent 用 weaver mission create 创建主任务后，会出现在这里。", "", nil)
		}
		if len(s.missions) > 0 || len(s.archived) > 0 {
			ui.Row(c).Padding(0, 6).Children(func() {
				archiveButton := action.Button(c, fmt.Sprintf("已归档（%d）", len(s.archived)), action.ButtonProps{Variant: action.Text, Size: theme.Small})
				if archiveButton.Clicked() {
					s.archiveOpen = !s.archiveOpen
				}
			})
		}
		if s.archiveOpen {
			for _, m := range s.archived {
				a.taskMissionRow(c, s, m, true)
			}
		}
	})
}
func (a *app) taskMissionRow(c *ui.Context, s *taskState, m taskMission, archived bool) {
	tk := theme.TokensOf(c)
	ui.Column(c.Key(m.ID)).Gap(4).Children(func() {
		row := ui.Row(c).Cursor(ui.CursorPointer).Padding(10).Radius(8).Gap(9).AlignItems(ui.Start)
		if s.selected == m.ID {
			row.Background(tk.FillSecondary)
		}
		row.Children(func() {
			label, bg := "?", ui.Hex("#929292")
			if m.Owner != nil {
				switch m.Owner.Engine {
				case "claude":
					label, bg = "Cl", ui.Hex("#ce744f")
				case "codex":
					label, bg = "Cx", ui.Hex("#151515")
				default:
					if m.Owner.Engine != "" {
						label = strings.ToUpper(string([]rune(m.Owner.Engine)[:1]))
					}
				}
			}
			// AvatarText uppercases names, so draw the engine's exact mark over the
			// shared Avatar surface to preserve the Cl / Cx branding.
			display.Avatar(c, "", display.AvatarProps{Size: 32, Background: bg, Fallback: display.AvatarText}).Children(func() { ui.Text(c, label).FontSize(14).TextColor(ui.Hex("#ffffff")) })
			ui.Column(c).Grow(1).Basis(0).MinWidth(0).Gap(4).Children(func() {
				ui.Text(c, m.Title).MaxLines(2)
				display.Text(c, fmt.Sprintf("%s · %d / %d 已采纳", taskMissionLabel(m.State), m.Counts["accepted"], m.Total), display.TextProps{FontSize: 11, Type: display.TextSecondary})
				display.Text(c, taskActivity(m.LastActivityAt, time.Now()), display.TextProps{FontSize: 11, Type: display.TextSecondary})
			})
		})
		if row.Clicked() {
			a.selectTask(s, m.ID)
		}
		if archived {
			ui.Row(c).Children(func() {
				a.button(c, "tasks:archive:"+m.ID, "恢复", func() { a.taskArchive(s, m.ID, false) })
			})
			fieldError(c, a.errors["tasks:archive:"+m.ID])
		}
	})
}
func (a *app) taskChat(c *ui.Context, s *taskState, narrow bool) {
	tk := theme.TokensOf(c)
	ui.Column(c.Key("chat:" + s.selected)).Grow(1).Basis(0).MinWidth(0).Gap(10).Children(func() {
		if s.selected == "" {
			stateEmpty(c, lucide.MessageSquare(), "选择一个任务，查看父 Agent 对话", "左边的任务列表按最近活动排序；选中后这里显示父 Agent 的对话和子 Agent 卡片。", "", nil)
			return
		}
		ui.Row(c).Gap(8).Wrap().Children(func() {
			if narrow && ui.Button(c, "返回列表").Clicked() {
				s.pane = "list"
			}
			display.Text(c, s.detail.Title, display.TextProps{Strong: true}).Grow(1).Basis(0).MinWidth(0).MaxLines(2)
			w, _ := c.Size()
			if w < 1100 && ui.Button(c, "侧栏").Clicked() {
				if narrow {
					s.pane = "side"
				} else {
					s.drawer = true
				}
			}
			if !s.detail.Archived {
				a.button(c, "tasks:archive:"+s.selected, "归档", func() { a.taskArchive(s, s.selected, true) })
			}
		})
		fieldError(c, a.errors["tasks:archive:"+s.selected])
		if s.renderedNext != s.transcript.Next {
			if s.scroll.Y >= s.scroll.MaxY-4 {
				s.scroll.Y = math.MaxFloat32
			}
			s.renderedNext = s.transcript.Next
		}
		ui.Scroll(c.Key("transcript")).Grow(1).Basis(0).MinHeight(0).TrackScroll(&s.scroll).Gap(12).Padding(4).Children(func() {
			if s.transcriptError != "" {
				stateError(c, "没能读取父 Agent 对话", s.transcriptError, nil)
				if strings.Contains(s.transcriptError, "找不到父 Agent") {
					path := s.transcript.Path
					if path == "" && s.detail.Owner != nil {
						o := s.detail.Owner
						if o.Engine == "claude" {
							path = "~/.claude/projects/…/" + o.Session + ".jsonl"
						} else {
							path = "~/.codex/sessions/…/rollout-…-" + o.Session + ".jsonl"
						}
					}
					ui.Text(c, path).Font("monospace").FontSize(11).TextColor(tk.TextTertiary).AlignSelf(ui.Center)
				}
			}
			if s.transcriptError == "" && s.detail.ID == "" {
				if s.error == "" {
					stateLoading(c, "正在读取父 Agent 对话")
				}
				return
			}
			items := s.transcript.Items
			if s.transcriptError != "" {
				items = nil
			}
			cards := taskPlanCards(items, s.events, s.detail.Packages)
			for i, item := range items {
				if item.Role != "user" && item.Role != "assistant" && item.Role != "tool" {
					continue
				}
				ui.Column(c.Key(fmt.Sprintf("item:%d", i))).Gap(6).Children(func() {
					switch item.Role {
					case "user":
						display.Text(c, "你 · "+taskTime(item.At), display.TextProps{Type: display.TextSecondary, FontSize: 11})
						ui.Text(c, item.Text).Padding(12).Radius(10).Background(tk.FillSecondary)
					case "assistant":
						display.Text(c, "父 Agent · "+taskTime(item.At), display.TextProps{Type: display.TextSecondary, FontSize: 11})
						markdown.Markdown(c, item.Text, markdown.MarkdownProps{Variant: markdown.Chat})
					case "tool":
						key := fmt.Sprintf("tool:%d", i)
						label := item.Tool
						if item.Weaver != nil {
							label = "weaver " + item.Weaver.Command
						}
						triangle := "▸ "
						if s.expanded[key] {
							triangle = "▾ "
						}
						label = triangle + label + " · " + taskTime(item.At)
						color := tk.TextTertiary
						if item.Weaver != nil {
							color = tk.Text
						}
						if ui.Text(c, label).Font("monospace").FontSize(11).TextColor(color).MaxLines(1).Cursor(ui.CursorPointer).Clicked() {
							s.expanded[key] = !s.expanded[key]
						}
						if s.expanded[key] {
							ui.Text(c, item.Text).Font("monospace").FontSize(12)
						}
						if verdict := taskVerdict(item, s.events, s.detail.Packages); verdict != "" {
							display.Tag(c, verdict, display.TagProps{})
						}
					}
					for _, p := range cards[i] {
						a.taskCard(c, s, p)
					}
				})
			}
			if len(cards[-1]) > 0 {
				display.Text(c, "子 Agent", display.TextProps{Strong: true})
				for _, p := range cards[-1] {
					a.taskCard(c, s, p)
				}
			}
		})
	})
}
func (a *app) taskCard(c *ui.Context, s *taskState, p taskPackage) {
	tk := theme.TokensOf(c)
	card := ui.Column(c.Key("card:"+p.ID)).Cursor(ui.CursorPointer).Border(1, tk.BorderSecondary).Radius(8).Padding(10).Gap(4)
	card.Children(func() {
		ui.Row(c).Gap(8).Wrap().Children(func() {
			ui.Text(c, p.Key).Font("monospace")
			display.Tag(c, taskPackageLabel(p.State), display.TagProps{})
		})
		start, end, worker := p.CreatedAt, int64(0), p.Worker
		if p.Current != nil {
			start, end = p.Current.CreatedAt, p.Current.FinishedAt
			if p.Current.Worker != "" {
				worker = p.Current.Worker
			}
		}
		display.Text(c, fmt.Sprintf("%s · %s → %s", worker, taskTime(start), taskTime(end)), display.TextProps{FontSize: 11, Type: display.TextSecondary})
	})
	if card.Clicked() {
		s.selectedPackage = p.ID
		s.tab = "agents"
		w, _ := c.Size()
		if w < 900 {
			s.pane = "side"
		} else if w < 1100 {
			s.drawer = true
		}
	}
}
func (a *app) taskSide(c *ui.Context, s *taskState) {
	if s.selected == "" {
		return
	}
	ui.Column(c.Key("side:" + s.selected)).Grow(1).Basis(0).MinHeight(0).MinWidth(0).Gap(10).Children(func() {
		tab := 0
		if s.tab == "artifacts" {
			tab = 1
		}
		count := 0
		for _, g := range s.artifacts {
			count += len(g.Items)
		}
		nav.Tabs(c, &tab, nav.TabsProps{Size: theme.Small, Items: []nav.TabItem{{Label: fmt.Sprintf("子 Agent %d", len(s.detail.Packages))}, {Label: fmt.Sprintf("产物 %d", count)}}}, nil)
		s.tab = "agents"
		if tab == 1 {
			s.tab = "artifacts"
		}
		ui.Scroll(c.Key(s.tab)).Grow(1).Basis(0).MinHeight(0).Gap(10).Children(func() {
			if tab == 1 {
				a.taskArtifacts(c, s)
			} else {
				a.taskLifecycle(c, s)
			}
		})
	})
}
func (a *app) taskLifecycle(c *ui.Context, s *taskState) {
	if s.selectedPackage == "" && len(s.detail.Packages) > 0 {
		s.selectedPackage = s.detail.Packages[0].ID
	}
	tk := theme.TokensOf(c)
	for _, p := range s.detail.Packages {
		row := ui.Row(c.Key("package:" + p.ID)).Padding(8).Radius(6).Gap(8).AlignItems(ui.Center).Cursor(ui.CursorPointer)
		if s.selectedPackage == p.ID {
			row.Background(tk.FillSecondary)
		}
		row.Children(func() {
			ui.Text(c, p.Key).Font("monospace").Grow(1).Basis(0).MinWidth(0)
			display.Tag(c, taskPackageLabel(p.State), display.TagProps{})
		})
		if row.Clicked() {
			s.selectedPackage = p.ID
		}
	}
	for _, p := range s.detail.Packages {
		if p.ID != s.selectedPackage {
			continue
		}
		display.Text(c, p.Key, display.TextProps{Strong: true})
		lastAttempt := -1
		for _, e := range s.events {
			if e.Package != p.ID && (e.Key == "" || e.Key != p.Key) {
				continue
			}
			label := ""
			switch e.Kind {
			case "launching":
				label = "启动中"
			case "handed":
				label = "已交给引擎"
			case "running":
				label = "引擎开始执行"
			case "result":
				label = "有结果"
			case "accepted", "returned", "failed", "cancelled":
				label = taskPackageLabel(e.Kind)
			}
			if label == "" {
				continue
			}
			if e.Attempt != lastAttempt {
				lastAttempt = e.Attempt
				display.Text(c, fmt.Sprintf("第 %d 次尝试", e.Attempt), display.TextProps{Strong: true, FontSize: 12}).Padding(8, 0, 0)
			}
			display.Text(c, taskTime(e.At)+" · "+label, display.TextProps{FontSize: 12})
			if e.Message != "" {
				display.Text(c, e.Message, display.TextProps{Type: display.TextSecondary, FontSize: 11})
			}
		}
		taskExpandMarkdown(c, s, "instruction:"+p.ID, "指令全文", p.Instruction)
		for _, attempt := range p.Attempts {
			if attempt.Result != "" {
				taskExpandMarkdown(c, s, fmt.Sprintf("result:%s:%d", p.ID, attempt.N), fmt.Sprintf("第 %d 次结果全文", attempt.N), attempt.Result)
			}
		}
		if len(p.Attempts) == 0 && p.Current != nil {
			taskExpandMarkdown(c, s, "result:"+p.ID, "结果全文", p.Current.Result)
		}
	}
}
func taskExpandMarkdown(c *ui.Context, s *taskState, key, label, text string) {
	tk := theme.TokensOf(c)
	triangle := "▸ "
	if s.expanded[key] {
		triangle = "▾ "
	}
	// The disclosure matches the transcript's tool rows: a quiet, left aligned
	// line that folds the long text away, without a button surface.
	if ui.Text(c, triangle+label).FontSize(11).TextColor(tk.TextTertiary).MaxLines(1).
		Cursor(ui.CursorPointer).AlignSelf(ui.Start).Clicked() {
		s.expanded[key] = !s.expanded[key]
	}
	if s.expanded[key] {
		markdown.Markdown(c, text, markdown.MarkdownProps{Variant: markdown.Chat})
	}
}
func (a *app) taskArtifacts(c *ui.Context, s *taskState) {
	if len(s.artifacts) == 0 {
		display.Text(c, "还没有产物", display.TextProps{Strong: true})
		display.Text(c, "分享时加 --mission <主任务 ID>，或用 weaver artifact add 登记", display.TextProps{Type: display.TextSecondary, FontSize: 12})
		return
	}
	for _, folder := range []struct{ kind, label string }{{"design", "设计"}, {"report", "验收"}, {"evidence", "证据"}, {"doc", "其他"}} {
		display.Text(c, "▸ "+folder.label, display.TextProps{Strong: true})
		for _, group := range s.artifacts {
			items := []taskArtifact{}
			for _, item := range group.Items {
				if item.Kind == folder.kind || folder.kind == "doc" && item.Kind != "design" && item.Kind != "report" && item.Kind != "evidence" {
					items = append(items, item)
				}
			}
			if len(items) == 0 {
				continue
			}
			key := "versions:" + folder.kind + ":" + group.GroupKey
			ui.Column(c.Key(key)).Padding(6).Gap(6).Children(func() {
				a.taskArtifactRow(c, s, items[0])
				if len(items) > 1 {
					ui.Row(c).Children(func() {
						if ui.Button(c, fmt.Sprintf("%d 个版本", len(items))).Clicked() {
							s.expanded[key] = !s.expanded[key]
						}
					})
					if s.expanded[key] {
						for _, old := range items[1:] {
							a.taskArtifactRow(c, s, old)
						}
					}
				}
			})
		}
	}
}
func (a *app) taskArtifactRow(c *ui.Context, s *taskState, item taskArtifact) {
	ui.Column(c.Key(item.ID)).Gap(4).Children(func() {
		display.Text(c, item.Title, display.TextProps{FontSize: 12, Strong: true})
		if summary := taskSummary(item); summary != "" {
			display.Text(c, summary, display.TextProps{FontSize: 11, Type: display.TextSecondary})
		}
		ui.Row(c).Children(func() {
			a.button(c, "artifact:open:"+item.ID, "打开", func() {
				a.action("artifact:open:"+item.ID, func() (string, error) {
					target, err := taskArtifactTarget(item)
					if err != nil {
						return "", err
					}
					return command(a.ctx, "xdg-open", target)
				}, nil)
			})
		})
		fieldError(c, a.errors["artifact:open:"+item.ID])
	})
}
