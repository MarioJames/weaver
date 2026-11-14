package kernel

import (
	"crypto/rand"
	"database/sql"
	"encoding/base32"
	"log/slog"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/MarioJames/weaver/internal/engine"
)

// Engines is what the kernel needs from the launch layer.
type Engines interface {
	// Launch starts an attempt and returns immediately; progress arrives through the Sink.
	Launch(run engine.Run)
	// Cancel stops an attempt and returns once its processes are gone or its session is interrupted.
	Cancel(attemptID string) engine.CancelResult
	// Reattach resumes supervision of an attempt that was active when the service last stopped.
	Reattach(run engine.Run, mode, unit, vendorSession string)
	// Prewarm starts a standby process for a package that is about to be released.
	Prewarm(run engine.Run)
	// DropPrewarm discards a standby process that will not be used.
	DropPrewarm(packageID string)
	// Warm prepares resident engines for work in a directory.
	Warm(workspace string)
	// Liveness reports process activity for the stall check.
	Liveness(attemptID string) engine.Liveness
}

// Pusher delivers a wake-up into a parent agent's Herdr pane.
type Pusher func(session, pane, text string) error

// Options configures a Kernel.
type Options struct {
	DB      *sql.DB
	Home    string
	Engines Engines
	Push    Pusher
	// Check reports whether an account's credential material is usable.
	Check func(engine.Account) (bool, string)
	Log   *slog.Logger
	Now   func() time.Time
}

// Kernel owns all mission state. Every mutation runs in one SQLite transaction
// under mu; launches, cancels and notifications happen after commit.
type Kernel struct {
	db    *sql.DB
	home  string
	eng   Engines
	push  Pusher
	check func(engine.Account) (bool, string)
	log   *slog.Logger
	now   func() time.Time

	mu sync.Mutex

	subMu   sync.Mutex
	subs    map[string]map[chan struct{}]struct{}
	waiters map[string]int
	pushing map[string]bool

	actMu    sync.Mutex
	activity map[string]*activity

	timerKick chan struct{}
	stop      chan struct{}
	stopOnce  sync.Once
}

type activity struct {
	last     time.Time
	output   bool
	cpu      uint64
	cpuAt    time.Time
	idleFrom time.Time
	stalled  bool
}

// New creates a kernel. Call Start to resume supervision and timers.
func New(o Options) *Kernel {
	k := &Kernel{
		db: o.DB, home: o.Home, eng: o.Engines, push: o.Push, check: o.Check, log: o.Log, now: o.Now,
		subs: map[string]map[chan struct{}]struct{}{}, waiters: map[string]int{}, pushing: map[string]bool{},
		activity: map[string]*activity{}, timerKick: make(chan struct{}, 1), stop: make(chan struct{}),
	}
	if k.now == nil {
		k.now = time.Now
	}
	if k.log == nil {
		k.log = slog.New(slog.DiscardHandler)
	}
	return k
}

// SetEngines wires the launch layer after construction (it needs the kernel as its Sink).
func (k *Kernel) SetEngines(e Engines) { k.eng = e }

func (k *Kernel) ms() int64 { return k.now().UnixMilli() }

var idEncoding = base32.NewEncoding("abcdefghijklmnopqrstuvwxyz234567").WithPadding(base32.NoPadding)

func newID(prefix string) string {
	var b [6]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return prefix + idEncoding.EncodeToString(b[:])
}

// tx is one kernel transaction plus the side effects to run after it commits.
type tx struct {
	*sql.Tx
	k        *Kernel
	now      int64
	launches []engine.Run
	prewarms []engine.Run
	drops    []string
	warms    []string
	touched  map[string]bool
	woke     map[string]bool
	timers   bool
}

// write runs fn in a transaction and performs the queued side effects after commit.
func (k *Kernel) write(fn func(t *tx) error) error {
	k.mu.Lock()
	sqlTx, err := k.db.Begin()
	if err != nil {
		k.mu.Unlock()
		return err
	}
	t := &tx{Tx: sqlTx, k: k, now: k.ms(), touched: map[string]bool{}, woke: map[string]bool{}}
	if err := fn(t); err != nil {
		sqlTx.Rollback()
		k.mu.Unlock()
		return err
	}
	if err := sqlTx.Commit(); err != nil {
		k.mu.Unlock()
		return err
	}
	k.mu.Unlock()
	k.afterCommit(t)
	return nil
}

func (k *Kernel) afterCommit(t *tx) {
	for _, run := range t.launches {
		k.touch(run.AttemptID)
		k.eng.Launch(run)
	}
	for _, dir := range t.warms {
		k.eng.Warm(dir)
	}
	for _, id := range t.drops {
		k.eng.DropPrewarm(id)
	}
	for _, run := range t.prewarms {
		k.eng.Prewarm(run)
	}
	if t.timers {
		select {
		case k.timerKick <- struct{}{}:
		default:
		}
	}
	for mission := range t.touched {
		k.notify(mission)
	}
	for mission := range t.woke {
		k.maybePush(mission)
	}
}

// read runs fn under the kernel lock without a transaction.
func (k *Kernel) read(fn func() error) error {
	k.mu.Lock()
	defer k.mu.Unlock()
	return fn()
}

var wakeKinds = map[string]bool{EvResult: true, EvFailed: true, EvStalled: true, EvAnomaly: true, EvTimer: true, EvExternal: true}

func (t *tx) event(mission, pkg string, attempt int, kind, message string) (int64, error) {
	wake := 0
	if wakeKinds[kind] {
		wake = 1
		t.woke[mission] = true
	}
	res, err := t.Exec(`INSERT INTO events(mission_id, package_id, attempt, kind, wake, message, at) VALUES(?,?,?,?,?,?,?)`,
		mission, pkg, attempt, kind, wake, clip(message, 4000), t.now)
	if err != nil {
		return 0, err
	}
	t.touched[mission] = true
	return res.LastInsertId()
}

func clip(s string, max int) string {
	if len(s) <= max {
		return s
	}
	cut := max
	for cut > 0 && (s[cut]&0xC0) == 0x80 {
		cut--
	}
	return s[:cut] + "…"
}

// tail keeps the end of s, where an agent's final answer lives.
func tail(s string, max int) string {
	if len(s) <= max {
		return s
	}
	cut := len(s) - max
	for cut < len(s) && (s[cut]&0xC0) == 0x80 {
		cut++
	}
	return "…" + s[cut:]
}

func (k *Kernel) runDir(attemptID string) string { return filepath.Join(k.home, "runs", attemptID) }

// ---- row access ----

const packageCols = `id, mission_id, key, title, instruction, workspace, worker, engine, state, waiting, attempt, created_at, updated_at, advisory, auto_accept`

type scanner interface{ Scan(dest ...any) error }

func scanPackage(s scanner) (*Package, error) {
	p := &Package{}
	err := s.Scan(&p.ID, &p.MissionID, &p.Key, &p.Title, &p.Instruction, &p.Workspace, &p.Worker, &p.Engine, &p.State, &p.Waiting, &p.Attempt, &p.CreatedAt, &p.UpdatedAt, &p.Advisory, &p.AutoAccept)
	return p, err
}

const attemptCols = `id, n, state, worker, account_id, engine, model, effort, mode, note, unit, run_dir, vendor_session, created_at,
 COALESCE(handed_at,0), COALESCE(started_at,0), COALESCE(first_output_at,0), COALESCE(finished_at,0), COALESCE(stalled_at,0),
 exit_code, failure_kind, failure_message, result, input_tokens, output_tokens`

func scanAttempt(s scanner) (*Attempt, error) {
	a := &Attempt{}
	var exit sql.NullInt64
	err := s.Scan(&a.ID, &a.N, &a.State, &a.Worker, &a.Account, &a.Engine, &a.Model, &a.Effort, &a.Mode, &a.Note, &a.Unit, &a.RunDir, &a.VendorSession, &a.CreatedAt,
		&a.HandedAt, &a.StartedAt, &a.FirstOutputAt, &a.FinishedAt, &a.StalledAt, &exit, &a.FailureKind, &a.FailureMessage, &a.Result, &a.InputTokens, &a.OutputTokens)
	if exit.Valid {
		code := int(exit.Int64)
		a.ExitCode = &code
	}
	return a, err
}

type querier interface {
	Query(query string, args ...any) (*sql.Rows, error)
	QueryRow(query string, args ...any) *sql.Row
}

func getPackage(q querier, id string) (*Package, error) {
	p, err := scanPackage(q.QueryRow(`SELECT `+packageCols+` FROM packages WHERE id=?`, id))
	if err == sql.ErrNoRows {
		return nil, errf("NOT_FOUND", "工作包 %s 不存在", id)
	}
	return p, err
}

func getAttempt(q querier, id string) (*Attempt, string, string, error) {
	var pkg, mission string
	row := q.QueryRow(`SELECT package_id, mission_id FROM attempts WHERE id=?`, id)
	if err := row.Scan(&pkg, &mission); err != nil {
		return nil, "", "", err
	}
	a, err := scanAttempt(q.QueryRow(`SELECT `+attemptCols+` FROM attempts WHERE id=?`, id))
	return a, pkg, mission, err
}

func listAttempts(q querier, pkg string) ([]*Attempt, error) {
	rows, err := q.Query(`SELECT `+attemptCols+` FROM attempts WHERE package_id=? ORDER BY n`, pkg)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Attempt
	for rows.Next() {
		a, err := scanAttempt(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func depKeys(q querier, pkg string) ([]string, error) {
	rows, err := q.Query(`SELECT p.key FROM package_deps d JOIN packages p ON p.id=d.depends_on WHERE d.package_id=? ORDER BY p.position`, pkg)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var key string
		if err := rows.Scan(&key); err != nil {
			return nil, err
		}
		out = append(out, key)
	}
	return out, rows.Err()
}

func getMission(q querier, id string) (*Mission, error) {
	m := &Mission{Counts: map[string]int{}}
	var session, pane string
	var closed sql.NullInt64
	err := q.QueryRow(`SELECT id, title, workspace, notify_session, notify_pane, wake_cursor, created_at, closed_at FROM missions WHERE id=?`, id).
		Scan(&m.ID, &m.Title, &m.Workspace, &session, &pane, &m.Cursor, &m.CreatedAt, &closed)
	if err == sql.ErrNoRows {
		return nil, errf("NOT_FOUND", "主任务 %s 不存在", id)
	}
	if err != nil {
		return nil, err
	}
	if pane != "" {
		m.Notify = &Notify{Session: session, Pane: pane}
	}
	m.ClosedAt = closed.Int64
	rows, err := q.Query(`SELECT state, COUNT(*) FROM packages WHERE mission_id=? GROUP BY state`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var state string
		var n int
		if err := rows.Scan(&state, &n); err != nil {
			return nil, err
		}
		m.Counts[state] = n
		m.Total += n
	}
	m.State = missionState(m.Counts, m.Total)
	return m, rows.Err()
}

// missionState derives a mission's state from its packages.
func missionState(c map[string]int, total int) string {
	switch {
	case total == 0:
		return "empty"
	case c[StateLaunch]+c[StateRunning] > 0:
		return "running"
	case c[StateVerdict] > 0:
		return "awaiting_verdict"
	case c[StateFailed] > 0:
		return "attention"
	case c[StatePending] > 0:
		return "blocked"
	default:
		return "done"
	}
}

func (t *tx) setPackage(p *Package, state, waiting string) error {
	p.State, p.Waiting, p.UpdatedAt = state, waiting, t.now
	_, err := t.Exec(`UPDATE packages SET state=?, waiting=?, attempt=?, updated_at=? WHERE id=?`, state, waiting, p.Attempt, t.now, p.ID)
	return err
}

func stateLabel(state string) string {
	switch state {
	case StatePending:
		return "待定"
	case StateLaunch:
		return "启动中"
	case StateRunning:
		return "运行中"
	case StateVerdict:
		return "待结论"
	case StateAccepted:
		return "已采纳"
	case StateFailed:
		return "失败"
	case StateCanceled:
		return "已取消"
	case StateReturned:
		return "已退回"
	}
	return state
}

func joinNonEmpty(parts ...string) string {
	var out []string
	for _, p := range parts {
		if strings.TrimSpace(p) != "" {
			out = append(out, p)
		}
	}
	return strings.Join(out, "\n\n")
}

// ---- subscriptions ----

func (k *Kernel) subscribe(mission string) (chan struct{}, func()) {
	ch := make(chan struct{}, 1)
	k.subMu.Lock()
	if k.subs[mission] == nil {
		k.subs[mission] = map[chan struct{}]struct{}{}
	}
	k.subs[mission][ch] = struct{}{}
	k.subMu.Unlock()
	return ch, func() {
		k.subMu.Lock()
		delete(k.subs[mission], ch)
		if len(k.subs[mission]) == 0 {
			delete(k.subs, mission)
		}
		k.subMu.Unlock()
	}
}

func (k *Kernel) notify(mission string) {
	k.subMu.Lock()
	for ch := range k.subs[mission] {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
	k.subMu.Unlock()
}

func (k *Kernel) touch(attemptID string) {
	k.actMu.Lock()
	a := k.activity[attemptID]
	if a == nil {
		a = &activity{}
		k.activity[attemptID] = a
	}
	a.last = k.now()
	a.stalled = false
	a.cpuAt = time.Time{}
	k.actMu.Unlock()
}

func (k *Kernel) forget(attemptID string) {
	k.actMu.Lock()
	delete(k.activity, attemptID)
	k.actMu.Unlock()
}

// Close stops background loops. Running attempts are left alone: they belong
// to their own scopes and are picked up again by the next Start.
func (k *Kernel) Close() { k.stopOnce.Do(func() { close(k.stop) }) }
