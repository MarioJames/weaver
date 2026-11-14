// Package engine launches vendor agent CLIs and reports what they do.
package engine

import "time"

// Launch modes recorded on an attempt.
const (
	ModeCold     = "cold"     // one process per attempt
	ModeResident = "resident" // a session on a long-lived engine server
	ModeStandby  = "standby"  // a process started ahead of time, fed the prompt on release
)

// Account is the credential context an attempt runs under.
type Account struct {
	ID       string
	Engine   string
	Kind     string // subscription | api
	Label    string
	AuthDir  string
	APIKey   string
	Config   string
	BaseURL  string
	Provider string
	Protocol string
}

// Run is everything a launcher needs to start one attempt.
type Run struct {
	AttemptID   string
	PackageID   string
	Title       string
	Workspace   string
	Instruction string
	Engine      string
	Model       string
	Effort      string
	Account     Account
	RunDir      string
}

// Failure kinds.
const (
	FailQuota     = "quota"
	FailRateLimit = "rate_limit"
	FailAuth      = "auth"
	FailVendor    = "vendor"      // the engine reported an error
	FailLaunch    = "launch"      // the process or session could not be started
	FailLost      = "engine_lost" // the engine process or server went away mid-run
	FailNoResult  = "no_result"   // the engine exited without a final answer
)

// Outcome is the terminal report of an attempt.
type Outcome struct {
	Success        bool
	Text           string
	FailureKind    string
	FailureMessage string
	RetryAt        time.Time
	ExitCode       *int
	InputTokens    int
	OutputTokens   int
}

// Sink receives lifecycle reports. Every method is safe to call more than
// once for the same attempt; the kernel ignores reports that no longer apply.
type Sink interface {
	// Handed: the engine has the prompt (process exec'd, or the server accepted it).
	Handed(attemptID, mode, unit string)
	// Started: the engine began executing; vendorSession may be empty.
	Started(attemptID, vendorSession string)
	// Alive: the engine showed signs of life that are not model output.
	Alive(attemptID string)
	// Output: the model produced text, reasoning or a tool call.
	Output(attemptID string)
	// Note: a short progress line worth keeping (tool started, cold fallback...).
	Note(attemptID, message string)
	// Finished: the attempt reached its terminal report.
	Finished(attemptID string, outcome Outcome)
	// Anomaly: something went wrong after the terminal report, e.g. a non-zero exit.
	Anomaly(attemptID, message string)
}

// CancelResult describes what stopping an attempt could and could not guarantee.
type CancelResult struct {
	// Residual is set when the engine could only interrupt the session, so
	// commands it started may still be running in Workspace.
	Residual  bool
	Workspace string
	Detail    string
}

// Liveness is what the supervisor needs for the stall check.
type Liveness struct {
	Known   bool // false when the attempt is not tracked by this launcher
	Process bool // true when the attempt owns a process whose CPU can be sampled
	CPUNSec uint64
}
