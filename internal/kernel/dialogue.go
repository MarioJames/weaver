package kernel

import (
	"fmt"
	"strings"
)

// A dialogue is a plan with a fixed shape: two candidates answer the same
// brief independently, then read each other and revise, for one or more
// exchanges. Every package is advisory. All but the last exchange are
// auto-accepted, so the owner is woken once, by the two final positions.

// DialogueInput starts a dialogue inside a mission.
type DialogueInput struct {
	Mission string   `json:"mission"`
	Name    string   `json:"name"`    // key prefix; several dialogues may live in one mission
	Brief   string   `json:"brief"`   // the question, its constraints and what a good answer settles
	Rounds  int      `json:"rounds"`  // exchanges after the proposals: 1 (default) to 3
	Workers []string `json:"workers"` // two candidates; default: one codex and one claude candidate
}

// DialogueResult reports the packages a dialogue created.
type DialogueResult struct {
	Mission  string     `json:"missionId"`
	Name     string     `json:"name"`
	Sides    []string   `json:"sides"`
	Final    []string   `json:"final"`
	Packages []*Package `json:"packages"`
	Cursor   int64      `json:"cursor"`
}

// DialogueTranscript is everything both sides wrote, in order.
type DialogueTranscript struct {
	Mission string          `json:"missionId"`
	Name    string          `json:"name"`
	State   string          `json:"state"` // running | concluded | needs_attention
	Hint    string          `json:"hint,omitempty"`
	Rounds  []DialogueRound `json:"rounds"`
}

// DialogueRound is one step: the proposals, or one exchange.
type DialogueRound struct {
	Round   int             `json:"round"`
	Kind    string          `json:"kind"` // proposal | exchange | final
	Entries []DialogueEntry `json:"entries"`
}

// DialogueEntry is what one side wrote in one round.
type DialogueEntry struct {
	Side    string `json:"side"`
	Package string `json:"package"`
	Worker  string `json:"worker,omitempty"`
	State   string `json:"state"`
	Result  string `json:"result,omitempty"`
	Failure string `json:"failure,omitempty"`
}

const (
	maxDialogueRounds = 3
	maxBrief          = 20000
)

var dialogueSides = []string{"a", "b"}

func dialogueKey(name string, round int, side string) string {
	return fmt.Sprintf("%s.r%d.%s", name, round, side)
}

// StartDialogue creates the packages of a dialogue and releases the two proposals.
func (k *Kernel) StartDialogue(key string, in DialogueInput) (*DialogueResult, error) {
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" {
		in.Name = "dialogue"
	}
	if !keyPattern.MatchString(in.Name) || len(in.Name) > 48 {
		return nil, errf("INVALID", "对谈名称 %q 不合法：只能用字母、数字、点、下划线和连字符，最长 48", in.Name)
	}
	brief := strings.TrimSpace(in.Brief)
	if brief == "" {
		return nil, errf("INVALID", "对谈需要一份说明：要定什么、有哪些约束、相关代码在哪")
	}
	if len(brief) > maxBrief {
		return nil, errf("INVALID", "对谈说明超过 %d 字节", maxBrief)
	}
	if in.Rounds == 0 {
		in.Rounds = 1
	}
	if in.Rounds < 1 || in.Rounds > maxDialogueRounds {
		return nil, errf("INVALID", "交换轮数只能是 1 到 %d", maxDialogueRounds)
	}
	if len(in.Workers) != 0 && len(in.Workers) != 2 {
		return nil, errf("INVALID", "对谈需要正好两个候选")
	}
	if len(in.Workers) == 2 && in.Workers[0] == in.Workers[1] {
		return nil, errf("INVALID", "对谈的两方不能是同一个候选")
	}
	out := &DialogueResult{}
	err := k.keyed(key, "dialogue.start", out, func(t *tx) error {
		// Each side is pinned to a candidate, or to an engine when none was named.
		type side struct{ worker, engine, label string }
		sides := []side{{engine: "codex", label: "codex"}, {engine: "claude", label: "claude"}}
		if len(in.Workers) == 2 {
			sides = []side{{worker: in.Workers[0], label: in.Workers[0]}, {worker: in.Workers[1], label: in.Workers[1]}}
		} else {
			for _, s := range sides {
				var n int
				if err := t.QueryRow(`SELECT COUNT(*) FROM workers WHERE engine=? AND enabled=1`, s.engine).Scan(&n); err != nil {
					return err
				}
				if n == 0 {
					return errf("INVALID", "对谈默认由 codex 和 claude 各出一方，但没有启用的 %s 候选；用 --workers 指定两个候选", s.engine)
				}
			}
		}
		last := in.Rounds + 1
		plan := PlanInput{Mission: in.Mission}
		for round := 1; round <= last; round++ {
			for i, s := range sides {
				p := PackageInput{
					Key: dialogueKey(in.Name, round, dialogueSides[i]), Worker: s.worker, Engine: s.engine,
					Advisory: true, AutoAccept: round < last,
				}
				if round == 1 {
					p.Title = fmt.Sprintf("对谈 %s · 方案 · %s", in.Name, s.label)
					p.Instruction = proposalInstruction(brief)
				} else {
					own, peer := dialogueKey(in.Name, round-1, dialogueSides[i]), dialogueKey(in.Name, round-1, dialogueSides[1-i])
					p.Title = fmt.Sprintf("对谈 %s · 第 %d 轮互评 · %s", in.Name, round-1, s.label)
					if round == last {
						p.Title = fmt.Sprintf("对谈 %s · 最终立场 · %s", in.Name, s.label)
					}
					p.Instruction = exchangeInstruction(brief, round, last, own, peer)
					p.DependsOn = []string{own, peer}
				}
				plan.Packages = append(plan.Packages, p)
			}
		}
		res := &PlanResult{}
		if err := t.createPlan(&plan, res); err != nil {
			return err
		}
		*out = DialogueResult{Mission: res.Mission, Name: in.Name, Packages: res.Packages, Cursor: res.Cursor,
			Sides: []string{sides[0].label, sides[1].label},
			Final: []string{dialogueKey(in.Name, last, "a"), dialogueKey(in.Name, last, "b")}}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

func proposalInstruction(brief string) string {
	return `This is round 1 of a design dialogue. Another engineer is answering the same brief independently, and afterwards you will review each other's proposal. Do not try to guess theirs: the dialogue is only worth its cost if the two designs are independent.

<brief>
` + brief + `
</brief>

Read as much of the codebase as the brief needs, then write your proposal with these sections:
1. Understanding: the problem in your own words and the constraints you found in the code, with paths.
2. Proposal: the design itself: components, data and interface changes, and the order of work, concrete enough for someone else to implement.
3. Alternatives: at least one real alternative and why you would not choose it.
4. Risks and open questions: what could go wrong, what you could not verify, and what the owner or the user has to decide.
5. Verification: how to tell the result is right: checks, tests, observable behaviour.
Aim for depth over breadth, within about 1,200 words.`
}

func exchangeInstruction(brief string, round, last int, own, peer string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "This is round %d of %d of a design dialogue. Two upstream results are attached below: %q is your own latest position, %q is the other engineer's. You do not remember writing yours; read both.\n\n<brief>\n%s\n</brief>\n\n", round, last, own, peer, brief)
	b.WriteString(`Do this, in this order:
1. Review the other position. Check its factual claims against the code rather than trusting or dismissing them. Say what it gets right that yours missed; what is wrong or risky, each with evidence (a path, a behaviour, or a concrete failure scenario); and what it leaves unspecified.
`)
	if round > 2 {
		b.WriteString("2. Answer the criticism the other side made of your position: concede what holds, and rebut the rest with evidence.\n")
	} else {
		b.WriteString("2. Reconsider your own position in the light of theirs: name what you now think you got wrong.\n")
	}
	if round < last {
		b.WriteString("3. Give your updated position in full. It replaces your previous one, so it must stand on its own.\nAgreeing is fine when the other side is right; do not defend a point only because it was yours, and do not concede one only to converge.")
		return b.String()
	}
	b.WriteString(`3. This is the last round. Close with exactly these three headed parts:
Agreed: the points both positions now share.
Still disagree: each remaining difference, your recommendation on it, and what evidence or decision would settle it.
Recommended plan: the design you would build now, complete and self-contained. The owner may read only this part.
Agreeing is fine when the other side is right; do not defend a point only because it was yours, and do not concede one only to converge.`)
	return b.String()
}

// Dialogue returns the transcript of a dialogue: every round, both sides, full text.
func (k *Kernel) Dialogue(mission, name string) (*DialogueTranscript, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		name = "dialogue"
	}
	packages, err := k.Packages(mission)
	if err != nil {
		return nil, err
	}
	out := &DialogueTranscript{Mission: mission, Name: name, Rounds: []DialogueRound{}}
	byKey := map[string]*Package{}
	for _, p := range packages {
		byKey[p.Key] = p
	}
	for round := 1; ; round++ {
		a, b := byKey[dialogueKey(name, round, "a")], byKey[dialogueKey(name, round, "b")]
		if a == nil || b == nil {
			break
		}
		r := DialogueRound{Round: round, Kind: "exchange"}
		if round == 1 {
			r.Kind = "proposal"
		}
		for i, p := range []*Package{a, b} {
			full, err := k.Package(p.ID)
			if err != nil {
				return nil, err
			}
			e := DialogueEntry{Side: dialogueSides[i], Package: p.Key, State: p.State}
			if full.Current != nil {
				e.Worker, e.Result = full.Current.Worker, full.Current.Result
				if p.State == StateFailed {
					e.Failure = full.Current.FailureMessage
				}
			}
			r.Entries = append(r.Entries, e)
		}
		out.Rounds = append(out.Rounds, r)
	}
	if len(out.Rounds) == 0 {
		return nil, errf("NOT_FOUND", "主任务 %s 里没有名为 %s 的对谈", mission, name)
	}
	out.Rounds[len(out.Rounds)-1].Kind = "final"
	out.State = "running"
	concluded, closed := true, true
	for _, r := range out.Rounds {
		for _, e := range r.Entries {
			if e.State == StateFailed || e.State == StateCanceled {
				out.State = "needs_attention"
				out.Hint = fmt.Sprintf("%s 是「%s」，下一轮在等它：重试它，或取消这场对谈", e.Package, stateLabel(e.State))
			}
		}
	}
	for _, e := range out.Rounds[len(out.Rounds)-1].Entries {
		if e.State != StateVerdict && e.State != StateAccepted {
			concluded = false
		}
		if e.State != StateAccepted {
			closed = false
		}
	}
	if concluded {
		out.State = "concluded"
		out.Hint = "两方的最终立场都已给出。写出最终方案后，对两个最终包给出采纳"
		if closed {
			out.Hint = "对谈已收尾：两个最终包都已采纳"
		}
	}
	return out, nil
}
