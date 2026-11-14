package engine

import (
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// Manager picks how each attempt is launched: a session on a resident server,
// a standby process, or a cold start.
type Manager struct {
	sink     Sink
	log      *slog.Logger
	home     string
	Cold     *Cold
	Resident *Resident
	// Setting reads a kernel setting ("resident", "standby").
	Setting func(key string) string
}

func NewManager(sink Sink, log *slog.Logger, home string, store ResidentStore, setting func(string) string) *Manager {
	return &Manager{sink: sink, log: log, home: home, Cold: NewCold(sink, log), Resident: NewResident(sink, log, home, store), Setting: setting}
}

func (m *Manager) residentFor(run Run) bool {
	return run.Engine == "opencode" && run.Account.Kind == "subscription" && m.Setting("resident") != "off"
}

// Launch implements the kernel's Engines interface.
func (m *Manager) Launch(run Run) {
	go func() {
		if m.residentFor(run) {
			if m.Resident.Launch(run) {
				return
			}
			m.sink.Note(run.AttemptID, "opencode 常驻服务不可用，这次改为冷启动")
			m.Resident.Ensure(run.Account)
		}
		if SupportsStandby(run.Engine) && m.Cold.Release(run) {
			return
		}
		m.Cold.Launch(run)
	}()
}

// Cancel implements the kernel's Engines interface.
func (m *Manager) Cancel(attemptID string) CancelResult {
	if res, ok := m.Resident.Cancel(attemptID); ok {
		return res
	}
	res, _ := m.Cold.Cancel(attemptID)
	return res
}

// Reattach implements the kernel's Engines interface.
func (m *Manager) Reattach(run Run, mode, unit, vendorSession string) {
	switch mode {
	case ModeResident:
		if !m.Resident.Reattach(run, vendorSession) {
			m.sink.Finished(run.AttemptID, Outcome{FailureKind: FailLost, FailureMessage: "服务重启后找不到这次运行所在的 opencode 常驻服务或会话"})
		}
	case "":
		// The service stopped between recording the attempt and hearing from
		// the engine. If a process got as far as starting, follow it;
		// otherwise nothing ran and the attempt is launched now.
		if _, err := os.Stat(filepath.Join(run.RunDir, "started")); err == nil || scopeActive(unitFor(run.AttemptID)) {
			m.Cold.Reattach(run, ModeCold, unitFor(run.AttemptID))
			return
		}
		m.Launch(run)
	default:
		m.Cold.Reattach(run, mode, unit)
	}
}

// Prewarm implements the kernel's Engines interface.
func (m *Manager) Prewarm(run Run) {
	if m.Setting("standby") == "off" {
		return
	}
	go m.Cold.Prewarm(run)
}

// DropPrewarm implements the kernel's Engines interface.
func (m *Manager) DropPrewarm(packageID string) { go m.Cold.DropPrewarm(packageID) }

// Warm implements the kernel's Engines interface.
func (m *Manager) Warm(workspace string) {
	if m.Setting("resident") != "off" {
		m.Resident.Warm(workspace)
	}
}

// Liveness implements the kernel's Engines interface.
func (m *Manager) Liveness(attemptID string) Liveness {
	if l := m.Cold.Liveness(attemptID); l.Known {
		return l
	}
	return m.Resident.Liveness(attemptID)
}

// Sweep stops attempt scopes that no attempt owns any more: standby processes
// and runs orphaned by a crash. Resident servers are left alone.
func (m *Manager) Sweep() {
	out, err := exec.Command("systemctl", "--user", "list-units", "--type=scope", "--state=active", "--plain", "--no-legend", "weaver-p_*").Output()
	if err != nil {
		return
	}
	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 || !strings.HasSuffix(fields[0], ".scope") {
			continue
		}
		unit := strings.TrimSuffix(fields[0], ".scope")
		attempt := strings.TrimPrefix(unit, "weaver-")
		if m.Cold.Tracked(attempt) {
			continue
		}
		// Unit names are per user, not per data directory. A scope whose run
		// directory is not here belongs to a service on another WEAVER_HOME.
		if _, err := os.Stat(filepath.Join(m.home, "runs", attempt)); err != nil {
			continue
		}
		m.log.Info("stopping orphan scope", "unit", unit)
		go stopScope(unit)
	}
}
