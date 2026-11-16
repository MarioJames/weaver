package kernel

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// TimelineInput describes a page or a stateless replacement of a client's suffix.
type TimelineInput struct {
	Mission string   `json:"mission"`
	Limit   int      `json:"limit,omitempty"`
	Before  string   `json:"before,omitempty"`
	From    string   `json:"from,omitempty"`
	Have    []string `json:"have,omitempty"`
	Wait    bool     `json:"wait,omitempty"`
}
type TimelineSession struct {
	Engine   string `json:"engine,omitempty"`
	State    string `json:"state"`
	SyncedTo int64  `json:"syncedTo,omitempty"`
}
type TimelinePackage struct {
	Key        string `json:"key"`
	Title      string `json:"title"`
	State      string `json:"state"`
	Waiting    string `json:"waiting,omitempty"`
	Attempt    int    `json:"attempt"`
	Worker     string `json:"worker,omitempty"`
	Engine     string `json:"engine,omitempty"`
	Model      string `json:"model,omitempty"`
	Effort     string `json:"effort,omitempty"`
	Account    string `json:"account,omitempty"`
	CreatedAt  int64  `json:"createdAt"`
	StartedAt  int64  `json:"startedAt,omitempty"`
	FinishedAt int64  `json:"finishedAt,omitempty"`
	Dialogue   bool   `json:"dialogue"`
}
type TimelineOp struct {
	At   int64  `json:"at"`
	Tool string `json:"tool"`
	Text string `json:"text"`
}
type TimelineStep struct {
	At     int64  `json:"at"`
	Action string `json:"action"`
	Text   string `json:"text"`
}
type TimelineSide struct {
	Side    string `json:"side"`
	Package string `json:"package"`
	Worker  string `json:"worker,omitempty"`
	Engine  string `json:"engine,omitempty"`
	Model   string `json:"model,omitempty"`
	Effort  string `json:"effort,omitempty"`
	Account string `json:"account,omitempty"`
}
type TimelineArtifact struct {
	ID    string `json:"id"`
	Kind  string `json:"kind"`
	Title string `json:"title"`
	Path  string `json:"path,omitempty"`
	URL   string `json:"url,omitempty"`
}
type TimelineEntry struct {
	Convorel  string            `json:"convorel,omitempty"`
	State     string            `json:"state,omitempty"`
	Ord       string            `json:"ord"`
	Hash      string            `json:"hash"`
	Kind      string            `json:"kind"`
	At        int64             `json:"at"`
	Text      string            `json:"text,omitempty"`
	Chars     int               `json:"chars,omitempty"`
	Ref       string            `json:"ref,omitempty"`
	Ops       []TimelineOp      `json:"ops,omitempty"`
	To        int64             `json:"to,omitempty"`
	Packages  []string          `json:"packages,omitempty"`
	Package   string            `json:"package,omitempty"`
	Attempt   int               `json:"attempt,omitempty"`
	Worker    string            `json:"worker,omitempty"`
	Engine    string            `json:"engine,omitempty"`
	Model     string            `json:"model,omitempty"`
	Note      string            `json:"note,omitempty"`
	NoteChars int               `json:"noteChars,omitempty"`
	NoteRef   string            `json:"noteRef,omitempty"`
	Problem   string            `json:"problem,omitempty"`
	Reason    string            `json:"reason,omitempty"`
	Steps     []TimelineStep    `json:"steps,omitempty"`
	Open      bool              `json:"open,omitempty"`
	Artifact  *TimelineArtifact `json:"artifact,omitempty"`
	Name      string            `json:"name,omitempty"`
	Rounds    int               `json:"rounds,omitempty"`
	Sides     []TimelineSide    `json:"sides,omitempty"`
	Side      string            `json:"side,omitempty"`
	Round     int               `json:"round,omitempty"`
	RoundKind string            `json:"roundKind,omitempty"`
}

// TimelineEarlier summarizes the conversation of the owner session before
// this mission's part; Mission and Title name the mission that part followed.
type TimelineEarlier struct {
	Mission string `json:"mission"`
	Title   string `json:"title"`
	Count   int    `json:"count"`
}
type TimelineResult struct {
	Mission  *Mission          `json:"mission"`
	Packages []TimelinePackage `json:"packages"`
	Session  TimelineSession   `json:"session"`
	Earlier  *TimelineEarlier  `json:"earlier,omitempty"`
	Entries  []TimelineEntry   `json:"entries"`
	Keep     int               `json:"keep"`
	HasMore  bool              `json:"hasMore"`
}
type MissionTextResult struct {
	Title string `json:"title"`
	Text  string `json:"text"`
}

func preview(s string, n int) (string, int) {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n]), len(r)
	}
	return s, len(r)
}
func timelineOrd(at int64, source int, seq any) string {
	return fmt.Sprintf("%013d:%d:%v", at, source, seq)
}
func seqOrd(n int64) string                    { return fmt.Sprintf("%020d", n) }
func (e *TimelineEntry) body(text, ref string) { e.Text, e.Chars = preview(text, 1200); e.Ref = ref }

// Timeline subscribes before reading, so a write cannot fall between comparison and wait.
func (k *Kernel) Timeline(ctx context.Context, in TimelineInput) (*TimelineResult, error) {
	if in.Mission == "" || (in.Before != "" && in.From != "") {
		return nil, errf("INVALID", "需要主任务，before 与 from 不能同时使用")
	}
	ch, unsub := k.subscribe(in.Mission)
	defer unsub()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	var owner Owner
	err := k.read(func() error {
		return k.db.QueryRow(`SELECT owner_engine,owner_session FROM missions WHERE id=?`, in.Mission).Scan(&owner.Engine, &owner.Session)
	})
	if err == sql.ErrNoRows {
		return nil, errf("NOT_FOUND", "主任务 %s 不存在", in.Mission)
	}
	if err != nil {
		return nil, err
	}
	if owner.Session != "" && (owner.Engine == "codex" || owner.Engine == "claude") {
		// Native session reads are not context-aware. Let the caller cancel while
		// the bounded read finishes, and keep it tracked through Kernel.Close.
		synced := make(chan error, 1)
		k.subMu.Lock()
		select {
		case <-k.stop:
			k.subMu.Unlock()
			return nil, errf("CLOSED", "服务已关闭")
		default:
			k.sessionWG.Add(1)
		}
		k.subMu.Unlock()
		go func() { defer k.sessionWG.Done(); synced <- k.SyncMissionSession(in.Mission) }()
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case err = <-synced:
			if err != nil {
				return nil, err
			}
		}
	}
	timeout := k.timelineWait
	if timeout <= 0 {
		timeout = 20 * time.Second
	}
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	for {
		if err = ctx.Err(); err != nil {
			return nil, err
		}
		var out *TimelineResult
		if err = k.prefetchConvorel(in.Mission); err != nil {
			return nil, err
		}
		err = k.read(func() error { var e error; out, e = k.composeTimeline(in.Mission); return e })
		if err != nil {
			return nil, err
		}
		all := out.Entries
		pendingReview := false
		for _, e := range all {
			if e.Kind == "review" && e.State == "waiting" {
				pendingReview = true
				break
			}
		}
		if in.From != "" {
			start := sort.Search(len(all), func(i int) bool { return all[i].Ord >= in.From })
			out.HasMore = start > 0
			all = all[start:]
			for out.Keep < len(in.Have) && out.Keep < len(all) && in.Have[out.Keep] == all[out.Keep].Hash {
				out.Keep++
			}
			out.Entries = all[out.Keep:]
		} else {
			end := len(all)
			if in.Before != "" {
				end = sort.Search(len(all), func(i int) bool { return all[i].Ord >= in.Before })
			}
			limit := in.Limit
			if limit <= 0 {
				limit = 300
			}
			start := max(0, end-limit)
			out.HasMore = start > 0
			out.Entries = all[start:end]
		}
		if !in.Wait || in.From == "" || out.Keep != len(in.Have) || len(out.Entries) > 0 {
			return out, nil
		}
		var refresh <-chan time.Time
		var poll *time.Timer
		if pendingReview {
			poll = time.NewTimer(convorelRefresh)
			refresh = poll.C
		}
		// Stop the poll on every exit, including notifications and cancellation.
		select {
		case <-ctx.Done():
			if poll != nil {
				poll.Stop()
			}
			return nil, ctx.Err()
		case <-k.stop:
			if poll != nil {
				poll.Stop()
			}
			return out, nil
		case <-deadline.C:
			if poll != nil {
				poll.Stop()
			}
			return out, nil
		case <-refresh:
		case <-ch:
		}
		if poll != nil {
			poll.Stop()
		}
		// Coalesce a burst with a fixed window, so continuous progress cannot starve readers.
		debounce := time.NewTimer(100 * time.Millisecond)
		select {
		case <-ctx.Done():
			debounce.Stop()
			return nil, ctx.Err()
		case <-deadline.C:
			debounce.Stop()
			return out, nil
		case <-debounce.C:
		}
		select {
		case <-ch:
		default:
		}
	}
}

// sessionText is what an item says. Rows synced before the LobeHub guide was
// stripped at parse time still carry it, so it is stripped here as well.
func sessionText(v SessionItem) string {
	if v.Role == "user" {
		return strings.TrimSpace(stripLobeHubGuide(v.Text))
	}
	return v.Text
}

// sessionEntry turns one owner-session item into its timeline entry; ok is
// false for a user row that said nothing of its own.
func sessionEntry(v SessionItem) (TimelineEntry, bool) {
	kind := v.Role
	if kind == "assistant" {
		kind = "owner"
	}
	if kind == "tool" {
		kind = "ops"
	}
	e := TimelineEntry{Ord: timelineOrd(v.At, 0, seqOrd(v.Seq)), At: v.At, Kind: kind}
	if kind == "ops" {
		e.Ops = []TimelineOp{{At: v.At, Tool: v.Tool, Text: v.Text}}
		e.To = v.At
	} else {
		text := sessionText(v)
		if text == "" {
			return e, false
		}
		e.body(text, fmt.Sprintf("session:%d", v.Seq))
	}
	return e, true
}

// foldOps merges adjacent operations; only neighbours in the final order fold.
func foldOps(entries []TimelineEntry) []TimelineEntry {
	merged := make([]TimelineEntry, 0, len(entries))
	for _, e := range entries {
		if e.Kind == "ops" && len(merged) > 0 && merged[len(merged)-1].Kind == "ops" {
			prev := &merged[len(merged)-1]
			prev.Ops = append(prev.Ops, e.Ops...)
			prev.To = e.To
		} else {
			merged = append(merged, e)
		}
	}
	return merged
}

type timelinePkg struct {
	summary        TimelinePackage
	id             string
	advisory, auto bool
	pendingNote    string
	plan           int64
	attempts       map[int]*Attempt
}
type dialoguePosition struct {
	name, side string
	round      int
}

// composeTimeline runs under the kernel read lock; each input is loaded once.
func (k *Kernel) composeTimeline(mission string) (*TimelineResult, error) {
	m, err := getMission(k.db, mission)
	if err != nil {
		return nil, err
	}
	out := &TimelineResult{Mission: m, Packages: []TimelinePackage{}, Entries: []TimelineEntry{}, Session: TimelineSession{State: "none"}}
	packages, err := timelinePackages(k.db, mission)
	if err != nil {
		return nil, err
	}
	byID := map[string]*timelinePkg{}
	byPlan := map[int64][]string{}
	positions := map[string]dialoguePosition{}
	lastRound := map[string]int{}
	for _, p := range packages {
		byID[p.id] = p
		if name, round, side, ok := parseDialoguePackage(p.summary.Key, p.advisory); ok {
			positions[p.id] = dialoguePosition{name, side, round}
			lastRound[name] = max(lastRound[name], round)
			p.summary.Dialogue = true
		} else {
			byPlan[p.plan] = append(byPlan[p.plan], p.summary.Key)
		}
		out.Packages = append(out.Packages, p.summary)
	}
	add := func(e TimelineEntry) int { out.Entries = append(out.Entries, e); return len(out.Entries) - 1 }
	add(TimelineEntry{Ord: timelineOrd(m.CreatedAt, 1, "created"), Kind: "created", At: m.CreatedAt})
	if m.ClosedAt != 0 {
		add(TimelineEntry{Ord: timelineOrd(m.ClosedAt, 3, "closed"), Kind: "closed", At: m.ClosedAt})
	}
	items, session, err := timelineSessionItems(k.db, m)
	if err != nil {
		return nil, err
	}
	out.Session = session
	if out.Earlier, _, err = timelineEarlier(k.db, m); err != nil {
		return nil, err
	}
	reviews, represented, err := k.timelineConvorel(m, items)
	if err != nil {
		return nil, err
	}
	for _, review := range reviews {
		add(review.entry)
	}
	for _, v := range items {
		if v.Role == "tool" && represented[v.Ref] {
			continue
		}
		if e, ok := sessionEntry(v); ok {
			add(e)
		}
	}
	events, err := timelineEvents(k.db, mission)
	if err != nil {
		return nil, err
	}
	problems := map[string]int{}
	dialogues := map[string]bool{}
	roundTimes := map[string]TimelineEntry{}
	for _, v := range events {
		p := byID[v.Package]
		pos, isDialogue := positions[v.Package]
		e := TimelineEntry{Ord: timelineOrd(v.At, 2, seqOrd(v.Seq)), Kind: v.Kind, At: v.At, Attempt: v.Attempt}
		var a *Attempt
		if p != nil {
			e.Package = p.summary.Key
			a = p.attempts[v.Attempt]
		}
		if a != nil {
			e.Worker, e.Engine, e.Model = a.Worker, a.Engine, a.Model
		}
		if isDialogue {
			e.Name, e.Side = pos.name, pos.side
		}
		reason := v.Message
		if v.Kind == EvFailed && a != nil && a.FailureMessage != "" {
			reason = a.FailureMessage
		}
		// One incident owns its recovery chain, including later failed retries.
		if idx, ok := problems[v.Package]; ok && v.Package != "" {
			switch v.Kind {
			case EvRetry, EvFailed, EvCancelled, EvResult, EvAccepted:
				text := v.Message
				if v.Kind == EvFailed {
					text = fmt.Sprintf("第 %d 次尝试：%s", v.Attempt, reason)
				}
				if v.Kind == EvRetry {
					// The event reads 重试：<note>; the step already says 重试.
					text = strings.TrimPrefix(strings.TrimPrefix(text, "重试"), "：")
				}
				if v.Kind == EvAccepted {
					text = fmt.Sprintf("第 %d 次尝试已采纳", v.Attempt)
				}
				out.Entries[idx].Steps = append(out.Entries[idx].Steps, TimelineStep{At: v.At, Action: v.Kind, Text: text})
				out.Entries[idx].Open = false
				// A successful result completes the recovery; its later verdict still belongs to it.
				if v.Kind == EvAccepted || v.Kind == EvCancelled {
					delete(problems, v.Package)
				}
				continue
			}
		}
		switch v.Kind {
		case EvPlan:
			if keys := byPlan[v.Seq]; len(keys) > 0 {
				e.Kind = "dispatch"
				e.Packages = keys
				add(e)
			}
			for _, dp := range packages {
				d, ok := positions[dp.id]
				if !ok || dp.plan != v.Seq || dialogues[d.name] {
					continue
				}
				dialogues[d.name] = true
				de := TimelineEntry{Ord: timelineOrd(v.At, 2, seqOrd(v.Seq)+":dialogue:"+d.name), Kind: "dialogue", At: v.At, Name: d.name, Rounds: lastRound[d.name] - 1}
				for _, side := range dialogueSides {
					for _, sp := range packages {
						s, yes := positions[sp.id]
						if yes && s.name == d.name && s.round == 1 && s.side == side {
							q := sp.summary
							de.Sides = append(de.Sides, TimelineSide{Side: side, Package: d.name, Worker: q.Worker, Engine: q.Engine, Model: q.Model, Effort: q.Effort, Account: q.Account})
						}
					}
				}
				add(de)
			}
		case EvResult, EvAccepted:
			if isDialogue && (v.Kind == EvResult || p.auto) {
				e.Kind = "debater"
				e.Round = pos.round
				e.RoundKind = dialogueRoundKind(pos.round, lastRound[pos.name])
				if a != nil {
					e.body(a.Result, "result:"+a.ID)
				}
				add(e)
				rk := fmt.Sprintf("%s:%d", pos.name, pos.round)
				if old, ok := roundTimes[rk]; !ok || v.At-1 < old.At {
					roundTimes[rk] = TimelineEntry{Kind: "round", At: v.At - 1, Ord: timelineOrd(v.At-1, 2, "round:"+rk), Name: pos.name, Round: pos.round, RoundKind: e.RoundKind}
				}
			} else if v.Kind == EvResult {
				if a != nil {
					e.body(a.Result, "result:"+a.ID)
				}
				add(e)
			} else {
				if p != nil && p.auto && a != nil {
					r := e
					r.Kind = "result"
					r.Ord += ":0"
					r.body(a.Result, "result:"+a.ID)
					add(r)
					e.Ord += ":1"
				}
				e.Note = eventNote(v)
				e.NoteChars = utf8.RuneCountInString(e.Note)
				e.NoteRef = fmt.Sprintf("event:%d", v.Seq)
				add(e)
			}
		case EvReturned:
			note := timelineReturnNote(p, v)
			e.Note, e.NoteChars = preview(note, 600)
			e.NoteRef = fmt.Sprintf("event:%d", v.Seq)
			add(e)
		case EvFailed, EvStalled, EvAnomaly, EvAccount:
			e.Kind = "problem"
			e.Problem = v.Kind
			e.Reason = reason
			e.Open = p != nil && (p.summary.State == StateFailed || ((v.Kind == EvStalled || v.Kind == EvAnomaly || v.Kind == EvAccount) && (p.summary.State == StateRunning || p.summary.State == StateLaunch)))
			problems[v.Package] = add(e)
		case EvRetry, EvCancelled, EvTimer, EvExternal:
			e.Text = v.Message
			add(e)
		}
	}
	for _, e := range roundTimes {
		add(e)
	}
	rows, err := k.db.Query(`SELECT id,kind,title,path,url,created_at FROM artifacts WHERE mission_id=? ORDER BY created_at,rowid`, mission)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		a := &TimelineArtifact{}
		var at int64
		if err = rows.Scan(&a.ID, &a.Kind, &a.Title, &a.Path, &a.URL, &at); err != nil {
			rows.Close()
			return nil, err
		}
		add(TimelineEntry{Ord: timelineOrd(at, 2, "artifact:"+a.ID), At: at, Kind: "artifact", Artifact: a})
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	sort.Slice(out.Entries, func(i, j int) bool { return out.Entries[i].Ord < out.Entries[j].Ord })
	merged := foldOps(out.Entries)
	for i := range merged {
		b, _ := json.Marshal(merged[i])
		h := sha256.Sum256(b)
		merged[i].Hash = fmt.Sprintf("%x", h[:4])
	}
	out.Entries = merged
	return out, nil
}

func timelinePackages(q querier, mission string) ([]*timelinePkg, error) {
	rows, err := q.Query(`SELECT p.id,p.key,p.title,p.state,p.waiting,p.attempt,p.worker,COALESCE(NULLIF(p.engine,''),w.engine,''),p.created_at,p.advisory,p.auto_accept,p.next_note,COALESCE(p.plan_seq,0),COALESCE(w.model,''),COALESCE(w.effort,'') FROM packages p LEFT JOIN workers w ON w.id=p.worker WHERE p.mission_id=? ORDER BY p.position`, mission)
	if err != nil {
		return nil, err
	}
	out := []*timelinePkg{}
	byID := map[string]*timelinePkg{}
	for rows.Next() {
		p := &timelinePkg{attempts: map[int]*Attempt{}}
		s := &p.summary
		if err = rows.Scan(&p.id, &s.Key, &s.Title, &s.State, &s.Waiting, &s.Attempt, &s.Worker, &s.Engine, &s.CreatedAt, &p.advisory, &p.auto, &p.pendingNote, &p.plan, &s.Model, &s.Effort); err != nil {
			rows.Close()
			return nil, err
		}
		out = append(out, p)
		byID[p.id] = p
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	rows, err = q.Query(`SELECT a.package_id,a.id,a.n,a.worker,a.engine,a.model,a.effort,COALESCE(NULLIF(c.label,''),a.account_id),a.note,a.result,a.failure_message,COALESCE(a.started_at,0),COALESCE(a.finished_at,0) FROM attempts a LEFT JOIN accounts c ON c.id=a.account_id WHERE a.mission_id=? ORDER BY a.n`, mission)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		a := &Attempt{}
		var id string
		if err = rows.Scan(&id, &a.ID, &a.N, &a.Worker, &a.Engine, &a.Model, &a.Effort, &a.Account, &a.Note, &a.Result, &a.FailureMessage, &a.StartedAt, &a.FinishedAt); err != nil {
			return nil, err
		}
		if p := byID[id]; p != nil {
			p.attempts[a.N] = a
			if a.N == p.summary.Attempt {
				s := &p.summary
				s.Worker, s.Engine, s.Model, s.Effort, s.Account = a.Worker, a.Engine, a.Model, a.Effort, a.Account
				s.StartedAt, s.FinishedAt = a.StartedAt, a.FinishedAt
			}
		}
	}
	return out, rows.Err()
}
func timelineEvents(q querier, mission string) ([]Event, error) {
	rows, err := q.Query(`SELECT seq,package_id,attempt,kind,message,at FROM events WHERE mission_id=? AND kind<>'progress' ORDER BY seq`, mission)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Event{}
	for rows.Next() {
		var e Event
		if err = rows.Scan(&e.Seq, &e.Package, &e.Attempt, &e.Kind, &e.Message, &e.At); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}
func eventNote(e Event) string {
	if _, s, ok := strings.Cut(e.Message, "："); ok {
		return s
	}
	return ""
}
func timelineReturnNote(p *timelinePkg, e Event) string {
	if p != nil {
		if next := p.attempts[e.Attempt+1]; next != nil && next.Note != "" {
			return next.Note
		}
		if p.summary.Attempt == e.Attempt && p.pendingNote != "" {
			return p.pendingNote
		}
	}
	return eventNote(e)
}
func dialogueRoundKind(round, last int) string {
	if round == 1 {
		return "proposal"
	}
	if round == last {
		return "final"
	}
	return "exchange"
}

// timelineSessionItems applies the same display bounds to timeline and full-text reads.
func timelineSessionItems(q querier, m *Mission) ([]SessionItem, TimelineSession, error) {
	state := TimelineSession{State: "none"}
	if m.Owner == nil || m.Owner.Session == "" {
		return nil, state, nil
	}
	o := m.Owner
	state.Engine = o.Engine
	if o.Engine != "claude" && o.Engine != "codex" {
		state.State = "unsupported"
		return nil, state, nil
	}
	state.State = "ok"
	var stored string
	err := q.QueryRow(`SELECT state, COALESCE((SELECT at FROM session_items WHERE engine=? AND session=? ORDER BY seq DESC LIMIT 1),0) FROM owner_sessions WHERE engine=? AND session=?`, o.Engine, o.Session, o.Engine, o.Session).Scan(&stored, &state.SyncedTo)
	if err != nil && err != sql.ErrNoRows {
		return nil, state, err
	}
	if stored != "" {
		state.State = stored
	}
	start, end, err := timelineSessionBounds(q, m)
	if err != nil {
		return nil, state, err
	}
	if end == -1 {
		return nil, state, nil
	}
	rows, err := q.Query(`SELECT seq,at,role,tool,text,ref FROM session_items WHERE engine=? AND session=? AND seq>=? AND (?=0 OR seq<?) ORDER BY seq`, o.Engine, o.Session, start, end, end)
	if err != nil {
		return nil, state, err
	}
	defer rows.Close()
	out := []SessionItem{}
	for rows.Next() {
		v := SessionItem{Engine: o.Engine, Session: o.Session}
		if err = rows.Scan(&v.Seq, &v.At, &v.Role, &v.Tool, &v.Text, &v.Ref); err != nil {
			return nil, state, err
		}
		out = append(out, v)

	}
	return out, state, rows.Err()
}

// timelineSessionBounds returns sequence boundaries; end=-1 means no display interval.
func timelineSessionBounds(q querier, m *Mission) (int64, int64, error) {
	_, _, previousClosed, err := previousSessionMission(q, m)
	if err != nil {
		return 0, 0, err
	}
	boundary := func(closed int64) (int64, error) {
		var seq int64
		e := q.QueryRow(`SELECT COALESCE((SELECT seq FROM session_items WHERE engine=? AND session=? AND role='user' AND at>? ORDER BY at,seq LIMIT 1),0)`, m.Owner.Engine, m.Owner.Session, closed).Scan(&seq)
		return seq, e
	}
	start, end := int64(0), int64(0)
	if previousClosed != 0 {
		start, err = boundary(previousClosed)
		if err != nil {
			return 0, 0, err
		}
		if start == 0 {
			return 0, -1, nil
		}
	}
	if m.ClosedAt != 0 {
		end, err = boundary(m.ClosedAt)
		if err != nil {
			return 0, 0, err
		}
	}
	return start, end, nil
}

// previousSessionMission is the mission created just before m in the same owner session.
func previousSessionMission(q querier, m *Mission) (id, title string, closed int64, err error) {
	err = q.QueryRow(`SELECT id,title,COALESCE(closed_at,0) FROM missions WHERE owner_engine=? AND owner_session=? AND (created_at<? OR (created_at=? AND rowid<(SELECT rowid FROM missions WHERE id=?))) ORDER BY created_at DESC,rowid DESC LIMIT 1`, m.Owner.Engine, m.Owner.Session, m.CreatedAt, m.CreatedAt, m.ID).Scan(&id, &title, &closed)
	if err == sql.ErrNoRows {
		err = nil
	}
	return
}

// timelineEarlier describes the session conversation before this mission's
// part and returns the first sequence of that part; nil when nothing precedes it.
func timelineEarlier(q querier, m *Mission) (*TimelineEarlier, int64, error) {
	if m.Owner == nil || m.Owner.Session == "" || (m.Owner.Engine != "claude" && m.Owner.Engine != "codex") {
		return nil, 0, nil
	}
	start, _, err := timelineSessionBounds(q, m)
	if err != nil || start <= 0 {
		return nil, 0, err
	}
	out := &TimelineEarlier{}
	if out.Mission, out.Title, _, err = previousSessionMission(q, m); err != nil {
		return nil, 0, err
	}
	err = q.QueryRow(`SELECT COUNT(*) FROM session_items WHERE engine=? AND session=? AND seq<? AND role IN ('user','assistant')`, m.Owner.Engine, m.Owner.Session, start).Scan(&out.Count)
	if err != nil {
		return nil, 0, err
	}
	return out, start, nil
}

// EarlierTimeline returns the owner-session conversation before this
// mission's part: user messages, the owner's words and folded operations.
func (k *Kernel) EarlierTimeline(mission string) ([]TimelineEntry, error) {
	out := []TimelineEntry{}
	err := k.read(func() error {
		m, err := getMission(k.db, mission)
		if err != nil {
			return err
		}
		info, start, err := timelineEarlier(k.db, m)
		if err != nil || info == nil {
			return err
		}
		rows, err := k.db.Query(`SELECT seq,at,role,tool,text,ref FROM session_items WHERE engine=? AND session=? AND seq<? ORDER BY seq`, m.Owner.Engine, m.Owner.Session, start)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var v SessionItem
			if err = rows.Scan(&v.Seq, &v.At, &v.Role, &v.Tool, &v.Text, &v.Ref); err != nil {
				return err
			}
			if e, ok := sessionEntry(v); ok {
				out = append(out, e)
			}
		}
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}
	return foldOps(out), nil
}

// MissionText checks ownership, including the session display interval, before returning a body.
// Refs are session:<seq>, result:<attempt ID>, event:<seq>, instruction:<mission>/<key>,
// or ask:<convorel ID>:<round> and review:<convorel ID>:<round>.
// An instruction ref can also use the package ID from existing package APIs.
func (k *Kernel) MissionText(mission, ref string) (*MissionTextResult, error) {
	out := &MissionTextResult{}
	if strings.HasPrefix(ref, "ask:") || strings.HasPrefix(ref, "review:") {
		if err := k.prefetchConvorel(mission); err != nil {
			return nil, err
		}
	}
	err := k.read(func() error {
		m, err := getMission(k.db, mission)
		if err != nil {
			return err
		}
		kind, id, ok := strings.Cut(ref, ":")
		if !ok {
			return errf("INVALID", "正文引用不合法")
		}
		switch kind {
		case "ask", "review":
			items, _, e := timelineSessionItems(k.db, m)
			if e != nil {
				return e
			}
			reviews, _, e := k.timelineConvorel(m, items)
			if e != nil {
				return e
			}
			for _, review := range reviews {
				entry := review.entry
				if entry.Ref != ref {
					continue
				}
				out.Text = review.text
				out.Title = fmt.Sprintf("问 Convorel · 第 %d 轮", entry.Round)
				if kind == "review" {
					out.Title = fmt.Sprintf("Convorel · 第 %d 轮回复", entry.Round)
				}
				return nil
			}
			return errf("NOT_FOUND", "正文不属于这个主任务")
		case "session":
			seq, e := strconv.ParseInt(id, 10, 64)
			if e != nil {
				return errf("INVALID", "正文引用不合法")
			}
			// The conversation before this mission's part is shown on demand,
			// so only the end of the part bounds what can be read.
			v, e := missionSessionItem(k.db, m, seq)
			if e != nil {
				return e
			}
			if v == nil {
				return errf("NOT_FOUND", "正文不属于这个主任务")
			}
			out.Text = sessionText(*v)
			label := "用户"
			if v.Role == "assistant" {
				label = map[string]string{"claude": "Claude", "codex": "Codex"}[v.Engine]
			}
			out.Title = label + " · " + time.UnixMilli(v.At).Format("15:04")
			return nil
		case "result":
			var key string
			var n int
			err = k.db.QueryRow(`SELECT p.key,a.n,a.result FROM attempts a JOIN packages p ON p.id=a.package_id WHERE a.id=? AND p.mission_id=?`, id, mission).Scan(&key, &n, &out.Text)
			out.Title = fmt.Sprintf("%s · 第 %d 次结果", key, n)
		case "instruction":
			var key string
			if owner, pkey, ok := strings.Cut(id, "/"); ok {
				if owner != mission {
					return errf("NOT_FOUND", "正文不属于这个主任务")
				}
				err = k.db.QueryRow(`SELECT key,instruction FROM packages WHERE key=? AND mission_id=?`, pkey, mission).Scan(&key, &out.Text)
			} else {
				err = k.db.QueryRow(`SELECT key,instruction FROM packages WHERE id=? AND mission_id=?`, id, mission).Scan(&key, &out.Text)
			}
			out.Title = key + " · 指令"
		case "event":
			seq, e := strconv.ParseInt(id, 10, 64)
			if e != nil {
				return errf("INVALID", "正文引用不合法")
			}
			var ev Event
			var key string
			err = k.db.QueryRow(`SELECT e.seq,e.package_id,e.attempt,e.kind,e.message,p.key FROM events e JOIN packages p ON p.id=e.package_id WHERE e.seq=? AND e.mission_id=? AND e.kind IN ('returned','accepted')`, seq, mission).Scan(&ev.Seq, &ev.Package, &ev.Attempt, &ev.Kind, &ev.Message, &key)
			out.Text = eventNote(ev)
			label := "采纳"
			if ev.Kind == EvReturned {
				label = "退回"
				var note string
				e = k.db.QueryRow(`SELECT note FROM attempts WHERE package_id=? AND n=?`, ev.Package, ev.Attempt+1).Scan(&note)
				if e != nil && e != sql.ErrNoRows {
					return e
				}
				if note == "" {
					var n int
					if e = k.db.QueryRow(`SELECT attempt,next_note FROM packages WHERE id=?`, ev.Package).Scan(&n, &note); e != nil {
						return e
					}
					if n != ev.Attempt {
						note = ""
					}
				}
				if note != "" {
					out.Text = note
				}
			}
			out.Title = fmt.Sprintf("%s %s · 第 %d 次", label, key, ev.Attempt)
		default:
			return errf("INVALID", "正文引用不合法")
		}
		if err == sql.ErrNoRows {
			return errf("NOT_FOUND", "正文不属于这个主任务")
		}
		return err
	})
	return out, err
}

// missionSessionItem returns item seq of the owner session when it lies before
// the end of the mission's part, or nil.
func missionSessionItem(q querier, m *Mission, seq int64) (*SessionItem, error) {
	if m.Owner == nil || m.Owner.Session == "" || (m.Owner.Engine != "claude" && m.Owner.Engine != "codex") {
		return nil, nil
	}
	_, end, err := timelineSessionBounds(q, m)
	if err != nil || end == -1 || (end != 0 && seq >= end) {
		return nil, err
	}
	v := &SessionItem{Engine: m.Owner.Engine, Session: m.Owner.Session}
	err = q.QueryRow(`SELECT seq,at,role,tool,text,ref FROM session_items WHERE engine=? AND session=? AND seq=?`, v.Engine, v.Session, seq).Scan(&v.Seq, &v.At, &v.Role, &v.Tool, &v.Text, &v.Ref)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return v, nil
}

// missionActivity uses indexed event lookups and package metadata, never transcripts or result bodies.
func missionActivity(q querier, m *Mission) (string, error) {
	var key, kind, reason string
	err := q.QueryRow(`SELECT p.key,e.kind,CASE WHEN e.kind='failed' THEN COALESCE(NULLIF(a.failure_message,''),e.message) ELSE e.message END
 FROM events e JOIN packages p ON p.id=e.package_id LEFT JOIN attempts a ON a.package_id=e.package_id AND a.n=e.attempt
 WHERE e.mission_id=? AND e.kind<>'progress' AND e.kind IN ('failed','stalled','anomaly','account')
 AND (p.state='failed' OR (p.state IN ('running','launching') AND e.kind IN ('stalled','anomaly','account')))
 AND NOT EXISTS (SELECT 1 FROM events d WHERE d.package_id=e.package_id AND d.seq>e.seq AND d.kind IN ('retry','failed','cancelled','result','accepted'))
 AND (e.kind<>'failed' OR NOT EXISTS (SELECT 1 FROM events root WHERE root.package_id=e.package_id AND root.seq<e.seq AND root.kind IN ('failed','stalled','anomaly','account')
 AND NOT EXISTS (SELECT 1 FROM events done WHERE done.package_id=e.package_id AND done.seq>root.seq AND done.seq<e.seq AND done.kind IN ('accepted','cancelled'))))
 ORDER BY e.seq DESC LIMIT 1`, m.ID).Scan(&key, &kind, &reason)
	if err == nil {
		label := map[string]string{EvFailed: "失败", EvStalled: "卡住", EvAnomaly: "异常", EvAccount: "账号受限"}[kind]
		first, _, _ := strings.Cut(reason, "\n")
		return key + " " + label + "：" + first, nil
	}
	if err != sql.ErrNoRows {
		return "", err
	}
	rows, err := q.Query(`SELECT key,state FROM packages WHERE mission_id=? AND advisory=1 ORDER BY position`, m.ID)
	if err != nil {
		return "", err
	}
	type status struct {
		last, current int
		active        bool
		finalReady    map[string]bool
	}
	dialogues := map[string]*status{}
	order := []string{}
	for rows.Next() {
		var key, state string
		if err = rows.Scan(&key, &state); err != nil {
			rows.Close()
			return "", err
		}
		name, round, side, ok := parseDialoguePackage(key, true)
		if !ok {
			continue
		}
		s := dialogues[name]
		if s == nil {
			s = &status{finalReady: map[string]bool{}}
			dialogues[name] = s
			order = append(order, name)
		}
		if state == StatePending || state == StateRunning || state == StateLaunch || state == StateVerdict {
			s.active = true
		}
		if round > s.last {
			s.last = round
			s.finalReady = map[string]bool{}
		}
		if round == s.last {
			s.finalReady[side] = state == StateVerdict || state == StateAccepted
		}
		if state != StatePending {
			s.current = max(s.current, round)
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return "", err
	}
	for _, name := range order {
		s := dialogues[name]
		if s.active && (!s.finalReady["a"] || !s.finalReady["b"]) {
			return fmt.Sprintf("对谈 %s 进行到第 %d 轮", name, max(1, s.current)), nil
		}
	}
	if m.ClosedAt != 0 {
		return "任务结束", nil
	}
	var e Event
	err = q.QueryRow(`SELECT seq,kind,package_id,message FROM events WHERE mission_id=? AND kind<>'progress' AND kind NOT IN ('released','launching','handed','running') ORDER BY seq DESC LIMIT 1`, m.ID).Scan(&e.Seq, &e.Kind, &e.Package, &e.Message)
	if err != nil && err != sql.ErrNoRows {
		return "", err
	}
	if e.Kind == EvPlan {
		var n int
		if err = q.QueryRow(`SELECT COUNT(*) FROM packages WHERE mission_id=? AND plan_seq=?`, m.ID, e.Seq).Scan(&n); err != nil {
			return "", err
		}
		return fmt.Sprintf("派出 %d 个 Agent", n), nil
	}
	if m.Counts[StateVerdict] > 0 {
		return fmt.Sprintf("待验收 %d 个", m.Counts[StateVerdict]), nil
	}
	if e.Kind == EvAccepted || e.Kind == EvReturned {
		var key string
		if err = q.QueryRow(`SELECT key FROM packages WHERE id=?`, e.Package).Scan(&key); err != nil {
			return "", err
		}
		label := "采纳 "
		if e.Kind == EvReturned {
			label = "退回 "
		}
		return label + key, nil
	}
	if m.Owner != nil {
		var text string
		err = q.QueryRow(`SELECT substr(text,1,60) FROM session_items WHERE engine=? AND session=? AND role='assistant' ORDER BY seq DESC LIMIT 1`, m.Owner.Engine, m.Owner.Session).Scan(&text)
		if err != nil && err != sql.ErrNoRows {
			return "", err
		}
		text, _ = preview(text, 60)
		return text, nil
	}
	return "", nil
}
