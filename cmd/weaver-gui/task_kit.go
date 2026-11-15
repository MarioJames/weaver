package main

import (
	"fmt"
	"unicode/utf8"

	"github.com/egoist/mygo/ui"
	"github.com/lobehub/lobe-mygo/pkg/display"
	"github.com/lobehub/lobe-mygo/pkg/feedback"
	"github.com/lobehub/lobe-mygo/pkg/layout"
	"github.com/lobehub/lobe-mygo/pkg/lucide"
	"github.com/lobehub/lobe-mygo/pkg/markdown"
	"github.com/lobehub/lobe-mygo/pkg/theme"
)

const (
	taskRoleOwner    = "父 Agent"
	taskRoleWorker   = "子 Agent"
	taskRoleDebater  = "对谈人"
	taskRoleReviewer = "外部审查"
)

func taskRoleTag(c *ui.Context, role string) {
	color := display.TagGray
	switch role {
	case taskRoleWorker:
		color = display.TagGeekblue
	case taskRoleDebater:
		color = display.TagPurple
	case taskRoleReviewer:
		color = display.TagGold
	}
	display.Tag(c, role, display.TagProps{Color: color, Size: theme.Small})
}

func taskConvorelMark(c *ui.Context, size float32) {
	tk := theme.TokensOf(c)
	// BgSolid reverses in dark mode; the placeholder stays dark in both themes.
	ui.Column(c).Size(size, size).Shrink(0).Radius(size / 4).Background(ui.RGB(0, 0, 0)).Center().Children(func() {
		ui.Text(c, "Cv").FontSize(size * 0.4).FontWeight(700).TextColor(tk.TextLightSolid)
	})
}

// taskMessageHeader is shared by speech and the full-text drawer. Avatar may
// render a geometric portrait or the Convorel mark. Continuation keeps the
// avatar column aligned while omitting repeated identity information.
type taskMessageHeader struct {
	Avatar                 func()
	Name, Role, Meta, Time string
	Continuation           bool
}

func taskMessage(c *ui.Context, h taskMessageHeader, body func()) {
	ui.Row(c).FillWidth().Gap(12).AlignItems(ui.Start).Children(func() {
		ui.Column(c).Width(32).Shrink(0).AlignItems(ui.Center).Children(func() {
			if !h.Continuation && h.Avatar != nil {
				h.Avatar()
			}
		})
		ui.Column(c).Grow(1).Basis(0).MinWidth(0).Gap(6).Children(func() {
			if !h.Continuation {
				taskIdentity(c, h)
			}
			if body != nil {
				body()
			}
		})
	})
}

func taskIdentity(c *ui.Context, h taskMessageHeader) {
	tk := theme.TokensOf(c)
	ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
		ui.Text(c, h.Name).FontSize(13).FontWeight(600).TextColor(tk.Text).SingleLine().Shrink(0)
		if h.Role != "" {
			taskRoleTag(c, h.Role)
		}
		if h.Meta != "" {
			ui.Text(c, h.Meta).FontSize(12).TextColor(tk.TextTertiary).SingleLine().Shrink(1).MinWidth(0)
		}
		if h.Time != "" {
			ui.Text(c, h.Time).FontSize(12).TextColor(tk.TextQuaternary).SingleLine().Shrink(0)
		}
	})
}

func taskBubble(c *ui.Context, body func()) {
	tk := theme.TokensOf(c)
	ui.Column(c).AlignSelf(ui.Start).MaxWidth(680).MinWidth(0).Padding(10, 14).Radius(4, 14, 14, 14).Background(tk.FillTertiary).Gap(8).Children(body)
}

func taskText(c *ui.Context, text string) ui.Element {
	return ui.Text(c, text).FontSize(14).LineHeight(1.6).TextColor(theme.TokensOf(c).Text)
}

func taskUser(c *ui.Context, at, text string) { taskUserMessage(c, at, text, 0, 0, false) }

// taskUserMessage clips the message to maxLines (0 for no limit). clipped says
// text is only the head of a body of chars characters. It reports a click on 查看全文.
func taskUserMessage(c *ui.Context, at, text string, maxLines, chars int, clipped bool) (more bool) {
	tk := theme.TokensOf(c)
	ui.Column(c).FillWidth().AlignItems(ui.End).Gap(6).Children(func() {
		ui.Text(c, "你 · "+at).FontSize(12).TextColor(tk.TextQuaternary)
		ui.Column(c).MaxWidth(560).MinWidth(0).Padding(10, 14).Radius(14, 4, 14, 14).Background(tk.FillSecondary).Gap(8).Children(func() {
			if maxLines > 0 {
				more = taskPreviewChars(c, text, maxLines, chars, clipped)
			} else {
				taskText(c, text)
			}
		})
	})
	return
}

func taskMore(c *ui.Context, label string) bool {
	tk := theme.TokensOf(c)
	row := ui.Row(c).Gap(6).AlignItems(ui.Center).Cursor(ui.CursorPointer)
	row.Children(func() {
		display.Icon(c, lucide.FileText(), display.IconProps{Size: display.IconSmall}).TextColor(tk.TextSecondary)
		ui.Text(c, label).FontSize(12).FontWeight(500).TextColor(tk.TextSecondary)
	})
	return row.Clicked()
}

type taskPreviewMeasure struct {
	text  string
	width float32
	lines int
}

// taskOverflows uses the last layout's actual text width, so soft wrapping and
// explicit newlines both count. No Elements or shaped layouts survive a frame.
func taskOverflows(c *ui.Context, t ui.Element, text string, font ui.Font, maxLines int) bool {
	t.MaxLines(maxLines)
	m := ui.Local(t, "task-preview", func() taskPreviewMeasure { return taskPreviewMeasure{} })
	width := t.LayoutBounds().W
	if width <= 0 {
		c.After(0)
		return false
	}
	if m.text != text || m.width != width {
		m.text, m.width = text, width
		m.lines = len(ui.ShapeText(text, font, width).Lines())
	}
	return m.lines > maxLines
}

func taskPreview(c *ui.Context, text string, maxLines int) bool {
	return taskPreviewChars(c, text, maxLines, 0, false)
}

// taskPreviewChars shows the entry for the full text when text is only the head
// of the body (clipped) or does not fit maxLines. The label counts the full
// body: chars, or text itself when chars is 0.
func taskPreviewChars(c *ui.Context, text string, maxLines, chars int, clipped bool) bool {
	t := taskText(c, text)
	if maxLines <= 0 || text == "" {
		return false
	}
	if chars <= 0 {
		chars = utf8.RuneCountInString(text)
	}
	over := taskOverflows(c, t, text, ui.Font{Size: 14, LineHeight: 1.6}, maxLines)
	if over || clipped {
		return taskMore(c, fmt.Sprintf("查看全文 · %d 字", chars))
	}
	return false
}

type taskOperation struct{ Tool, Summary string }

// The caller owns expanded, including when loading a different conversation.
func taskOperations(c *ui.Context, expanded *bool, label string, steps []taskOperation) {
	tk := theme.TokensOf(c)
	row := ui.Row(c).Gap(4).AlignItems(ui.Center).Cursor(ui.CursorPointer)
	row.Children(func() {
		icon := lucide.ChevronRight()
		if *expanded {
			icon = lucide.ChevronDown()
		}
		display.Icon(c, icon, display.IconProps{Size: display.IconSmall}).TextColor(tk.TextQuaternary)
		ui.Text(c, label).FontSize(12).TextColor(tk.TextTertiary)
	})
	if row.Clicked() {
		*expanded = !*expanded
	}
	if !*expanded {
		return
	}
	ui.Column(c).Gap(6).PaddingStart(20).Children(func() {
		for i, s := range steps {
			ui.Row(c.Key(i)).Gap(8).AlignItems(ui.Center).Children(func() {
				ui.Text(c, s.Tool).FontSize(12).TextColor(tk.TextQuaternary).SingleLine().Shrink(0)
				ui.Text(c, s.Summary).FontSize(12).TextColor(tk.TextSecondary).SingleLine().Grow(1).Basis(0).MinWidth(0)
			})
		}
	})
}

type taskTone int

const (
	taskToneNeutral taskTone = iota
	taskToneSuccess
	taskToneWarning
	taskToneError
)

func taskChip(c *ui.Context, icon *ui.SVG, tone taskTone) {
	tk := theme.TokensOf(c)
	bg, fg := tk.FillTertiary, tk.TextSecondary
	switch tone {
	case taskToneSuccess:
		bg, fg = tk.SuccessBg, tk.Success
	case taskToneWarning:
		bg, fg = tk.WarningBg, tk.Warning
	case taskToneError:
		bg, fg = tk.ErrorBg, tk.Error
	}
	ui.Column(c).Size(24, 24).Radius(12).Background(bg).Center().Children(func() {
		display.Icon(c, icon, display.IconProps{Size: display.IconSmall}).TextColor(fg)
	})
}

func taskProcessRow(c *ui.Context, icon *ui.SVG, tone taskTone, action, target, at string, detail func()) {
	taskProcessRowEnd(c, icon, tone, action, target, at, nil, detail)
}

// taskProcessRowEnd adds a trailing control after the time.
func taskProcessRowEnd(c *ui.Context, icon *ui.SVG, tone taskTone, action, target, at string, end, detail func()) {
	tk := theme.TokensOf(c)
	ui.Row(c).FillWidth().Gap(12).AlignItems(ui.Start).Children(func() {
		ui.Column(c).Width(32).Shrink(0).AlignItems(ui.Center).Children(func() { taskChip(c, icon, tone) })
		ui.Column(c).Grow(1).Basis(0).MinWidth(0).Gap(6).Padding(2, 0, 0).Children(func() {
			ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
				ui.Text(c, action).FontSize(13).TextColor(tk.TextSecondary).SingleLine()
				if target != "" {
					ui.Text(c, target).FontSize(13).FontWeight(600).TextColor(tk.Text).SingleLine()
				}
				ui.Box(c).Grow(1)
				ui.Text(c, at).FontSize(12).TextColor(tk.TextQuaternary).SingleLine().Shrink(0)
				if end != nil {
					end()
				}
			})
			if detail != nil {
				detail()
			}
		})
	})
}

func taskQuote(c *ui.Context, text string, lines int, more string) (clicked bool) {
	tk := theme.TokensOf(c)
	ui.Row(c).Gap(10).AlignItems(ui.Stretch).Children(func() {
		ui.Box(c).Width(2).Shrink(0).Radius(1).Background(tk.Border)
		ui.Column(c).Grow(1).Basis(0).MinWidth(0).Gap(4).Children(func() {
			t := ui.Text(c, text).FontSize(13).LineHeight(1.6).TextColor(tk.TextSecondary)
			if lines > 0 {
				t.MaxLines(lines)
			}
			if more != "" {
				clicked = taskMore(c, more)
			}
		})
	})
	return
}

// taskQuoteNote clips a quote to lines and offers 查看全文 when text is a head
// of a longer body (clipped) or does not fit. It reports a click on the entry.
func taskQuoteNote(c *ui.Context, text string, chars, lines int, clipped bool) (clicked bool) {
	tk := theme.TokensOf(c)
	ui.Row(c).Gap(10).AlignItems(ui.Stretch).Children(func() {
		ui.Box(c).Width(2).Shrink(0).Radius(1).Background(tk.Border)
		ui.Column(c).Grow(1).Basis(0).MinWidth(0).Gap(4).Children(func() {
			t := ui.Text(c, text).FontSize(13).LineHeight(1.6).TextColor(tk.TextSecondary)
			if chars <= 0 {
				chars = utf8.RuneCountInString(text)
			}
			over := taskOverflows(c, t, text, ui.Font{Size: 13, LineHeight: 1.6}, lines)
			if over || clipped {
				clicked = taskMore(c, fmt.Sprintf("查看全文 · %d 字", chars))
			}
		})
	})
	return
}

type taskRosterRow struct {
	Key, Seed, AvoidSeed, Name, Title, Worker, State, Cost string
}

// State words arrive already localized; unknown states retain their exact
// wording and use gray. This is the single color mapping for status dots.
func taskStateColor(c *ui.Context, state string) ui.Color {
	tk := theme.TokensOf(c)
	switch state {
	case "已采纳":
		return tk.Success
	case "运行中":
		return tk.Info
	case "待结论":
		return tk.Warning
	case "失败":
		return tk.Error
	default:
		return tk.TextQuaternary
	}
}

func taskStateDot(c *ui.Context, state string) {
	tk := theme.TokensOf(c)
	ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
		ui.Box(c).Size(6, 6).Shrink(0).Radius(3).Background(taskStateColor(c, state))
		ui.Text(c, state).FontSize(12).TextColor(tk.TextSecondary).SingleLine().Shrink(0)
	})
}

func taskRoster(c *ui.Context, icon *ui.SVG, title, summary, at string, rows []taskRosterRow) (selected string) {
	tk := theme.TokensOf(c)
	ui.Row(c).FillWidth().Gap(12).AlignItems(ui.Start).Children(func() {
		ui.Column(c).Width(32).Shrink(0).AlignItems(ui.Center).Children(func() { taskChip(c, icon, taskToneNeutral) })
		ui.Column(c).Grow(1).Basis(0).MinWidth(0).Border(1, tk.BorderSecondary).Radius(12).Clip().Children(func() {
			ui.Row(c).Padding(10, 14).Gap(8).AlignItems(ui.Center).Children(func() {
				ui.Text(c, title).FontSize(13).FontWeight(600).TextColor(tk.Text).SingleLine().Shrink(0)
				ui.Text(c, summary).FontSize(12).TextColor(tk.TextTertiary).SingleLine().Shrink(1).MinWidth(0)
				ui.Box(c).Grow(1)
				ui.Text(c, at).FontSize(12).TextColor(tk.TextQuaternary).SingleLine().Shrink(0)
			})
			for _, r := range rows {
				ui.Box(c).Height(1).AlignSelf(ui.Stretch).Background(tk.Split)
				row := ui.Row(c.Key(r.Key)).Padding(8, 14).Gap(10).AlignItems(ui.Center).Cursor(ui.CursorPointer)
				row.Children(func() {
					taskAvatarAvoid(c, r.Seed, r.AvoidSeed, 22)
					name := r.Name
					if name == "" {
						name = r.Key
					}
					ui.Text(c, name).FontSize(13).FontWeight(500).TextColor(tk.Text).SingleLine().Width(118).Shrink(0)
					ui.Text(c, r.Title).FontSize(13).TextColor(tk.TextSecondary).SingleLine().Grow(1).Basis(0).MinWidth(0)
					ui.Text(c, r.Worker).FontSize(12).TextColor(tk.TextTertiary).SingleLine().Width(142).Shrink(0)
					ui.Column(c).Width(64).Shrink(0).Children(func() { taskStateDot(c, r.State) })
					ui.Text(c, r.Cost).FontSize(12).TextColor(tk.TextQuaternary).SingleLine().Width(64).Shrink(0).TextAlign(ui.End).FontFeatures("tnum")
				})
				if row.Clicked() {
					selected = r.Key
				}
			}
		})
	})
	return
}

type taskProblemStep struct{ Time, Action, Detail string }
type taskProblemProps struct {
	Target, Status, Attempt, Time, Reason string
	Steps                                 []taskProblemStep
}

func taskProblem(c *ui.Context, p taskProblemProps) {
	tk := theme.TokensOf(c)
	ui.Row(c).FillWidth().Gap(12).AlignItems(ui.Start).Children(func() {
		ui.Column(c).Width(32).Shrink(0).AlignItems(ui.Center).Children(func() { taskChip(c, lucide.TriangleAlert(), taskToneError) })
		ui.Column(c).Grow(1).Basis(0).MinWidth(0).Border(1, tk.ErrorBorder).Background(tk.ErrorBg).Radius(12).Clip().Children(func() {
			ui.Column(c).Padding(10, 14, 12).Gap(6).Children(func() {
				ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
					ui.Text(c, p.Target).FontSize(13).FontWeight(600).TextColor(tk.Text).SingleLine()
					status := p.Status
					if status == "" {
						status = "失败"
					}
					ui.Text(c, status).FontSize(13).TextColor(tk.ErrorText).SingleLine()
					if p.Attempt != "" {
						display.Tag(c, p.Attempt, display.TagProps{Size: theme.Small, Variant: display.TagOutlined})
					}
					ui.Box(c).Grow(1)
					ui.Text(c, p.Time).FontSize(12).TextColor(tk.TextQuaternary).SingleLine().Shrink(0)
				})
				ui.Text(c, p.Reason).FontSize(13).LineHeight(1.6).TextColor(tk.Text).Selectable()
			})
			if len(p.Steps) > 0 {
				ui.Box(c).Height(1).AlignSelf(ui.Stretch).Background(tk.ErrorBorder)
				ui.Column(c).Padding(10, 14).Gap(8).Background(tk.BgContainer).Children(func() {
					for i, s := range p.Steps {
						ui.Row(c.Key(i)).Gap(8).AlignItems(ui.Start).Children(func() {
							ui.Text(c, s.Time).FontSize(12).TextColor(tk.TextQuaternary).SingleLine().Width(36).Shrink(0).FontFeatures("tnum").Padding(1, 0, 0)
							ui.Text(c, s.Action).FontSize(13).FontWeight(500).TextColor(tk.Text).SingleLine().Width(64).Shrink(0)
							ui.Text(c, s.Detail).FontSize(13).LineHeight(1.5).TextColor(tk.TextSecondary).Grow(1).Basis(0).MinWidth(0)
						})
					}
				})
			}
		})
	})
}

func taskDivider(c *ui.Context, label string, dashed bool) {
	layout.Divider(c, layout.DividerProps{Label: label, Dashed: dashed})
}

type taskDrawerProps struct {
	Title, Markdown string
	Header          *taskMessageHeader
	Loading         bool
	Error           string
}

func taskDrawer(c *ui.Context, open *bool, p taskDrawerProps) {
	width, _ := c.Size()
	feedback.Drawer(c, open, feedback.DrawerProps{Title: p.Title, Size: min(float32(520), width)}, func() {
		tk := theme.TokensOf(c)
		ui.Column(c).Gap(14).Children(func() {
			if p.Header != nil {
				ui.Row(c).Gap(10).AlignItems(ui.Center).Children(func() {
					if p.Header.Avatar != nil {
						p.Header.Avatar()
					}
					ui.Text(c, p.Header.Name).FontSize(14).FontWeight(600).TextColor(tk.Text).SingleLine().Shrink(0)
					if p.Header.Role != "" {
						taskRoleTag(c, p.Header.Role)
					}
					if p.Header.Meta != "" {
						ui.Text(c, p.Header.Meta).FontSize(12).TextColor(tk.TextTertiary).SingleLine().Shrink(1).MinWidth(0)
					}
					if p.Header.Time != "" {
						ui.Text(c, p.Header.Time).FontSize(12).TextColor(tk.TextQuaternary).SingleLine().Shrink(0)
					}
				})
				ui.Box(c).Height(1).AlignSelf(ui.Stretch).Background(tk.Split)
			}
			switch {
			case p.Loading:
				ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
					display.Icon(c, lucide.LoaderCircle(), display.IconProps{Size: display.IconSmall}).TextColor(tk.TextSecondary)
					ui.Text(c, "正在读取全文…").FontSize(13).TextColor(tk.TextSecondary)
				})
			case p.Error != "":
				ui.Column(c).Gap(6).Children(func() {
					ui.Text(c, "读取失败").FontSize(13).TextColor(tk.ErrorText)
					ui.Text(c, p.Error).FontSize(13).TextColor(tk.TextSecondary).Selectable()
				})
			default:
				markdown.Markdown(c, p.Markdown, markdown.MarkdownProps{Variant: markdown.Chat})
			}
		})
	})
}
