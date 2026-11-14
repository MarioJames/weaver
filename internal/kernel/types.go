// Package kernel is the Weaver engine: missions, work packages, the package
// state machine, dispatch, progress events and wake-ups.
package kernel

import (
	"errors"
	"fmt"
)

// Package states.
const (
	StatePending  = "pending"          // 待定
	StateLaunch   = "launching"        // 启动中
	StateRunning  = "running"          // 运行中
	StateVerdict  = "awaiting_verdict" // 待结论
	StateAccepted = "accepted"         // 已采纳
	StateFailed   = "failed"           // 失败
	StateCanceled = "cancelled"        // 已取消
	// StateReturned only appears on an attempt: the package itself moves on to its next attempt.
	StateReturned = "returned" // 已退回
)

// Event kinds. Kinds listed in wakeKinds end a parent agent's wait.
const (
	EvPlan      = "plan"
	EvReleased  = "released"
	EvLaunching = "launching"
	EvHanded    = "handed"
	EvRunning   = "running"
	EvProgress  = "progress"
	EvResult    = "result"
	EvFailed    = "failed"
	EvAccepted  = "accepted"
	EvReturned  = "returned"
	EvRetry     = "retry"
	EvCancelled = "cancelled"
	EvStalled   = "stalled"
	EvAnomaly   = "anomaly"
	EvTimer     = "timer"
	EvExternal  = "external"
	EvAccount   = "account"
)

// Error is a failure the caller can act on; Code is stable across releases.
type Error struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

func errf(code, format string, args ...any) *Error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...)}
}

// AsError unwraps a kernel error; other errors become INTERNAL.
func AsError(err error) *Error {
	var e *Error
	if errors.As(err, &e) {
		return e
	}
	return &Error{Code: "INTERNAL", Message: err.Error()}
}

// Mission is a root task: the unit a parent agent waits on.
type Mission struct {
	ID        string         `json:"id"`
	Title     string         `json:"title"`
	Workspace string         `json:"workspace"`
	State     string         `json:"state"`
	Counts    map[string]int `json:"counts"`
	Total     int            `json:"total"`
	Cursor    int64          `json:"cursor"`
	Notify    *Notify        `json:"notify,omitempty"`
	CreatedAt int64          `json:"createdAt"`
	ClosedAt  int64          `json:"closedAt,omitempty"`
}

// Notify is the Herdr pane that receives wake-ups while nobody is waiting.
type Notify struct {
	Session string `json:"session,omitempty"`
	Pane    string `json:"pane"`
}

// Package is one unit of work run by one agent.
type Package struct {
	ID          string     `json:"id"`
	MissionID   string     `json:"missionId"`
	Key         string     `json:"key"`
	Title       string     `json:"title"`
	Instruction string     `json:"instruction,omitempty"`
	Workspace   string     `json:"workspace"`
	Worker      string     `json:"worker,omitempty"`
	Engine      string     `json:"engine,omitempty"`
	State       string     `json:"state"`
	Waiting     string     `json:"waiting,omitempty"`
	Attempt     int        `json:"attempt"`
	DependsOn   []string   `json:"dependsOn,omitempty"`
	CreatedAt   int64      `json:"createdAt"`
	UpdatedAt   int64      `json:"updatedAt"`
	Current     *Attempt   `json:"current,omitempty"`
	Attempts    []*Attempt `json:"attempts,omitempty"`
}

// Attempt is one run of a package on one engine.
type Attempt struct {
	ID             string `json:"id"`
	N              int    `json:"n"`
	State          string `json:"state"`
	Worker         string `json:"worker"`
	Account        string `json:"account"`
	Engine         string `json:"engine"`
	Model          string `json:"model"`
	Effort         string `json:"effort,omitempty"`
	Mode           string `json:"mode,omitempty"`
	Note           string `json:"note,omitempty"`
	Unit           string `json:"unit,omitempty"`
	RunDir         string `json:"runDir,omitempty"`
	VendorSession  string `json:"vendorSession,omitempty"`
	CreatedAt      int64  `json:"createdAt"`
	HandedAt       int64  `json:"handedAt,omitempty"`
	StartedAt      int64  `json:"startedAt,omitempty"`
	FirstOutputAt  int64  `json:"firstOutputAt,omitempty"`
	FinishedAt     int64  `json:"finishedAt,omitempty"`
	StalledAt      int64  `json:"stalledAt,omitempty"`
	ExitCode       *int   `json:"exitCode,omitempty"`
	FailureKind    string `json:"failureKind,omitempty"`
	FailureMessage string `json:"failureMessage,omitempty"`
	Result         string `json:"result,omitempty"`
	InputTokens    int    `json:"inputTokens,omitempty"`
	OutputTokens   int    `json:"outputTokens,omitempty"`
}

// Event is one line of a mission's progress stream.
type Event struct {
	Seq     int64  `json:"seq"`
	Mission string `json:"missionId"`
	Package string `json:"packageId,omitempty"`
	Key     string `json:"key,omitempty"`
	Attempt int    `json:"attempt,omitempty"`
	Kind    string `json:"kind"`
	Wake    bool   `json:"wake,omitempty"`
	Message string `json:"message,omitempty"`
	At      int64  `json:"at"`
}

// PlanInput is a decomposition submitted in one command.
type PlanInput struct {
	Mission  string         `json:"mission"`
	Packages []PackageInput `json:"packages"`
}

// PackageInput describes one package of a plan. DependsOn names keys in the
// same plan or keys already present in the mission.
type PackageInput struct {
	Key         string   `json:"key"`
	Title       string   `json:"title"`
	Instruction string   `json:"instruction"`
	Workspace   string   `json:"workspace,omitempty"`
	Worker      string   `json:"worker,omitempty"`
	Engine      string   `json:"engine,omitempty"`
	DependsOn   []string `json:"dependsOn,omitempty"`
}

// PlanResult reports what a plan created.
type PlanResult struct {
	Mission  string     `json:"missionId"`
	Packages []*Package `json:"packages"`
	Cursor   int64      `json:"cursor"`
}

// Wake is one reason a wait returned.
type Wake struct {
	Seq     int64  `json:"seq"`
	Kind    string `json:"kind"`
	Package string `json:"packageId,omitempty"`
	Key     string `json:"key,omitempty"`
	Title   string `json:"title,omitempty"`
	State   string `json:"state,omitempty"`
	Attempt int    `json:"attempt,omitempty"`
	Message string `json:"message,omitempty"`
	Summary string `json:"summary,omitempty"`
	At      int64  `json:"at"`
}

// WaitResult is what `weaver wait` returns.
type WaitResult struct {
	Mission  *Mission `json:"mission"`
	Wakes    []Wake   `json:"wakes"`
	Cursor   int64    `json:"cursor"`
	Idle     bool     `json:"idle,omitempty"`
	TimedOut bool     `json:"timedOut,omitempty"`
	Hint     string   `json:"hint,omitempty"`
}

// Timer is a scheduled wake-up of a mission.
type Timer struct {
	ID        string `json:"id"`
	Mission   string `json:"missionId"`
	DueAt     int64  `json:"dueAt"`
	Note      string `json:"note,omitempty"`
	CreatedAt int64  `json:"createdAt"`
	FiredAt   int64  `json:"firedAt,omitempty"`
}

// Account is a stored engine account without its secret material.
type Account struct {
	ID          string `json:"id"`
	Engine      string `json:"engine"`
	Kind        string `json:"kind"`
	Label       string `json:"label,omitempty"`
	AuthDir     string `json:"authDir,omitempty"`
	HasAPIKey   bool   `json:"hasApiKey,omitempty"`
	HasConfig   bool   `json:"hasConfig,omitempty"`
	BaseURL     string `json:"baseUrl,omitempty"`
	Provider    string `json:"provider,omitempty"`
	Protocol    string `json:"protocol,omitempty"`
	Enabled     bool   `json:"enabled"`
	Ready       bool   `json:"ready"`
	ReadyReason string `json:"readyReason,omitempty"`
	CheckedAt   int64  `json:"checkedAt,omitempty"`
	PausedUntil int64  `json:"pausedUntil,omitempty"`
	PauseReason string `json:"pauseReason,omitempty"`
	Running     int    `json:"running"`
	Resident    string `json:"resident,omitempty"`
}

// Worker is a routing candidate: one engine, model and effort on a set of accounts.
type Worker struct {
	ID          string   `json:"id"`
	Engine      string   `json:"engine"`
	Model       string   `json:"model"`
	Effort      string   `json:"effort,omitempty"`
	Weight      int      `json:"weight"`
	MaxParallel int      `json:"maxParallel,omitempty"`
	Enabled     bool     `json:"enabled"`
	Accounts    []string `json:"accounts"`
	Description string   `json:"description,omitempty"`
	Running     int      `json:"running"`
	Available   bool     `json:"available"`
	Reason      string   `json:"reason,omitempty"`
}
