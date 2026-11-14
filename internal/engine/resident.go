package engine

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

// ResidentRecord is the persisted identity of a resident engine server, so a
// restarted service can find the server it left running.
type ResidentRecord struct {
	AccountID string
	Unit      string
	Port      int
	Secret    string
	Dir       string
	StartedAt int64
}

// ResidentStore persists resident server records.
type ResidentStore interface {
	SaveResident(ResidentRecord) error
	DeleteResident(accountID string) error
	Residents() ([]ResidentRecord, error)
}

// Resident keeps one `opencode serve` per account and runs each attempt as a
// session on it. The server lives in its own scope and outlives the service.
type Resident struct {
	sink  Sink
	log   *slog.Logger
	home  string
	store ResidentStore

	mu      sync.Mutex
	servers map[string]*ocServer // by account ID
	runs    map[string]*ocRun    // by attempt ID
}

func NewResident(sink Sink, log *slog.Logger, home string, store ResidentStore) *Resident {
	return &Resident{sink: sink, log: log, home: home, store: store, servers: map[string]*ocServer{}, runs: map[string]*ocRun{}}
}

type ocServer struct {
	account Account
	rec     ResidentRecord
	base    string
	client  *http.Client

	mu       sync.Mutex
	label    string // the account's display name, refreshed by Ensure
	state    string // starting | ready | down
	reason   string
	sessions map[string]*ocRun
	warmed   map[string]bool // workspaces whose project state the server has loaded
	cancel   context.CancelFunc
}

type ocRun struct {
	run     Run
	server  *ocServer
	session string

	mu        sync.Mutex
	handed    bool
	started   bool // execution.started arrived
	announced bool // Started was reported
	finished  bool
	cancelled bool
	segments  []string
	tools     map[string]string
	in, out   int
}

// ResidentStatus describes one account's resident server.
type ResidentStatus struct {
	AccountID string `json:"accountId"`
	State     string `json:"state"`
	Reason    string `json:"reason,omitempty"`
	Unit      string `json:"unit,omitempty"`
	Port      int    `json:"port,omitempty"`
	Sessions  int    `json:"sessions"`
	StartedAt int64  `json:"startedAt,omitempty"`
}

// Status lists the resident servers.
func (r *Resident) Status() []ResidentStatus {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := []ResidentStatus{}
	for id, srv := range r.servers {
		srv.mu.Lock()
		out = append(out, ResidentStatus{AccountID: id, State: srv.state, Reason: srv.reason, Unit: srv.rec.Unit, Port: srv.rec.Port, Sessions: len(srv.sessions), StartedAt: srv.rec.StartedAt})
		srv.mu.Unlock()
	}
	return out
}

func (s *ocServer) do(ctx context.Context, method, path string, body any, into any) error {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(encoded)
	}
	req, err := http.NewRequestWithContext(ctx, method, s.base+path, reader)
	if err != nil {
		return err
	}
	req.SetBasicAuth("opencode", s.rec.Secret)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if resp.StatusCode >= 300 {
		return fmt.Errorf("opencode %s %s: HTTP %d %s", method, path, resp.StatusCode, clip(Redact(string(data)), 300))
	}
	if into != nil && len(data) > 0 {
		return json.Unmarshal(data, into)
	}
	return nil
}

func (s *ocServer) call(method, path string, body, into any) error {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	return s.do(ctx, method, path, body, into)
}

func (s *ocServer) alive() bool {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	return s.do(ctx, "GET", "/api/info", nil, nil) == nil
}

func newServer(a Account, rec ResidentRecord) *ocServer {
	return &ocServer{account: a, label: a.Label, rec: rec, base: fmt.Sprintf("http://127.0.0.1:%d", rec.Port), client: &http.Client{}, state: "starting", sessions: map[string]*ocRun{}, warmed: map[string]bool{}}
}

func residentUnit(accountID string) string { return unitFor("oc-" + accountID) }

// Resume adopts the servers a previous service instance left running.
// Records whose server no longer answers are dropped and their scope stopped.
func (r *Resident) Resume(account func(id string) (Account, error)) {
	records, err := r.store.Residents()
	if err != nil {
		r.log.Error("load residents failed", "err", err)
		return
	}
	for _, rec := range records {
		a, err := account(rec.AccountID)
		srv := newServer(a, rec)
		if err != nil || !srv.alive() {
			stopScope(rec.Unit)
			_ = r.store.DeleteResident(rec.AccountID)
			continue
		}
		srv.state = "ready"
		r.mu.Lock()
		r.servers[rec.AccountID] = srv
		r.mu.Unlock()
		go r.events(srv)
	}
}

// Ensure starts the account's server in the background unless it is already up or starting.
func (r *Resident) Ensure(a Account) {
	if a.Engine != "opencode" || a.Kind != "subscription" {
		return
	}
	r.mu.Lock()
	if srv := r.servers[a.ID]; srv != nil {
		srv.mu.Lock()
		state := srv.state
		if state != "down" {
			srv.label = a.Label // the account may have been renamed
		}
		srv.mu.Unlock()
		if state != "down" {
			r.mu.Unlock()
			return
		}
	}
	srv := newServer(a, ResidentRecord{AccountID: a.ID, Unit: residentUnit(a.ID)})
	r.servers[a.ID] = srv
	r.mu.Unlock()
	go r.start(srv)
}

func (r *Resident) start(srv *ocServer) {
	fail := func(err error) {
		srv.mu.Lock()
		srv.state, srv.reason = "down", err.Error()
		srv.mu.Unlock()
		r.log.Warn("resident start failed", "account", srv.account.ID, "err", err)
	}
	bin, err := exec.LookPath("opencode")
	if err != nil {
		fail(errors.New("本机没有安装 opencode"))
		return
	}
	dir := filepath.Join(r.home, "residents", srv.account.ID)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		fail(err)
		return
	}
	env, err := opencodeEnv(srv.account, "", dir)
	if err != nil {
		fail(err)
		return
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		fail(err)
		return
	}
	port := listener.Addr().(*net.TCPAddr).Port
	listener.Close()
	var raw [24]byte
	if _, err := rand.Read(raw[:]); err != nil {
		fail(err)
		return
	}
	secret := base64.RawURLEncoding.EncodeToString(raw[:])
	env["OPENCODE_SERVER_PASSWORD"] = secret
	logFile, err := os.OpenFile(filepath.Join(dir, "server.log"), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		fail(err)
		return
	}
	defer logFile.Close()
	unit := residentUnit(srv.account.ID)
	stopScope(unit) // a leftover from a crashed start would hold the unit name
	cmd := exec.Command("systemd-run", "--user", "--scope", "--collect", "--quiet", "--unit="+unit, "--working-directory="+dir,
		"-p", "KillMode=control-group", "-p", "MemoryHigh=8G", "-p", "MemoryMax=10G", "--",
		bin, "serve", "--port", fmt.Sprint(port), "--hostname", "127.0.0.1")
	cmd.Dir = dir
	cmd.Env = CleanEnv(env)
	cmd.Stdout, cmd.Stderr = logFile, logFile
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		fail(fmt.Errorf("无法启动 opencode 常驻服务：%w", err))
		return
	}
	exited := make(chan struct{})
	go func() { _ = cmd.Wait(); close(exited) }()

	srv.mu.Lock()
	srv.rec = ResidentRecord{AccountID: srv.account.ID, Unit: unit, Port: port, Secret: secret, Dir: dir, StartedAt: time.Now().UnixMilli()}
	srv.base = fmt.Sprintf("http://127.0.0.1:%d", port)
	srv.mu.Unlock()
	deadline := time.Now().Add(30 * time.Second)
	for !srv.alive() {
		select {
		case <-exited:
			fail(errors.New("opencode 常驻服务启动后立即退出，详见 " + filepath.Join(dir, "server.log")))
			return
		case <-time.After(50 * time.Millisecond):
		}
		if time.Now().After(deadline) {
			stopScope(unit)
			fail(errors.New("opencode 常驻服务 30 秒内没有就绪"))
			return
		}
	}
	if err := r.store.SaveResident(srv.rec); err != nil {
		r.log.Error("save resident failed", "err", err)
	}
	srv.mu.Lock()
	srv.state, srv.reason = "ready", ""
	srv.mu.Unlock()
	r.log.Info("resident ready", "account", srv.account.ID, "port", port)
	go r.events(srv)
	// Loading any location also loads the server-wide provider and model state.
	go r.warm(srv, dir)
}

// Warm makes every ready server load a workspace's project state ahead of the
// first session there. Without it, the first prompt in a directory waits for
// that load: about 100 ms on a running server, 300 ms on a fresh one.
func (r *Resident) Warm(workspace string) {
	if workspace == "" {
		return
	}
	r.mu.Lock()
	servers := make([]*ocServer, 0, len(r.servers))
	for _, srv := range r.servers {
		servers = append(servers, srv)
	}
	r.mu.Unlock()
	for _, srv := range servers {
		go r.warm(srv, workspace)
	}
}

func (r *Resident) warm(srv *ocServer, workspace string) {
	srv.mu.Lock()
	skip := srv.state != "ready" || srv.warmed[workspace]
	if !skip {
		srv.warmed[workspace] = true
	}
	srv.mu.Unlock()
	if skip {
		return
	}
	query := "?location[directory]=" + url.QueryEscape(workspace)
	for _, path := range []string{"/api/agent", "/api/provider"} {
		if err := srv.call("GET", path+query, nil, nil); err != nil {
			srv.mu.Lock()
			delete(srv.warmed, workspace)
			srv.mu.Unlock()
			return
		}
	}
}

// Stop shuts an account's server down. Sessions still on it fail.
func (r *Resident) Stop(accountID string) bool {
	r.mu.Lock()
	srv := r.servers[accountID]
	delete(r.servers, accountID)
	r.mu.Unlock()
	if srv == nil {
		return false
	}
	r.retire(srv, "opencode 常驻服务被手动停止")
	return true
}

// retire marks a server down, fails its sessions and stops its scope.
func (r *Resident) retire(srv *ocServer, reason string) {
	srv.mu.Lock()
	if srv.state == "down" {
		srv.mu.Unlock()
		return
	}
	srv.state, srv.reason = "down", reason
	if srv.cancel != nil {
		srv.cancel()
	}
	var lost []*ocRun
	for _, run := range srv.sessions {
		lost = append(lost, run)
	}
	srv.sessions = map[string]*ocRun{}
	unit := srv.rec.Unit
	label := srv.label
	srv.mu.Unlock()
	_ = r.store.DeleteResident(srv.account.ID)
	if label == "" {
		label = srv.account.ID
	}
	for _, run := range lost {
		r.forget(run)
		run.mu.Lock()
		skip := run.finished || run.cancelled
		run.finished = true
		run.mu.Unlock()
		if !skip {
			r.sink.Finished(run.run.AttemptID, Outcome{FailureKind: FailLost, FailureMessage: fmt.Sprintf("账号「%s」的 %s，这次运行随之中断", label, reason)})
		}
	}
	stopScope(unit)
}

func (r *Resident) forget(run *ocRun) {
	r.mu.Lock()
	if r.runs[run.run.AttemptID] == run {
		delete(r.runs, run.run.AttemptID)
	}
	r.mu.Unlock()
	run.server.mu.Lock()
	delete(run.server.sessions, run.session)
	run.server.mu.Unlock()
}

// events follows the server's event stream. When the stream breaks and the
// server no longer answers, every session on it fails and a new server is
// started for the account.
func (r *Resident) events(srv *ocServer) {
	ctx, cancel := context.WithCancel(context.Background())
	srv.mu.Lock()
	srv.cancel = cancel
	srv.mu.Unlock()
	defer cancel()
	for {
		err := r.stream(ctx, srv)
		if ctx.Err() != nil {
			return
		}
		if !srv.alive() {
			time.Sleep(300 * time.Millisecond)
			if !srv.alive() {
				r.log.Warn("resident lost", "account", srv.account.ID, "err", err)
				r.retire(srv, "opencode 常驻服务进程已退出")
				r.mu.Lock()
				current := r.servers[srv.account.ID] == srv
				r.mu.Unlock()
				if current {
					r.Ensure(srv.account)
				}
				return
			}
		}
		// The stream dropped but the server is fine: events may have been
		// missed, so settle every session against the server's own record.
		r.reconcile(srv)
		time.Sleep(200 * time.Millisecond)
	}
}

func (r *Resident) stream(ctx context.Context, srv *ocServer) error {
	req, err := http.NewRequestWithContext(ctx, "GET", srv.base+"/api/event", nil)
	if err != nil {
		return err
	}
	req.SetBasicAuth("opencode", srv.rec.Secret)
	req.Header.Set("Accept", "text/event-stream")
	resp, err := srv.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("event stream: HTTP %d", resp.StatusCode)
	}
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 64<<10), 16<<20)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		var ev struct {
			Type string          `json:"type"`
			Data json.RawMessage `json:"data"`
		}
		if json.Unmarshal([]byte(strings.TrimSpace(line[5:])), &ev) != nil || ev.Type == "" {
			continue
		}
		r.handle(srv, ev.Type, ev.Data)
	}
	return scanner.Err()
}

type ocEventData struct {
	ID        string `json:"id"`
	SessionID string `json:"sessionID"`
	Name      string `json:"name"`
	Text      string `json:"text"`
	Message   string `json:"message"`
	Reason    string `json:"reason"`
	Tokens    *struct {
		Input  int `json:"input"`
		Output int `json:"output"`
	} `json:"tokens"`
	Error json.RawMessage `json:"error"`
}

func (r *Resident) handle(srv *ocServer, kind string, raw json.RawMessage) {
	var d ocEventData
	if json.Unmarshal(raw, &d) != nil || d.SessionID == "" {
		return
	}
	srv.mu.Lock()
	run := srv.sessions[d.SessionID]
	srv.mu.Unlock()
	if run == nil {
		return
	}
	id := run.run.AttemptID
	switch kind {
	case "session.execution.started":
		run.mu.Lock()
		run.started = true
		announce := run.handed && !run.announced
		if announce {
			run.announced = true
		}
		run.mu.Unlock()
		if announce {
			r.sink.Started(id, run.session)
		}
	case "session.text.delta", "session.reasoning.delta", "session.tool.input.delta":
		r.sink.Output(id)
	case "session.text.ended":
		run.mu.Lock()
		if strings.TrimSpace(d.Text) != "" {
			run.segments = append(run.segments, d.Text)
		}
		run.mu.Unlock()
		r.sink.Output(id)
	case "session.tool.input.started":
		run.mu.Lock()
		if run.tools == nil {
			run.tools = map[string]string{}
		}
		if len(run.tools) < 500 {
			run.tools[d.ID] = d.Name
		}
		run.mu.Unlock()
		r.sink.Output(id)
		r.sink.Note(id, toolNote(d.Name, "开始"))
	case "session.tool.success", "session.tool.failed":
		run.mu.Lock()
		name := run.tools[d.ID]
		run.mu.Unlock()
		status := "完成"
		if kind == "session.tool.failed" {
			status = "失败"
		}
		r.sink.Note(id, toolNote(name, status))
	case "session.usage.updated":
		run.mu.Lock()
		if d.Tokens != nil {
			run.in, run.out = d.Tokens.Input, d.Tokens.Output
		}
		run.mu.Unlock()
		r.sink.Alive(id)
	case "session.retry.scheduled", "session.step.failed":
		detail := d.Message
		if detail == "" {
			detail = errorText(d.Error)
		}
		note := "引擎在重试"
		if kind == "session.step.failed" {
			note = "一步执行失败"
		}
		if detail != "" {
			note += "：" + clip(vendorMessage(detail), 300)
		}
		r.sink.Note(id, note)
	case "permission.asked":
		// Sessions are created with an allow-all ruleset; answer anyway so a
		// permission prompt can never leave an unattended run waiting.
		go func() {
			_ = srv.call("POST", "/api/session/"+d.SessionID+"/permission/"+d.ID+"/reply", map[string]any{"decision": "always"}, nil)
		}()
	case "session.execution.succeeded":
		go r.finish(run, "succeeded", "")
	case "session.execution.failed":
		go r.finish(run, "failed", errorText(d.Error))
	case "session.execution.interrupted":
		go r.finish(run, "interrupted", d.Reason)
	default:
		r.sink.Alive(id)
	}
}

// errorText pulls a readable message out of opencode's error payloads.
func errorText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return text
	}
	var shaped struct {
		Message string `json:"message"`
		Name    string `json:"name"`
		Type    string `json:"type"`
		Data    struct {
			Message string `json:"message"`
		} `json:"data"`
	}
	if json.Unmarshal(raw, &shaped) == nil {
		for _, s := range []string{shaped.Message, shaped.Data.Message, shaped.Name, shaped.Type} {
			if s != "" {
				// Keep the whole payload: retry hints and status codes live beside the message.
				return s + " " + clip(string(raw), 1500)
			}
		}
	}
	return clip(string(raw), 1500)
}

// transcript reads the assistant text of a session from the server, oldest first.
func (r *Resident) transcript(run *ocRun) (string, bool) {
	var page struct {
		Data []struct {
			Type    string `json:"type"`
			Content []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
		} `json:"data"`
	}
	if err := run.server.call("GET", "/api/session/"+run.session+"/message", nil, &page); err != nil {
		return "", false
	}
	var parts []string
	for i := len(page.Data) - 1; i >= 0; i-- {
		if page.Data[i].Type != "assistant" {
			continue
		}
		for _, c := range page.Data[i].Content {
			if c.Type == "text" && strings.TrimSpace(c.Text) != "" {
				parts = append(parts, c.Text)
			}
		}
	}
	return strings.Join(parts, "\n"), true
}

func (r *Resident) finish(run *ocRun, outcome, detail string) {
	run.mu.Lock()
	if run.finished || run.cancelled {
		run.mu.Unlock()
		return
	}
	run.finished = true
	segments := strings.Join(run.segments, "\n")
	in, out := run.in, run.out
	run.mu.Unlock()
	id := run.run.AttemptID
	o := Outcome{InputTokens: in, OutputTokens: out}
	// The server's own record is complete even when this service missed events.
	text, ok := r.transcript(run)
	if !ok || strings.TrimSpace(text) == "" {
		text = segments
	}
	text = strings.TrimSpace(Redact(text))
	if len(text) > resultMax {
		text = "[前面的回复已省略，只保留最后一段]\n" + lastBytes(text, resultMax)
	}
	o.Text = text
	switch {
	case outcome == "succeeded" && text != "":
		o.Success = true
	case outcome == "succeeded":
		o.FailureKind, o.FailureMessage = FailNoResult, "会话结束，但没有给出最终回复"
	case outcome == "interrupted":
		o.FailureKind, o.FailureMessage = FailVendor, "会话被中断"
		if detail != "" {
			o.FailureMessage += "（" + detail + "）"
		}
	default:
		o.FailureKind, o.FailureMessage = FailVendor, "会话执行失败"
		if detail != "" {
			if kind, retryAt := classify("opencode", detail, time.Now()); kind != "" {
				o.FailureKind, o.RetryAt = kind, retryAt
			}
			o.FailureMessage = clip(vendorMessage(detail), 1900)
		}
	}
	r.forget(run)
	r.sink.Finished(id, o)
	_ = run.server.call("DELETE", "/api/session/"+run.session, nil, nil)
}

// reconcile settles sessions whose terminal event may have been missed.
func (r *Resident) reconcile(srv *ocServer) {
	var active struct {
		Data map[string]json.RawMessage `json:"data"`
	}
	if err := srv.call("GET", "/api/session/active", nil, &active); err != nil {
		return
	}
	srv.mu.Lock()
	var idle []*ocRun
	for id, run := range srv.sessions {
		if _, running := active.Data[id]; !running {
			idle = append(idle, run)
		}
	}
	srv.mu.Unlock()
	for _, run := range idle {
		run.mu.Lock()
		handed := run.handed
		run.mu.Unlock()
		if !handed {
			continue // the prompt is still being submitted
		}
		var info struct {
			Data struct {
				Outcome string `json:"outcome"`
			} `json:"data"`
		}
		if err := srv.call("GET", "/api/session/"+run.session, nil, &info); err != nil {
			go r.finish(run, "failed", "会话在引擎上已不存在")
			continue
		}
		switch info.Data.Outcome {
		case "":
			// Not started yet, or between steps: leave it to the event stream.
		case "succeeded":
			go r.finish(run, "succeeded", "")
		default:
			go r.finish(run, info.Data.Outcome, "")
		}
	}
}

// Ready reports whether the account's server can take a session now.
func (r *Resident) Ready(accountID string) bool {
	r.mu.Lock()
	srv := r.servers[accountID]
	r.mu.Unlock()
	if srv == nil {
		return false
	}
	srv.mu.Lock()
	defer srv.mu.Unlock()
	return srv.state == "ready"
}

// Launch runs the attempt as a session on the account's server. It reports
// false, having started nothing, when the server cannot take it.
func (r *Resident) Launch(run Run) bool {
	r.mu.Lock()
	srv := r.servers[run.Account.ID]
	r.mu.Unlock()
	if srv == nil {
		return false
	}
	srv.mu.Lock()
	ready := srv.state == "ready"
	srv.mu.Unlock()
	if !ready {
		return false
	}
	provider, model, ok := strings.Cut(run.Model, "/")
	if !ok {
		return false
	}
	ref := map[string]any{"providerID": provider, "id": model}
	if run.Effort != "" {
		ref["variant"] = run.Effort
	}
	var created struct {
		Data struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	err := srv.call("POST", "/api/session", map[string]any{
		"title":       clip("weaver "+run.Title, 120),
		"location":    map[string]any{"directory": run.Workspace},
		"model":       ref,
		"permissions": []any{map[string]any{"action": "*", "resource": "*", "effect": "allow"}},
	}, &created)
	if err != nil || created.Data.ID == "" {
		r.log.Warn("resident session create failed", "attempt", run.AttemptID, "err", err)
		return false
	}
	or := &ocRun{run: run, server: srv, session: created.Data.ID}
	srv.mu.Lock()
	if srv.state != "ready" {
		srv.mu.Unlock()
		return false
	}
	srv.sessions[or.session] = or
	srv.warmed[run.Workspace] = true
	srv.mu.Unlock()
	r.mu.Lock()
	r.runs[run.AttemptID] = or
	r.mu.Unlock()
	if err := srv.call("POST", "/api/session/"+or.session+"/prompt", map[string]any{"text": run.Instruction}, nil); err != nil {
		r.log.Warn("resident prompt failed", "attempt", run.AttemptID, "err", err)
		or.mu.Lock()
		or.cancelled = true
		or.mu.Unlock()
		r.forget(or)
		_ = srv.call("DELETE", "/api/session/"+or.session, nil, nil)
		return false
	}
	or.mu.Lock()
	or.handed = true
	announce := or.started && !or.announced
	if announce {
		or.announced = true
	}
	or.mu.Unlock()
	r.sink.Handed(run.AttemptID, ModeResident, srv.rec.Unit)
	if announce {
		r.sink.Started(run.AttemptID, or.session)
	}
	return true
}

// Reattach resumes an attempt whose session was started by an earlier service
// instance. It reports false when the session cannot be found.
func (r *Resident) Reattach(run Run, session string) bool {
	r.mu.Lock()
	srv := r.servers[run.Account.ID]
	r.mu.Unlock()
	if srv == nil || session == "" {
		return false
	}
	srv.mu.Lock()
	ready := srv.state == "ready"
	srv.mu.Unlock()
	if !ready {
		return false
	}
	or := &ocRun{run: run, server: srv, session: session, handed: true, started: true, announced: true}
	srv.mu.Lock()
	srv.sessions[session] = or
	srv.mu.Unlock()
	r.mu.Lock()
	r.runs[run.AttemptID] = or
	r.mu.Unlock()
	go r.reconcile(srv)
	return true
}

// Cancel interrupts the attempt's session. The server cannot isolate the
// processes a session started, so the result says they may remain.
func (r *Resident) Cancel(attemptID string) (CancelResult, bool) {
	r.mu.Lock()
	run := r.runs[attemptID]
	r.mu.Unlock()
	if run == nil {
		return CancelResult{}, false
	}
	run.mu.Lock()
	run.cancelled = true
	run.mu.Unlock()
	res := CancelResult{Residual: true, Workspace: run.run.Workspace}
	if err := run.server.call("POST", "/api/session/"+run.session+"/interrupt", nil, nil); err != nil {
		res.Detail = "中断请求失败：" + clip(err.Error(), 200)
	}
	r.forget(run)
	go func() {
		time.Sleep(time.Second)
		_ = run.server.call("DELETE", "/api/session/"+run.session, nil, nil)
	}()
	return res, true
}

// Liveness: a session has no process of its own to sample.
func (r *Resident) Liveness(attemptID string) Liveness {
	r.mu.Lock()
	defer r.mu.Unlock()
	return Liveness{Known: r.runs[attemptID] != nil}
}
