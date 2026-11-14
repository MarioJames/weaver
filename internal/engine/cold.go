package engine

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// wrapperScript runs the engine as a child so that an exit record is written
// even when the scope is asked to terminate. Paths arrive through the
// environment and are never interpolated into the script.
//
// The engine is started in the background and waited for, because a signal
// trap only runs between commands. dash gives a background command /dev/null
// as stdin before applying redirections, so the real stdin is saved on fd 8.
const wrapperScript = `trap ':' TERM INT HUP
exec 8<&0
: > "$WEAVER_STARTED_FILE"
"$@" <&8 8<&- &
child=$!
exec 8<&-
code=0
while :; do
  wait $child && { code=$?; break; } || code=$?
  if kill -0 $child 2>/dev/null; then
    continue
  else
    wait $child 2>/dev/null
    status=$?
    [ $status -ne 127 ] && code=$status
    break
  fi
done
printf '{"pid":%s,"code":%s}\n' "$child" "$code" > "$WEAVER_EXIT_FILE.tmp"
mv -f "$WEAVER_EXIT_FILE.tmp" "$WEAVER_EXIT_FILE"
exit $code
`

const (
	exitGrace      = 30 * time.Second // how long a process may linger after giving its result
	failureGrace   = 15 * time.Second // how long a process may linger after reporting a failure
	standbyTTL     = 10 * time.Minute // a standby process nobody released is discarded
	standbyMaximum = 4
)

// Cold runs one process per attempt inside its own systemd scope. Output goes
// to files in the run directory, so supervision can be resumed after the
// service restarts. A standby process is the same thing started early, with a
// FIFO as stdin that receives the prompt on release.
type Cold struct {
	sink Sink
	log  *slog.Logger
	// Direct runs the wrapper without systemd-run. Only tests use it.
	Direct bool

	mu       sync.Mutex
	runs     map[string]*coldRun // by attempt ID
	standbys map[string]*coldRun // by package ID, not yet released
}

func NewCold(sink Sink, log *slog.Logger) *Cold {
	return &Cold{sink: sink, log: log, runs: map[string]*coldRun{}, standbys: map[string]*coldRun{}}
}

type coldRun struct {
	dir  string // immutable
	unit string
	mode string

	mu        sync.Mutex
	run       Run      // replaced on release, when the real attempt is known
	fifo      *os.File // standby only: the write end of the prompt FIFO
	released  bool     // the prompt has been delivered
	handed    bool
	started   bool
	sawStart  bool // the engine reported it is up (possibly before release)
	finished  bool // the terminal report was sent
	cancelled bool
	gone      bool // the process is known to have ended
	bornAt    time.Time
	exited    chan struct{} // closed when a process we spawned ourselves ends
	done      chan struct{} // closed when the watcher returns
	replay    bool          // suppress progress notes until the existing output is consumed

	toolSeen  map[string]uint64 // dsh: CPU last read from each tool scope, in microseconds
	toolTotal uint64            // dsh: CPU of all tool scopes so far, in nanoseconds
}

func unitFor(attemptID string) string {
	return "weaver-" + strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '.' || r == '_' || r == '-' {
			return r
		}
		return '-'
	}, attemptID)
}

func (r *coldRun) path(name string) string { return filepath.Join(r.dir, name) }

// Launch starts a fresh process for the attempt.
func (c *Cold) Launch(run Run) {
	r, err := c.start(run, false)
	if err != nil {
		c.sink.Finished(run.AttemptID, Outcome{FailureKind: FailLaunch, FailureMessage: err.Error()})
		return
	}
	go c.watch(r)
}

// SupportsStandby reports whether the engine can be started ahead of its prompt.
func SupportsStandby(engine string) bool { s := specs[engine]; return s != nil && s.standby }

// Prewarm starts a standby process for a package unless one is already waiting.
func (c *Cold) Prewarm(run Run) {
	if !SupportsStandby(run.Engine) {
		return
	}
	c.mu.Lock()
	if _, ok := c.standbys[run.PackageID]; ok || len(c.standbys) >= standbyMaximum {
		c.mu.Unlock()
		return
	}
	// Reserve the slot before the slow part so concurrent dispatches do not start two.
	placeholder := &coldRun{run: run, dir: run.RunDir}
	c.standbys[run.PackageID] = placeholder
	c.mu.Unlock()
	r, err := c.start(run, true)
	c.mu.Lock()
	if c.standbys[run.PackageID] != placeholder {
		// Dropped while starting.
		c.mu.Unlock()
		if err == nil {
			c.stop(r)
		}
		return
	}
	if err != nil {
		delete(c.standbys, run.PackageID)
		c.mu.Unlock()
		c.log.Warn("standby start failed", "package", run.PackageID, "err", err)
		return
	}
	c.standbys[run.PackageID] = r
	c.mu.Unlock()
	go c.watch(r)
}

// DropPrewarm discards a package's standby process, if any.
func (c *Cold) DropPrewarm(packageID string) {
	c.mu.Lock()
	r := c.standbys[packageID]
	delete(c.standbys, packageID)
	c.mu.Unlock()
	if r != nil && r.unit != "" {
		r.mu.Lock()
		r.cancelled = true
		r.mu.Unlock()
		c.stop(r)
	}
}

// Release hands the prompt to a standby process that matches the run. It
// reports false when there is none, and the caller falls back to a cold start.
func (c *Cold) Release(run Run) bool {
	c.mu.Lock()
	r := c.standbys[run.PackageID]
	if r == nil || r.unit == "" {
		c.mu.Unlock()
		return false
	}
	delete(c.standbys, run.PackageID)
	c.mu.Unlock()
	r.mu.Lock()
	usable := r.run.Account.ID == run.Account.ID && r.run.Model == run.Model && r.run.Effort == run.Effort && r.run.Workspace == run.Workspace && r.dir == run.RunDir
	if usable {
		r.run = run
	}
	r.mu.Unlock()
	if usable {
		c.mu.Lock()
		c.runs[run.AttemptID] = r
		c.mu.Unlock()
	}
	r.mu.Lock()
	if !usable || r.gone || r.cancelled {
		r.cancelled = true
		r.mu.Unlock()
		c.mu.Lock()
		if c.runs[run.AttemptID] == r {
			delete(c.runs, run.AttemptID)
		}
		c.mu.Unlock()
		c.stop(r)
		return false
	}
	message, _ := json.Marshal(map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": []any{map[string]any{"type": "text", "text": run.Instruction}}}})
	_ = os.WriteFile(r.path("prompt.txt"), []byte(run.Instruction), 0o600)
	_, err := r.fifo.Write(append(message, '\n'))
	if err != nil {
		r.cancelled = true
		r.mu.Unlock()
		c.mu.Lock()
		delete(c.runs, run.AttemptID)
		c.mu.Unlock()
		c.stop(r)
		return false
	}
	r.released, r.handed = true, true
	sawStart := r.sawStart
	r.started = sawStart
	r.mu.Unlock()
	c.sink.Handed(run.AttemptID, ModeStandby, r.unit)
	if sawStart {
		c.sink.Started(run.AttemptID, "")
	}
	return true
}

func (c *Cold) start(run Run, standby bool) (*coldRun, error) {
	s := specs[run.Engine]
	if s == nil {
		return nil, fmt.Errorf("不支持的引擎 %s", run.Engine)
	}
	if err := os.MkdirAll(run.RunDir, 0o700); err != nil {
		return nil, err
	}
	for _, stale := range []string{"stdout.jsonl", "stderr.log", "exit.json", "started", "stdin.fifo"} {
		os.Remove(filepath.Join(run.RunDir, stale))
	}
	ctx := &launchCtx{run: run, env: map[string]string{}, stdin: true}
	if err := s.prepare(ctx); err != nil {
		return nil, err
	}
	argv, err := s.argv(ctx)
	if err != nil {
		return nil, err
	}
	bin, err := exec.LookPath(argv[0])
	if err != nil {
		return nil, fmt.Errorf("本机没有安装 %s", argv[0])
	}
	argv[0] = bin
	r := &coldRun{run: run, dir: run.RunDir, unit: unitFor(run.AttemptID), mode: ModeCold, released: !standby, bornAt: time.Now(), exited: make(chan struct{}), done: make(chan struct{})}

	var stdin *os.File
	switch {
	case standby:
		r.mode = ModeStandby
		argv = append(argv, "--input-format", "stream-json")
		if err := syscall.Mkfifo(r.path("stdin.fifo"), 0o600); err != nil {
			return nil, err
		}
		// Read-write, so the engine never sees end-of-file while it waits,
		// even if this service restarts. A plain blocking descriptor keeps
		// O_NONBLOCK out of the child's stdin.
		fd, err := syscall.Open(r.path("stdin.fifo"), syscall.O_RDWR|syscall.O_CLOEXEC, 0)
		if err != nil {
			return nil, err
		}
		stdin = os.NewFile(uintptr(fd), "stdin.fifo")
		r.fifo = stdin
	default:
		if err := os.WriteFile(ctx.promptPath(), []byte(run.Instruction), 0o600); err != nil {
			return nil, err
		}
		name := os.DevNull
		if ctx.stdin {
			name = ctx.promptPath()
		}
		if stdin, err = os.Open(name); err != nil {
			return nil, err
		}
		defer stdin.Close()
	}
	stdout, err := os.OpenFile(r.path("stdout.jsonl"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return nil, err
	}
	defer stdout.Close()
	stderr, err := os.OpenFile(r.path("stderr.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return nil, err
	}
	defer stderr.Close()

	ctx.env["WEAVER_EXIT_FILE"] = r.path("exit.json")
	ctx.env["WEAVER_STARTED_FILE"] = r.path("started")
	wrapped := append([]string{"sh", "-c", wrapperScript, "sh"}, argv...)
	var cmd *exec.Cmd
	if c.Direct {
		cmd = exec.Command(wrapped[0], wrapped[1:]...)
	} else {
		args := []string{"--user", "--scope", "--collect", "--quiet", "--unit=" + r.unit, "--working-directory=" + run.Workspace,
			"-p", "KillMode=control-group", "-p", "MemoryHigh=8G", "-p", "MemoryMax=10G", "--"}
		cmd = exec.Command("systemd-run", append(args, wrapped...)...)
	}
	cmd.Dir = run.Workspace
	cmd.Env = CleanEnv(ctx.env)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = stdin, stdout, stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		if r.fifo != nil {
			r.fifo.Close()
		}
		return nil, fmt.Errorf("无法启动进程：%w", err)
	}
	pid := cmd.Process.Pid
	go func() {
		_ = cmd.Wait()
		close(r.exited)
	}()
	if c.Direct {
		r.unit = "pid:" + strconv.Itoa(pid)
	}
	if !standby {
		c.mu.Lock()
		c.runs[run.AttemptID] = r
		c.mu.Unlock()
	}
	return r, nil
}

// Reattach resumes watching an attempt whose process was started by an earlier service instance.
func (c *Cold) Reattach(run Run, mode, unit string) {
	r := &coldRun{run: run, dir: run.RunDir, unit: unit, mode: mode, bornAt: time.Now(), done: make(chan struct{}), replay: true, released: true, handed: true}
	if r.unit == "" {
		r.unit = unitFor(run.AttemptID)
	}
	if mode == ModeStandby {
		// Keep a writer on the FIFO for symmetry with a fresh standby; the prompt was already delivered.
		if fd, err := syscall.Open(r.path("stdin.fifo"), syscall.O_RDWR|syscall.O_CLOEXEC|syscall.O_NONBLOCK, 0); err == nil {
			r.fifo = os.NewFile(uintptr(fd), "stdin.fifo")
		}
	}
	c.mu.Lock()
	c.runs[run.AttemptID] = r
	c.mu.Unlock()
	go c.watch(r)
}

// Tracked reports whether the attempt is being watched.
func (c *Cold) Tracked(attemptID string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.runs[attemptID] != nil
}

// Cancel stops the attempt's scope and returns once every process in it is gone.
func (c *Cold) Cancel(attemptID string) (CancelResult, bool) {
	c.mu.Lock()
	r := c.runs[attemptID]
	c.mu.Unlock()
	if r == nil {
		return CancelResult{}, false
	}
	r.mu.Lock()
	r.cancelled = true
	r.mu.Unlock()
	c.stop(r)
	<-r.done
	return CancelResult{}, true
}

// Liveness samples the attempt's cumulative CPU time: its scope, plus the
// scopes dsh makes for tool commands.
func (c *Cold) Liveness(attemptID string) Liveness {
	c.mu.Lock()
	r := c.runs[attemptID]
	c.mu.Unlock()
	if r == nil {
		return Liveness{}
	}
	cpu := scopeCPU(r.unit)
	r.mu.Lock()
	engine := r.run.Engine
	r.mu.Unlock()
	if engine == "dsh" {
		cpu += r.toolCPU()
	}
	return Liveness{Known: true, Process: true, CPUNSec: cpu}
}

func scopeCPU(unit string) uint64 {
	if strings.HasPrefix(unit, "pid:") {
		return 0
	}
	out, err := exec.Command("systemctl", "--user", "show", unit+".scope", "-p", "CPUUsageNSec", "--value").Output()
	if err != nil {
		return 0
	}
	n, _ := strconv.ParseUint(strings.TrimSpace(string(out)), 10, 64)
	return n
}

func scopeActive(unit string) bool {
	if pid, ok := strings.CutPrefix(unit, "pid:"); ok {
		n, _ := strconv.Atoi(pid)
		return n > 0 && syscall.Kill(-n, 0) == nil
	}
	out, _ := exec.Command("systemctl", "--user", "is-active", unit+".scope").Output()
	state := strings.TrimSpace(string(out))
	return state == "active" || state == "activating" || state == "deactivating"
}

// stopScope terminates every process of a scope: SIGTERM, then SIGKILL after five seconds.
func stopScope(unit string) {
	if pid, ok := strings.CutPrefix(unit, "pid:"); ok {
		n, _ := strconv.Atoi(pid)
		if n <= 0 {
			return
		}
		_ = syscall.Kill(-n, syscall.SIGTERM)
		for i := 0; i < 50 && syscall.Kill(-n, 0) == nil; i++ {
			time.Sleep(100 * time.Millisecond)
		}
		_ = syscall.Kill(-n, syscall.SIGKILL)
		return
	}
	scope := unit + ".scope"
	_ = exec.Command("systemctl", "--user", "kill", "-s", "SIGTERM", "--kill-whom=all", scope).Run()
	for i := 0; i < 50 && scopeActive(unit); i++ {
		time.Sleep(100 * time.Millisecond)
	}
	if scopeActive(unit) {
		_ = exec.Command("systemctl", "--user", "kill", "-s", "SIGKILL", "--kill-whom=all", scope).Run()
		for i := 0; i < 30 && scopeActive(unit); i++ {
			time.Sleep(100 * time.Millisecond)
		}
		_ = exec.Command("systemctl", "--user", "stop", scope).Run()
	}
}

func (c *Cold) stop(r *coldRun) {
	stopScope(r.unit)
	r.mu.Lock()
	if r.fifo != nil {
		r.fifo.Close()
		r.fifo = nil
	}
	r.mu.Unlock()
}

type exitRecord struct {
	PID  int `json:"pid"`
	Code int `json:"code"`
}

func readExit(path string) (exitRecord, bool) {
	body, err := os.ReadFile(path)
	if err != nil {
		return exitRecord{}, false
	}
	var rec exitRecord
	if json.Unmarshal(body, &rec) != nil {
		return exitRecord{}, false
	}
	return rec, true
}

// watch follows a run's files until its process is gone.
func (c *Cold) watch(r *coldRun) {
	defer close(r.done)
	defer func() {
		r.mu.Lock()
		attempt, pkg := r.run.AttemptID, r.run.PackageID
		r.mu.Unlock()
		c.mu.Lock()
		if c.runs[attempt] == r {
			delete(c.runs, attempt)
		}
		if c.standbys[pkg] == r {
			delete(c.standbys, pkg)
		}
		c.mu.Unlock()
		r.mu.Lock()
		if r.fifo != nil {
			r.fifo.Close()
			r.fifo = nil
		}
		r.mu.Unlock()
	}()
	watcher := newDirWatch(r.dir)
	defer watcher.close()
	r.mu.Lock()
	kind := r.run.Engine
	r.mu.Unlock()
	norm := newNormalizer(kind)
	lines := &lineReader{path: r.path("stdout.jsonl")}
	var killAt, lastAlive time.Time
	var killNote string
	killed := false
	replay := r.replay

	for {
		r.mu.Lock()
		id := r.run.AttemptID
		released, cancelled := r.released, r.cancelled
		announceHanded := false
		if released && !r.handed {
			if _, err := os.Stat(r.path("started")); err == nil {
				r.handed, announceHanded = true, true
			}
		}
		r.mu.Unlock()
		if announceHanded {
			c.sink.Handed(id, r.mode, r.unit)
		}
		for _, line := range lines.read() {
			sig := norm.push(line)
			r.mu.Lock()
			if sig.started {
				r.sawStart = true
			}
			released = r.released
			announce := released && r.sawStart && !r.started
			if announce {
				r.started = true
			}
			r.mu.Unlock()
			if !released {
				continue
			}
			if announce || (sig.started && !replay) {
				c.sink.Started(id, norm.session)
			}
			if sig.output {
				c.sink.Output(id)
			} else {
				c.sink.Alive(id)
			}
			if !replay {
				for _, note := range sig.notes {
					c.sink.Note(id, clip(note, noteMax))
				}
			}
		}
		replay = false

		if released && !cancelled && !r.finished && norm.succeeded() {
			r.finished = true
			c.sink.Finished(id, Outcome{Success: true, Text: norm.result(), InputTokens: norm.in, OutputTokens: norm.out})
			if r.mode == ModeStandby {
				// A standby process waits for more input forever; ending it is the normal path.
				go c.stop(r)
			} else {
				killAt, killNote = time.Now().Add(exitGrace), fmt.Sprintf("给出结果后 %d 秒仍未退出，已结束进程", int(exitGrace.Seconds()))
			}
		}
		if released && !cancelled && !r.finished && norm.failure != "" && killAt.IsZero() {
			killAt = time.Now().Add(failureGrace)
		}

		exit, exitKnown := readExit(r.path("exit.json"))
		alive := true
		if !exitKnown {
			select {
			case <-r.exited:
				alive = false
			default:
				// A process started by an earlier service instance has no wait handle.
				if r.exited == nil && time.Since(lastAlive) > 2*time.Second {
					lastAlive = time.Now()
					alive = scopeActive(r.unit)
				}
			}
		}
		if exitKnown || !alive {
			// Take whatever was written between the last read and the exit.
			for _, line := range lines.read() {
				norm.push(line)
			}
			if !exitKnown {
				exit, exitKnown = readExit(r.path("exit.json"))
			}
			r.mu.Lock()
			r.gone = true
			released, cancelled = r.released, r.cancelled
			r.mu.Unlock()
			if !released || cancelled {
				return
			}
			if exitKnown {
				c.exitCode(id, exit.Code)
			}
			switch {
			case r.finished:
				if exitKnown && exit.Code != 0 && r.mode != ModeStandby && !killed {
					c.sink.Anomaly(id, fmt.Sprintf("进程在给出结果后以退出码 %d 结束", exit.Code))
				}
			case norm.succeeded():
				r.finished = true
				c.sink.Finished(id, Outcome{Success: true, Text: norm.result(), InputTokens: norm.in, OutputTokens: norm.out})
				if exitKnown && exit.Code != 0 {
					c.sink.Anomaly(id, fmt.Sprintf("进程在给出结果后以退出码 %d 结束", exit.Code))
				}
			default:
				r.finished = true
				c.sink.Finished(id, c.failure(r, norm, exit, exitKnown))
			}
			return
		}
		if !killAt.IsZero() && time.Now().After(killAt) {
			killAt, killed = time.Time{}, true
			if r.finished && killNote != "" {
				c.sink.Anomaly(id, killNote)
			}
			go c.stop(r)
		}
		if !released && time.Since(r.bornAt) > standbyTTL {
			r.mu.Lock()
			r.cancelled = true
			r.mu.Unlock()
			go c.stop(r)
		}
		watcher.wait(200 * time.Millisecond)
	}
}

func (c *Cold) exitCode(attemptID string, code int) {
	if reporter, ok := c.sink.(interface{ ExitCode(string, int) }); ok {
		reporter.ExitCode(attemptID, code)
	}
}

// failure builds the terminal report of a run that ended without a result.
func (c *Cold) failure(r *coldRun, norm *normalizer, exit exitRecord, exitKnown bool) Outcome {
	o := Outcome{Text: norm.result(), InputTokens: norm.in, OutputTokens: norm.out}
	if exitKnown {
		code := exit.Code
		o.ExitCode = &code
	}
	stderr := ""
	if body, err := os.ReadFile(r.path("stderr.log")); err == nil {
		stderr = strings.TrimSpace(Redact(lastBytes(string(body), 2048)))
	}
	now := time.Now()
	for _, text := range []string{norm.failureDetail, stderr} {
		if text == "" {
			continue
		}
		if kind, retryAt := classify(norm.engine, text, now); kind != "" {
			o.FailureKind, o.FailureMessage, o.RetryAt = kind, clip(vendorMessage(text), 1900), retryAt
			return o
		}
	}
	switch {
	case norm.failure != "":
		o.FailureKind = FailVendor
		o.FailureMessage = norm.failureDetail
		if o.FailureMessage == "" {
			o.FailureMessage = "引擎报告 " + norm.failure
		}
	case norm.truncated():
		o.FailureKind, o.FailureMessage = FailVendor, "回复因输出长度上限被截断"
	case !exitKnown:
		o.FailureKind, o.FailureMessage = FailLost, "进程被终止，没有留下退出记录"
	case exit.Code != 0:
		o.FailureKind, o.FailureMessage = FailVendor, fmt.Sprintf("进程以退出码 %d 结束", exit.Code)
	default:
		o.FailureKind, o.FailureMessage = FailNoResult, "引擎正常退出，但没有给出最终回复"
	}
	if stderr != "" && norm.failureDetail == "" {
		o.FailureMessage += "：" + clip(lastLines(stderr, 6), 1200)
	}
	return o
}

func lastLines(s string, n int) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n")
}

// lineReader returns the complete lines appended to a file since the last call.
type lineReader struct {
	path    string
	offset  int64
	partial []byte
}

const maxLine = 8 << 20

func (l *lineReader) read() []string {
	f, err := os.Open(l.path)
	if err != nil {
		return nil
	}
	defer f.Close()
	var out []string
	buf := make([]byte, 64<<10)
	for {
		n, err := f.ReadAt(buf, l.offset)
		if n > 0 {
			l.offset += int64(n)
			data := buf[:n]
			for {
				i := strings.IndexByte(string(data), '\n')
				if i < 0 {
					break
				}
				l.partial = append(l.partial, data[:i]...)
				out = append(out, string(l.partial))
				l.partial = l.partial[:0]
				data = data[i+1:]
			}
			l.partial = append(l.partial, data...)
			if len(l.partial) > maxLine {
				// A line this long is not an event; drop it rather than grow without bound.
				l.partial = l.partial[:0]
			}
		}
		if err != nil || n == 0 {
			return out
		}
	}
}

// dirWatch wakes a watcher when files in a directory change, with a timeout as a safety net.
type dirWatch struct{ f *os.File }

func newDirWatch(dir string) *dirWatch {
	fd, err := syscall.InotifyInit1(syscall.IN_NONBLOCK | syscall.IN_CLOEXEC)
	if err != nil {
		return &dirWatch{}
	}
	if _, err := syscall.InotifyAddWatch(fd, dir, syscall.IN_MODIFY|syscall.IN_CREATE|syscall.IN_MOVED_TO|syscall.IN_CLOSE_WRITE); err != nil {
		syscall.Close(fd)
		return &dirWatch{}
	}
	return &dirWatch{f: os.NewFile(uintptr(fd), "inotify")}
}

func (w *dirWatch) wait(max time.Duration) {
	if w.f == nil {
		time.Sleep(min(max, 20*time.Millisecond))
		return
	}
	_ = w.f.SetReadDeadline(time.Now().Add(max))
	var buf [4096]byte
	_, err := w.f.Read(buf[:])
	if err != nil && !errors.Is(err, os.ErrDeadlineExceeded) {
		time.Sleep(20 * time.Millisecond)
	}
}

func (w *dirWatch) close() {
	if w.f != nil {
		w.f.Close()
	}
}
