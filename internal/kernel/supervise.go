package kernel

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"time"

	"github.com/MarioJames/weaver/internal/engine"
)

const (
	defaultStall  = 5 * time.Minute
	cpuIdleShare  = 0.05 // below this share of one core, a process counts as idle
	backupsToKeep = 7
	runDirMaxAge  = 7 * 24 * time.Hour
)

// Start resumes supervision of attempts that were active when the service
// last stopped, then starts the timer, stall and maintenance loops.
func (k *Kernel) Start() error {
	type resume struct {
		run                 engine.Run
		mode, unit, session string
	}
	var resumes []resume
	err := k.read(func() error {
		rows, err := k.db.Query(`SELECT a.id, a.package_id, p.title, p.workspace, a.instruction, a.engine, a.model, a.effort, a.account_id, a.run_dir, a.mode, a.unit, a.vendor_session
			FROM attempts a JOIN packages p ON p.id=a.package_id WHERE a.state IN (?,?)`, StateLaunch, StateRunning)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var r resume
			if err := rows.Scan(&r.run.AttemptID, &r.run.PackageID, &r.run.Title, &r.run.Workspace, &r.run.Instruction, &r.run.Engine, &r.run.Model, &r.run.Effort,
				&r.run.Account.ID, &r.run.RunDir, &r.mode, &r.unit, &r.session); err != nil {
				return err
			}
			resumes = append(resumes, r)
		}
		if err := rows.Err(); err != nil {
			return err
		}
		for i := range resumes {
			a, err := accountSecrets(k.db, resumes[i].run.Account.ID)
			if err == nil {
				resumes[i].run.Account = a
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	for _, r := range resumes {
		k.touch(r.run.AttemptID)
		k.eng.Reattach(r.run, r.mode, r.unit, r.session)
	}
	go k.timerLoop()
	go k.superviseLoop()
	go k.maintenanceLoop()
	return k.Dispatch()
}

func (k *Kernel) stallAfter() time.Duration {
	var value string
	_ = k.read(func() error {
		return k.db.QueryRow(`SELECT value FROM settings WHERE key='stall_seconds'`).Scan(&value)
	})
	if n, err := strconv.Atoi(value); err == nil && n > 0 {
		return time.Duration(n) * time.Second
	}
	return defaultStall
}

func (k *Kernel) superviseLoop() {
	for {
		after := k.stallAfter()
		tick := min(15*time.Second, max(after/8, 250*time.Millisecond))
		select {
		case <-time.After(tick):
		case <-k.stop:
			return
		}
		k.checkStalls(after)
		// Capacity can come back without any command: an account pause expires.
		var pending int
		_ = k.read(func() error {
			return k.db.QueryRow(`SELECT COUNT(*) FROM packages WHERE state=?`, StatePending).Scan(&pending)
		})
		if pending > 0 {
			if err := k.Dispatch(); err != nil {
				k.log.Error("dispatch failed", "err", err)
			}
		}
	}
}

// checkStalls reports attempts that have gone quiet. An attempt that owns a
// process is stalled when it has produced no event for `after` and its scope
// stayed under 5% of one core the whole time it was sampled. An attempt on a
// resident engine has no process of its own, so silence alone decides.
// A stalled attempt keeps running: the parent agent decides what to do.
func (k *Kernel) checkStalls(after time.Duration) {
	sampleFrom := min(30*time.Second, after/4)
	now := k.now()
	type candidate struct {
		id      string
		silence time.Duration
	}
	var candidates []candidate
	k.actMu.Lock()
	for id, a := range k.activity {
		if a.stalled {
			continue
		}
		if silence := now.Sub(a.last); silence >= sampleFrom {
			candidates = append(candidates, candidate{id, silence})
		} else {
			a.cpuAt = time.Time{}
		}
	}
	k.actMu.Unlock()
	for _, c := range candidates {
		live := k.eng.Liveness(c.id)
		k.actMu.Lock()
		a := k.activity[c.id]
		if a == nil || a.stalled || now.Sub(a.last) < sampleFrom {
			k.actMu.Unlock()
			continue
		}
		evidence := ""
		stalled := false
		switch {
		case !live.Known:
			if c.silence >= after {
				stalled, evidence = true, "调度层已经没有这次运行的进程或会话记录"
			}
		case !live.Process:
			if c.silence >= after {
				stalled, evidence = true, "常驻引擎不按包隔离进程，只按事件判定"
			}
		default:
			if a.cpuAt.IsZero() {
				a.cpu, a.cpuAt, a.idleFrom = live.CPUNSec, now, now
			} else if elapsed := now.Sub(a.cpuAt); elapsed > 0 {
				used := time.Duration(0)
				if live.CPUNSec >= a.cpu {
					used = time.Duration(live.CPUNSec - a.cpu)
				}
				if float64(used) >= cpuIdleShare*float64(elapsed) {
					a.idleFrom = now
				}
				a.cpu, a.cpuAt = live.CPUNSec, now
			}
			if idle := now.Sub(a.idleFrom); c.silence >= after && idle >= after-sampleFrom {
				stalled, evidence = true, fmt.Sprintf("进程在最近 %s 里 CPU 占用一直低于 5%%", idle.Round(time.Second))
			}
		}
		if stalled {
			a.stalled = true
		}
		k.actMu.Unlock()
		if !stalled {
			continue
		}
		message := fmt.Sprintf("可能卡住：%s 没有新事件，%s。包仍在运行，没有被自动取消", c.silence.Round(time.Second), evidence)
		k.report("stalled", c.id, func(t *tx) error {
			at, p, err := t.activeAttempt(c.id)
			if at == nil || err != nil {
				return err
			}
			if _, err := t.Exec(`UPDATE attempts SET stalled_at=? WHERE id=?`, t.now, c.id); err != nil {
				return err
			}
			_, err = t.event(p.MissionID, p.ID, at.N, EvStalled, message)
			return err
		})
	}
}

func (k *Kernel) maintenanceLoop() {
	for {
		k.CheckAccounts()
		if _, err := k.Backup(false); err != nil {
			k.log.Error("backup failed", "err", err)
		}
		k.prune()
		select {
		case <-time.After(time.Minute):
		case <-k.stop:
			return
		}
	}
}

// Backup writes today's snapshot of the database and keeps the newest seven.
// With force unset it does nothing when today's snapshot already exists.
func (k *Kernel) Backup(force bool) (string, error) {
	dir := filepath.Join(k.home, "backups")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	path := filepath.Join(dir, "weaver-"+k.now().Format("20060102")+".db")
	if _, err := os.Stat(path); err == nil {
		if !force {
			return path, nil
		}
		path = filepath.Join(dir, "weaver-"+k.now().Format("20060102-150405")+".db")
	}
	tmp := path + ".tmp"
	os.Remove(tmp)
	err := k.read(func() error {
		_, err := k.db.Exec(`VACUUM INTO ?`, tmp)
		return err
	})
	if err != nil {
		os.Remove(tmp)
		return "", err
	}
	if err := os.Chmod(tmp, 0o600); err != nil {
		return "", err
	}
	if err := os.Rename(tmp, path); err != nil {
		return "", err
	}
	files, _ := filepath.Glob(filepath.Join(dir, "weaver-*.db"))
	sort.Strings(files)
	for len(files) > backupsToKeep {
		os.Remove(files[0])
		files = files[1:]
	}
	return path, nil
}

// prune removes run directories of attempts that finished more than a week
// ago, and idempotency records of the same age.
func (k *Kernel) prune() {
	cutoff := k.now().Add(-runDirMaxAge).UnixMilli()
	var dirs []string
	_ = k.read(func() (err error) {
		dirs, err = queryStrings(k.db, `SELECT run_dir FROM attempts WHERE run_dir<>'' AND finished_at IS NOT NULL AND finished_at<? AND state NOT IN (?,?)`, cutoff, StateLaunch, StateRunning)
		return
	})
	root := filepath.Join(k.home, "runs") + string(filepath.Separator)
	for _, dir := range dirs {
		if len(dir) > len(root) && dir[:len(root)] == root {
			os.RemoveAll(dir)
		}
	}
	_ = k.write(func(t *tx) error {
		if _, err := t.Exec(`UPDATE attempts SET run_dir='' WHERE run_dir<>'' AND finished_at IS NOT NULL AND finished_at<? AND state NOT IN (?,?)`, cutoff, StateLaunch, StateRunning); err != nil {
			return err
		}
		_, err := t.Exec(`DELETE FROM commands WHERE at<?`, cutoff)
		return err
	})
}
