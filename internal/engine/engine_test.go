package engine

import (
	"bufio"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// recorder is a Sink that remembers every report with the time it arrived.
type recorder struct {
	mu       sync.Mutex
	handed   map[string]string
	started  map[string]bool
	notes    []string
	finished map[string]Outcome
	at       map[string]time.Time
	anomaly  []string
	exit     map[string]int
}

func newRecorder() *recorder {
	return &recorder{handed: map[string]string{}, started: map[string]bool{}, finished: map[string]Outcome{}, at: map[string]time.Time{}, exit: map[string]int{}}
}
func (r *recorder) Handed(id, mode, unit string) { r.mu.Lock(); r.handed[id] = mode; r.mu.Unlock() }
func (r *recorder) Started(id, session string)   { r.mu.Lock(); r.started[id] = true; r.mu.Unlock() }
func (r *recorder) Alive(string)                 {}
func (r *recorder) Output(string)                {}
func (r *recorder) Note(id, m string)            { r.mu.Lock(); r.notes = append(r.notes, m); r.mu.Unlock() }
func (r *recorder) Anomaly(id, m string) {
	r.mu.Lock()
	r.anomaly = append(r.anomaly, m)
	r.mu.Unlock()
}
func (r *recorder) ExitCode(id string, code int) { r.mu.Lock(); r.exit[id] = code; r.mu.Unlock() }
func (r *recorder) Finished(id string, o Outcome) {
	r.mu.Lock()
	r.finished[id], r.at[id] = o, time.Now()
	r.mu.Unlock()
}

func (r *recorder) waitFinished(t *testing.T, id string, within time.Duration) Outcome {
	t.Helper()
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		r.mu.Lock()
		o, ok := r.finished[id]
		r.mu.Unlock()
		if ok {
			return o
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("attempt %s did not finish within %s", id, within)
	return Outcome{}
}

func (r *recorder) waitFor(t *testing.T, what string, within time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		r.mu.Lock()
		ok := cond()
		r.mu.Unlock()
		if ok {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

// scripted replaces an engine's command with a shell script for the duration of a test.
func scripted(t *testing.T, kind, script string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "engine.sh")
	if err := os.WriteFile(path, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	original := specs[kind]
	specs[kind] = &spec{bin: "sh",
		argv:    func(c *launchCtx) ([]string, error) { return []string{"sh", path}, nil },
		prepare: func(c *launchCtx) error { return nil }, ready: original.ready}
	t.Cleanup(func() { specs[kind] = original })
}

func newCold(t *testing.T) (*Cold, *recorder) {
	sink := newRecorder()
	cold := NewCold(sink, slog.New(slog.DiscardHandler))
	cold.Direct = true
	return cold, sink
}

func run(t *testing.T, kind, id string) Run {
	return Run{AttemptID: id, PackageID: strings.SplitN(id, ".", 2)[0], Engine: kind, Model: "m", Workspace: t.TempDir(), RunDir: filepath.Join(t.TempDir(), id), Instruction: "PROMPT-" + id}
}

const codexTurn = `echo '{"type":"thread.started","thread_id":"th_1"}'
echo '{"type":"item.completed","item":{"type":"agent_message","text":"all done"}}'
echo '{"type":"turn.completed","usage":{"input_tokens":7,"output_tokens":3}}'
`

func TestColdReportsResultOnCompletionEventNotOnExit(t *testing.T) {
	scripted(t, "codex", codexTurn+"sleep 2\n")
	cold, sink := newCold(t)
	r := run(t, "codex", "p_a.1")
	began := time.Now()
	cold.Launch(r)
	o := sink.waitFinished(t, r.AttemptID, time.Second)
	if !o.Success || o.Text != "all done" || o.InputTokens != 7 {
		t.Fatalf("outcome = %+v", o)
	}
	if took := time.Since(began); took > time.Second {
		t.Fatalf("result arrived after %s; the process was still sleeping, so it waited for exit", took)
	}
	sink.waitFor(t, "exit code", 5*time.Second, func() bool { _, ok := sink.exit[r.AttemptID]; return ok })
	if sink.handed[r.AttemptID] != ModeCold || !sink.started[r.AttemptID] || len(sink.anomaly) != 0 {
		t.Fatalf("handed=%q started=%v anomalies=%v", sink.handed[r.AttemptID], sink.started[r.AttemptID], sink.anomaly)
	}
}

func TestColdNonZeroExitAfterResultIsAnAnomalyNotAFailure(t *testing.T) {
	scripted(t, "codex", codexTurn+"exit 3\n")
	cold, sink := newCold(t)
	r := run(t, "codex", "p_b.1")
	cold.Launch(r)
	if o := sink.waitFinished(t, r.AttemptID, 2*time.Second); !o.Success {
		t.Fatalf("outcome = %+v, want success", o)
	}
	sink.waitFor(t, "anomaly", 3*time.Second, func() bool { return len(sink.anomaly) == 1 })
	if !strings.Contains(sink.anomaly[0], "3") || sink.exit[r.AttemptID] != 3 {
		t.Fatalf("anomaly=%v exit=%v", sink.anomaly, sink.exit)
	}
}

func TestColdClassifiesRateLimitFromStderr(t *testing.T) {
	scripted(t, "codex", `echo '{"type":"thread.started","thread_id":"th_1"}'
echo 'stream error: 429 Too Many Requests, retry after 90 seconds' >&2
exit 1
`)
	cold, sink := newCold(t)
	r := run(t, "codex", "p_c.1")
	cold.Launch(r)
	o := sink.waitFinished(t, r.AttemptID, 3*time.Second)
	if o.Success || o.FailureKind != FailRateLimit {
		t.Fatalf("outcome = %+v, want rate_limit", o)
	}
	if wait := time.Until(o.RetryAt); wait < 80*time.Second || wait > 95*time.Second {
		t.Fatalf("retry hint is %s away, want about 90s", wait)
	}
}

func TestColdExitWithoutAnswerIsAFailure(t *testing.T) {
	scripted(t, "codex", `echo '{"type":"thread.started","thread_id":"th_1"}'
exit 0
`)
	cold, sink := newCold(t)
	r := run(t, "codex", "p_d.1")
	cold.Launch(r)
	if o := sink.waitFinished(t, r.AttemptID, 3*time.Second); o.Success || o.FailureKind != FailNoResult {
		t.Fatalf("outcome = %+v, want no_result", o)
	}
}

func TestColdMissingBinaryFailsTheLaunch(t *testing.T) {
	original := specs["codex"]
	specs["codex"] = &spec{bin: "x", argv: func(*launchCtx) ([]string, error) { return []string{"weaver-no-such-binary"}, nil }, prepare: func(*launchCtx) error { return nil }}
	t.Cleanup(func() { specs["codex"] = original })
	cold, sink := newCold(t)
	r := run(t, "codex", "p_e.1")
	cold.Launch(r)
	if o := sink.waitFinished(t, r.AttemptID, time.Second); o.FailureKind != FailLaunch {
		t.Fatalf("outcome = %+v, want launch failure", o)
	}
}

func TestCancelKillsTheWholeProcessTreeAndReportsNothing(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "child.pid")
	scripted(t, "codex", fmt.Sprintf(`echo '{"type":"thread.started","thread_id":"th_1"}'
sleep 300 &
echo $! > %s
wait
`, marker))
	cold, sink := newCold(t)
	r := run(t, "codex", "p_f.1")
	cold.Launch(r)
	sink.waitFor(t, "start", 2*time.Second, func() bool { return sink.started[r.AttemptID] })
	var child int
	for i := 0; i < 100 && child == 0; i++ {
		if body, err := os.ReadFile(marker); err == nil {
			fmt.Sscan(string(body), &child)
		}
		time.Sleep(10 * time.Millisecond)
	}
	if child == 0 {
		t.Fatal("the engine's child never started")
	}
	if _, ok := cold.Cancel(r.AttemptID); !ok {
		t.Fatal("cancel did not find the attempt")
	}
	if err := syscall.Kill(child, 0); err == nil {
		t.Fatalf("grandchild %d is still alive after cancel returned", child)
	}
	time.Sleep(300 * time.Millisecond)
	if _, finished := sink.finished[r.AttemptID]; finished {
		t.Fatalf("a cancelled attempt reported an outcome: %+v", sink.finished[r.AttemptID])
	}
}

func TestReattachFollowsARunStartedByAnEarlierInstance(t *testing.T) {
	scripted(t, "codex", `echo '{"type":"thread.started","thread_id":"th_1"}'
sleep 1
`+codexTurn)
	first, firstSink := newCold(t)
	r := run(t, "codex", "p_g.1")
	first.Launch(r)
	firstSink.waitFor(t, "start", 2*time.Second, func() bool { return firstSink.started[r.AttemptID] })
	unit := ""
	first.mu.Lock()
	unit = first.runs[r.AttemptID].unit
	first.mu.Unlock()

	second, secondSink := newCold(t)
	second.Reattach(r, ModeCold, unit)
	if o := secondSink.waitFinished(t, r.AttemptID, 5*time.Second); !o.Success || o.Text != "all done" {
		t.Fatalf("reattached outcome = %+v", o)
	}
}

func TestOpencodeNormalizerOnARecordedRun(t *testing.T) {
	f, err := os.Open("testdata/opencode-v2-run.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	n := newNormalizer("opencode")
	started := false
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		if n.push(scanner.Text()).started {
			started = true
		}
	}
	if !started || !n.succeeded() || n.result() != "MOCK_REPLY_OK" || n.in != 10 || n.out != 6 || !strings.HasPrefix(n.session, "ses_") {
		t.Fatalf("started=%v succeeded=%v result=%q tokens=%d/%d session=%q", started, n.succeeded(), n.result(), n.in, n.out, n.session)
	}
}

func TestNormalizerFailureIsStickyAcrossALaterStop(t *testing.T) {
	n := newNormalizer("opencode")
	n.push(`{"type":"text","part":{"text":"partial"}}`)
	n.push(`{"type":"step_finish","part":{"reason":"error"}}`)
	n.push(`{"type":"step_finish","part":{"reason":"stop"}}`)
	if n.succeeded() {
		t.Fatal("a run that reported an error step counted as succeeded")
	}
}

func TestClaudeResultErrorIsAFailureWithItsReason(t *testing.T) {
	n := newNormalizer("claude")
	n.push(`{"type":"system","subtype":"init","session_id":"s"}`)
	n.push(`{"type":"result","subtype":"error_during_execution","is_error":true,"result":"You've hit your limit"}`)
	if n.succeeded() || n.failure == "" {
		t.Fatal("an error result was not a failure")
	}
	if kind, _ := classify("claude", n.failureDetail, time.Now()); kind != FailQuota {
		t.Fatalf("kind = %q, want quota", kind)
	}
}

func TestRecordedOpencodeRateLimitIsClassifiedAndReadable(t *testing.T) {
	body, err := os.ReadFile("testdata/opencode-ratelimit-stderr.txt")
	if err != nil {
		t.Fatal(err)
	}
	if kind, _ := classify("opencode", string(body), time.Now()); kind != FailRateLimit {
		t.Fatalf("kind = %q, want rate_limit", kind)
	}
	if message := vendorMessage(strings.SplitN(string(body), "\n", 2)[0]); message != "Rate limit exceeded. Please try again later." {
		t.Fatalf("message = %q", message)
	}
}

func TestModelOutputMentioningLimitsIsNotAVendorFailure(t *testing.T) {
	scripted(t, "codex", `echo '{"type":"thread.started","thread_id":"th_1"}'
echo '{"type":"item.completed","item":{"type":"agent_message","text":"Implemented the 429 rate limit handler"}}'
echo '{"type":"turn.completed"}'
`)
	cold, sink := newCold(t)
	r := run(t, "codex", "p_j.1")
	cold.Launch(r)
	if o := sink.waitFinished(t, r.AttemptID, 2*time.Second); !o.Success {
		t.Fatalf("outcome = %+v; model text about rate limits must not fail the run", o)
	}
}

func TestRedactHidesCredentialsButKeepsProse(t *testing.T) {
	in := `api_key=sk-abcdefghijklmnop url https://user:pass@host/x Authorization: Bearer abc.def.ghi and Basic usage is fine`
	out := Redact(in)
	for _, secret := range []string{"sk-abcdefghijklmnop", "user:pass", "abc.def.ghi"} {
		if strings.Contains(out, secret) {
			t.Errorf("%q survived: %s", secret, out)
		}
	}
	if !strings.Contains(out, "Basic usage is fine") || !strings.Contains(out, "@host/x") {
		t.Errorf("prose or host was lost: %s", out)
	}
}

func TestCleanEnvDropsCredentialsFromTheServiceEnvironment(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "leak")
	t.Setenv("MY_SERVICE_ACCESS_TOKEN", "leak")
	t.Setenv("WEAVER_TEST_PLAIN", "keep")
	env := strings.Join(CleanEnv(map[string]string{"CODEX_HOME": "/account"}), "\n")
	if strings.Contains(env, "leak") {
		t.Fatal("a credential variable reached the engine environment")
	}
	if !strings.Contains(env, "WEAVER_TEST_PLAIN=keep") || !strings.Contains(env, "CODEX_HOME=/account") {
		t.Fatal("ordinary or account variables were lost")
	}
}

// fakeOpencode is the slice of the opencode server API the resident launcher uses.
type fakeOpencode struct {
	mu       sync.Mutex
	events   chan string
	prompts  map[string]string
	created  []map[string]any
	deleted  []string
	interupt []string
	server   *httptest.Server
}

func newFakeOpencode(t *testing.T) *fakeOpencode {
	f := &fakeOpencode{events: make(chan string, 64), prompts: map[string]string{}}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/info", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(`{}`)) })
	mux.HandleFunc("GET /api/event", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.(http.Flusher).Flush()
		for {
			select {
			case ev := <-f.events:
				fmt.Fprintf(w, "data: %s\n\n", ev)
				w.(http.Flusher).Flush()
			case <-r.Context().Done():
				return
			}
		}
	})
	mux.HandleFunc("POST /api/session", func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		f.mu.Lock()
		f.created = append(f.created, body)
		id := fmt.Sprintf("ses_%d", len(f.created))
		f.mu.Unlock()
		fmt.Fprintf(w, `{"data":{"id":%q}}`, id)
	})
	mux.HandleFunc("POST /api/session/{id}/prompt", func(w http.ResponseWriter, r *http.Request) {
		var body struct{ Text string }
		json.NewDecoder(r.Body).Decode(&body)
		f.mu.Lock()
		f.prompts[r.PathValue("id")] = body.Text
		f.mu.Unlock()
		w.Write([]byte(`{"data":{}}`))
	})
	mux.HandleFunc("GET /api/session/{id}/message", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"data":[{"type":"idle"},{"type":"assistant","content":[{"type":"text","text":"final answer"}]},{"type":"assistant","content":[{"type":"tool"},{"type":"text","text":"first step"}]},{"type":"user"}],"cursor":{}}`))
	})
	mux.HandleFunc("POST /api/session/{id}/interrupt", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.interupt = append(f.interupt, r.PathValue("id"))
		f.mu.Unlock()
		w.Write([]byte(`{}`))
	})
	mux.HandleFunc("DELETE /api/session/{id}", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.deleted = append(f.deleted, r.PathValue("id"))
		f.mu.Unlock()
		w.WriteHeader(204)
	})
	f.server = httptest.NewServer(mux)
	// The event stream never ends by itself, and Close waits for open connections.
	t.Cleanup(func() { f.server.CloseClientConnections(); f.server.Close() })
	return f
}

type noStore struct{}

func (noStore) SaveResident(ResidentRecord) error    { return nil }
func (noStore) DeleteResident(string) error          { return nil }
func (noStore) Residents() ([]ResidentRecord, error) { return nil, nil }

// adopt wires a Resident to the fake server as if it had started it.
func adopt(t *testing.T, f *fakeOpencode) (*Resident, *recorder, Account) {
	sink := newRecorder()
	r := NewResident(sink, slog.New(slog.DiscardHandler), t.TempDir(), noStore{})
	// An API-kind account is never restarted by Ensure, so losing the fake server starts nothing real.
	account := Account{ID: "acct", Engine: "opencode", Kind: "api", Label: "测试账号"}
	srv := newServer(account, ResidentRecord{AccountID: "acct", Unit: "pid:0"})
	srv.base, srv.state = f.server.URL, "ready"
	r.servers["acct"] = srv
	go r.events(srv)
	time.Sleep(100 * time.Millisecond)
	return r, sink, account
}

func TestResidentRunsAnAttemptAsASessionInItsWorkspace(t *testing.T) {
	f := newFakeOpencode(t)
	r, sink, account := adopt(t, f)
	job := run(t, "opencode", "p_r.1")
	job.Account, job.Model, job.Effort = account, "opencode-go/deepseek", "max"
	if !r.Launch(job) {
		t.Fatal("launch on a ready server was refused")
	}
	created := f.created[0]
	if dir := created["location"].(map[string]any)["directory"]; dir != job.Workspace {
		t.Fatalf("session directory = %v, want the package workspace", dir)
	}
	if model := created["model"].(map[string]any); model["providerID"] != "opencode-go" || model["id"] != "deepseek" || model["variant"] != "max" {
		t.Fatalf("session model = %v", model)
	}
	if f.prompts["ses_1"] != job.Instruction || sink.handed[job.AttemptID] != ModeResident {
		t.Fatalf("prompt=%q mode=%q", f.prompts["ses_1"], sink.handed[job.AttemptID])
	}
	f.events <- `{"type":"session.execution.started","data":{"sessionID":"ses_1"}}`
	f.events <- `{"type":"session.execution.succeeded","data":{"sessionID":"ses_1"}}`
	o := sink.waitFinished(t, job.AttemptID, 2*time.Second)
	if !o.Success || o.Text != "first step\nfinal answer" || !sink.started[job.AttemptID] {
		t.Fatalf("outcome=%+v started=%v", o, sink.started[job.AttemptID])
	}
}

func TestResidentFailureCarriesTheVendorLimit(t *testing.T) {
	f := newFakeOpencode(t)
	r, sink, account := adopt(t, f)
	job := run(t, "opencode", "p_s.1")
	job.Account, job.Model = account, "opencode-go/deepseek"
	r.Launch(job)
	f.events <- `{"type":"session.execution.failed","data":{"sessionID":"ses_1","error":{"name":"GoUsageLimitError","message":"Go usage limit reached"}}}`
	if o := sink.waitFinished(t, job.AttemptID, 2*time.Second); o.Success || o.FailureKind != FailQuota {
		t.Fatalf("outcome = %+v, want quota", o)
	}
}

func TestLosingTheResidentServerFailsItsSessionsWithTheReason(t *testing.T) {
	f := newFakeOpencode(t)
	r, sink, account := adopt(t, f)
	var jobs []Run
	for _, id := range []string{"p_t.1", "p_u.1"} {
		job := run(t, "opencode", id)
		job.Account, job.Model = account, "opencode-go/deepseek"
		r.Launch(job)
		jobs = append(jobs, job)
	}
	f.server.CloseClientConnections()
	f.server.Close()
	for _, job := range jobs {
		o := sink.waitFinished(t, job.AttemptID, 5*time.Second)
		if o.Success || o.FailureKind != FailLost || !strings.Contains(o.FailureMessage, "测试账号") {
			t.Fatalf("outcome = %+v, want engine_lost naming the account", o)
		}
	}
	if r.Ready("acct") {
		t.Fatal("a lost server still counts as ready")
	}
}

func TestResidentCancelInterruptsOnlyThatSessionAndWarns(t *testing.T) {
	f := newFakeOpencode(t)
	r, sink, account := adopt(t, f)
	a, b := run(t, "opencode", "p_v.1"), run(t, "opencode", "p_w.1")
	a.Account, a.Model, b.Account, b.Model = account, "opencode-go/deepseek", account, "opencode-go/deepseek"
	r.Launch(a)
	r.Launch(b)
	res, ok := r.Cancel(a.AttemptID)
	if !ok || !res.Residual || res.Workspace != a.Workspace {
		t.Fatalf("cancel = %+v ok=%v", res, ok)
	}
	if len(f.interupt) != 1 || f.interupt[0] != "ses_1" {
		t.Fatalf("interrupted sessions = %v", f.interupt)
	}
	f.events <- `{"type":"session.execution.interrupted","data":{"sessionID":"ses_1","reason":"user"}}`
	f.events <- `{"type":"session.execution.succeeded","data":{"sessionID":"ses_2"}}`
	if o := sink.waitFinished(t, b.AttemptID, 2*time.Second); !o.Success {
		t.Fatalf("the other session was affected: %+v", o)
	}
	if _, reported := sink.finished[a.AttemptID]; reported {
		t.Fatal("the cancelled session reported an outcome")
	}
}

func TestAgyNormalizationIsolationAndErrors(t *testing.T) {
	t.Run("cold stream normalization and usage", func(t *testing.T) {
		scripted(t, "agy", `cat > /dev/null
printf '%s\n' '{"event":"init","conversation_id":"conv_agy_1","init":{"model":"gemini-4-neon-xhigh"}}'
printf '%s\n' '{"event":"step_update","step_update":{"conversation_id":"conv_agy_1","step_index":1,"state":"ACTIVE","step_type":"tool","tool_name":"read_file"}}'
printf '%s\n' '{"event":"step_update","step_update":{"conversation_id":"conv_agy_1","step_index":1,"state":"DONE","step_type":"tool","tool_name":"read_file"}}'
printf '%s\n' '{"event":"step_update","step_update":{"conversation_id":"conv_agy_1","step_index":2,"state":"ACTIVE","step_type":"agent_response","text_delta":"part"}}'
printf '%s\n' '{"event":"result","result":{"conversation_id":"conv_agy_1","status":"SUCCESS","response":"agy final answer\n","finished_reason":"stop","usage":{"input_tokens":1200,"output_tokens":340,"cache_read_tokens":500,"total_tokens":1540}}}'
`)
		cold, sink := newCold(t)
		r := run(t, "agy", "p_agy.1")
		cold.Launch(r)
		o := sink.waitFinished(t, r.AttemptID, 2*time.Second)
		if !o.Success || o.Text != "agy final answer" || o.InputTokens != 1200 || o.OutputTokens != 340 || o.CacheReadTokens != 500 {
			t.Fatalf("outcome = %+v", o)
		}
		if !sink.started[r.AttemptID] {
			t.Fatal("agy init did not mark attempt started")
		}
		joinedNotes := strings.Join(sink.notes, "|")
		if !strings.Contains(joinedNotes, "工具 read_file 开始") || !strings.Contains(joinedNotes, "工具 read_file 完成") {
			t.Fatalf("notes = %v", sink.notes)
		}
	})

	t.Run("vendor error classification", func(t *testing.T) {
		scripted(t, "agy", `printf '%s\n' '{"event":"result","result":{"conversation_id":"","status":"ERROR","response":"","error":"RESOURCE_EXHAUSTED: Gemini quota exhausted"}}'`)
		cold2, sink2 := newCold(t)
		r2 := run(t, "agy", "p_agy_quota.1")
		cold2.Launch(r2)
		if o2 := sink2.waitFinished(t, r2.AttemptID, 2*time.Second); o2.Success || o2.FailureKind != FailQuota {
			t.Fatalf("quota outcome = %+v, want FailQuota", o2)
		}
	})

	t.Run("multi-account isolation and login command", func(t *testing.T) {
		authDir := t.TempDir()
		acc := Account{ID: "acct-agy", Engine: "agy", Kind: "subscription", AuthDir: authDir}
		if ok, reason := specs["agy"].ready(acc); ok || !strings.Contains(reason, "没有登录凭据") {
			t.Fatalf("missing token ready=(%v,%q)", ok, reason)
		}
		argv, env, err := LoginCommand(acc)
		if err != nil {
			t.Fatalf("LoginCommand: %v", err)
		}
		if len(argv) == 0 || argv[0] != "agy" || env["HOME"] != authDir || env["DBUS_SESSION_BUS_ADDRESS"] != "unix:path=/nonexistent" {
			t.Fatalf("login argv=%v env=%v", argv, env)
		}
		tokDir := filepath.Join(authDir, ".gemini", "antigravity-cli")
		if err := os.MkdirAll(tokDir, 0o700); err != nil {
			t.Fatal(err)
		}
		tokPath := filepath.Join(tokDir, "antigravity-oauth-token")
		if err := os.WriteFile(tokPath, []byte(`{"token":{"access_token":"tok","expiry":"2020-01-01T00:00:00Z"}}`), 0o600); err != nil {
			t.Fatal(err)
		}
		if ok, reason := specs["agy"].ready(acc); ok || !strings.Contains(reason, "已过期") {
			t.Fatalf("expired without refresh ready=(%v,%q)", ok, reason)
		}
		if err := os.WriteFile(tokPath, []byte(`{"token":{"access_token":"tok","refresh_token":"ref","expiry":"2020-01-01T00:00:00Z"}}`), 0o600); err != nil {
			t.Fatal(err)
		}
		if ok, reason := specs["agy"].ready(acc); !ok || reason != "" {
			t.Fatalf("expired with refresh ready=(%v,%q), want ready", ok, reason)
		}
		if ok, _ := specs["agy"].ready(Account{ID: "a", Engine: "agy", Kind: "api", APIKey: "k"}); ok {
			t.Fatal("agy api account should not be ready")
		}
	})
}
