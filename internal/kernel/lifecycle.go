package kernel

import (
	"database/sql"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/MarioJames/weaver/internal/engine"
)

// activeAttempt loads an attempt only while it is still launching or running;
// reports for attempts that have moved on are dropped.
func (t *tx) activeAttempt(id string) (*Attempt, *Package, error) {
	a, pkgID, _, err := getAttempt(t, id)
	if err == sql.ErrNoRows {
		return nil, nil, nil
	}
	if err != nil {
		return nil, nil, err
	}
	if a.State != StateLaunch && a.State != StateRunning {
		return nil, nil, nil
	}
	p, err := getPackage(t, pkgID)
	if err != nil {
		return nil, nil, err
	}
	return a, p, nil
}

func modeLabel(mode string) string {
	switch mode {
	case engine.ModeResident:
		return "常驻会话"
	case engine.ModeStandby:
		return "待命进程"
	}
	return "冷启动"
}

// Handed implements engine.Sink.
func (k *Kernel) Handed(attemptID, mode, unit string) {
	k.touch(attemptID)
	k.report("handed", attemptID, func(t *tx) error {
		a, p, err := t.activeAttempt(attemptID)
		if a == nil || err != nil {
			return err
		}
		if _, err := t.Exec(`UPDATE attempts SET handed_at=COALESCE(handed_at,?), mode=?, unit=? WHERE id=?`, t.now, mode, unit, attemptID); err != nil {
			return err
		}
		if a.HandedAt != 0 {
			return nil
		}
		_, err = t.event(p.MissionID, p.ID, a.N, EvHanded, "已交给引擎（"+modeLabel(mode)+"）")
		return err
	})
}

// Started implements engine.Sink.
func (k *Kernel) Started(attemptID, vendorSession string) {
	k.touch(attemptID)
	k.report("started", attemptID, func(t *tx) error {
		a, p, err := t.activeAttempt(attemptID)
		if a == nil || err != nil {
			return err
		}
		if vendorSession != "" && vendorSession != a.VendorSession {
			if _, err := t.Exec(`UPDATE attempts SET vendor_session=? WHERE id=?`, clip(vendorSession, 512), attemptID); err != nil {
				return err
			}
		}
		if a.State != StateLaunch {
			return nil
		}
		if _, err := t.Exec(`UPDATE attempts SET state=?, started_at=? WHERE id=?`, StateRunning, t.now, attemptID); err != nil {
			return err
		}
		if err := t.setPackage(p, StateRunning, ""); err != nil {
			return err
		}
		_, err = t.event(p.MissionID, p.ID, a.N, EvRunning, "引擎开始执行")
		return err
	})
}

// Alive implements engine.Sink.
func (k *Kernel) Alive(attemptID string) { k.touch(attemptID) }

// Output implements engine.Sink. It is called for every model delta, so the
// common case only refreshes the in-memory activity clock.
func (k *Kernel) Output(attemptID string) {
	k.actMu.Lock()
	a := k.activity[attemptID]
	if a == nil {
		a = &activity{}
		k.activity[attemptID] = a
	}
	a.last = k.now()
	a.stalled = false
	a.cpuAt = time.Time{}
	first := !a.output
	a.output = true
	k.actMu.Unlock()
	if !first {
		return
	}
	k.report("output", attemptID, func(t *tx) error {
		_, err := t.Exec(`UPDATE attempts SET first_output_at=COALESCE(first_output_at,?) WHERE id=? AND state IN (?,?)`, t.now, attemptID, StateLaunch, StateRunning)
		return err
	})
}

// Note implements engine.Sink.
func (k *Kernel) Note(attemptID, message string) {
	k.touch(attemptID)
	k.report("note", attemptID, func(t *tx) error {
		a, p, err := t.activeAttempt(attemptID)
		if a == nil || err != nil {
			return err
		}
		_, err = t.event(p.MissionID, p.ID, a.N, EvProgress, message)
		return err
	})
}

// Anomaly implements engine.Sink. Unlike the other reports it applies after
// the attempt has finished: a result was already taken, then the process exited badly.
func (k *Kernel) Anomaly(attemptID, message string) {
	k.report("anomaly", attemptID, func(t *tx) error {
		a, pkgID, mission, err := getAttempt(t, attemptID)
		if err == sql.ErrNoRows {
			return nil
		}
		if err != nil {
			return err
		}
		_, err = t.event(mission, pkgID, a.N, EvAnomaly, message)
		return err
	})
}

// ExitCode records the exit code of an attempt's process once it is known.
func (k *Kernel) ExitCode(attemptID string, code int) {
	k.report("exit", attemptID, func(t *tx) error {
		_, err := t.Exec(`UPDATE attempts SET exit_code=? WHERE id=?`, code, attemptID)
		return err
	})
}

func (k *Kernel) report(what, attemptID string, fn func(t *tx) error) {
	if err := k.write(fn); err != nil {
		k.log.Error("report failed", "report", what, "attempt", attemptID, "err", err)
	}
}

// Finished implements engine.Sink.
func (k *Kernel) Finished(attemptID string, o engine.Outcome) {
	k.forget(attemptID)
	k.report("finished", attemptID, func(t *tx) error {
		a, p, err := t.activeAttempt(attemptID)
		if a == nil || err != nil {
			return err
		}
		var exit any
		if o.ExitCode != nil {
			exit = *o.ExitCode
		}
		if o.Success {
			if _, err := t.Exec(`UPDATE attempts SET state=?, finished_at=?, started_at=COALESCE(started_at,?), result=?, exit_code=COALESCE(?,exit_code), input_tokens=?, output_tokens=? WHERE id=?`,
				StateVerdict, t.now, t.now, o.Text, exit, o.InputTokens, o.OutputTokens, attemptID); err != nil {
				return err
			}
			if p.AutoAccept {
				// The plan said this result needs no verdict: accept it and let
				// its dependents start. The owner is not woken for it.
				if _, err := t.Exec(`UPDATE attempts SET state=? WHERE id=?`, StateAccepted, attemptID); err != nil {
					return err
				}
				if err := t.setPackage(p, StateAccepted, ""); err != nil {
					return err
				}
				if _, err := t.event(p.MissionID, p.ID, a.N, EvAccepted, "有结果，按计划自动采纳"); err != nil {
					return err
				}
				return t.dispatch()
			}
			if err := t.setPackage(p, StateVerdict, ""); err != nil {
				return err
			}
			if _, err := t.event(p.MissionID, p.ID, a.N, EvResult, "有结果，等待采纳或退回"); err != nil {
				return err
			}
			// A dependent pinned to a standby engine can warm up now.
			return t.dispatch()
		}
		kind := o.FailureKind
		if kind == "" {
			kind = engine.FailVendor
		}
		message := strings.TrimSpace(o.FailureMessage)
		if message == "" {
			message = "引擎没有给出原因"
		}
		if _, err := t.Exec(`UPDATE attempts SET state=?, finished_at=?, failure_kind=?, failure_message=?, result=?, exit_code=COALESCE(?,exit_code), input_tokens=?, output_tokens=? WHERE id=?`,
			StateFailed, t.now, kind, clip(message, 4000), o.Text, exit, o.InputTokens, o.OutputTokens, attemptID); err != nil {
			return err
		}
		limited := kind == engine.FailQuota || kind == engine.FailRateLimit || kind == engine.FailAuth
		if limited {
			if err := t.limitAccount(a.Account, kind, message, o.RetryAt); err != nil {
				return err
			}
		}
		// A vendor limit says nothing about the package: move it to another
		// ready candidate when there is one, at most twice.
		if limited && a.N < 3 {
			rt, err := t.loadRouting()
			if err != nil {
				return err
			}
			if w, _, _ := rt.pick(p.Worker, p.Engine); w != nil {
				if _, err := t.event(p.MissionID, p.ID, a.N, EvProgress, fmt.Sprintf("第 %d 次尝试因账号受限失败（%s），改派其他候选", a.N, clip(message, 300))); err != nil {
					return err
				}
				if err := t.setPackage(p, StatePending, ""); err != nil {
					return err
				}
				return t.dispatch()
			}
		}
		if err := t.setPackage(p, StateFailed, ""); err != nil {
			return err
		}
		if _, err := t.event(p.MissionID, p.ID, a.N, EvFailed, failureLabel(kind)+"："+clip(message, 1000)); err != nil {
			return err
		}
		return t.dispatch()
	})
}

func failureLabel(kind string) string {
	switch kind {
	case engine.FailQuota:
		return "额度耗尽"
	case engine.FailRateLimit:
		return "被限流"
	case engine.FailAuth:
		return "账号认证失败"
	case engine.FailLaunch:
		return "无法启动"
	case engine.FailLost:
		return "引擎中途退出"
	case engine.FailNoResult:
		return "没有最终回复"
	}
	return "引擎报错"
}

var limitLadder = []time.Duration{10 * time.Minute, 30 * time.Minute, 60 * time.Minute}

const limitWindow = 2 * time.Hour

// limitAccount pauses an account after a vendor limit. Repeated limits within
// two hours climb the 10/30/60 minute ladder; a vendor-supplied retry time wins.
// An authentication failure marks the account not ready until it is checked again.
func (t *tx) limitAccount(id, kind, message string, retryAt time.Time) error {
	var label string
	var level int
	var limitAt sql.NullInt64
	if err := t.QueryRow(`SELECT label, limit_level, limit_at FROM accounts WHERE id=?`, id).Scan(&label, &level, &limitAt); err != nil {
		if err == sql.ErrNoRows {
			return nil
		}
		return err
	}
	if label == "" {
		label = id
	}
	reason := failureLabel(kind) + "：" + clip(message, 200)
	if kind == engine.FailAuth {
		if _, err := t.Exec(`UPDATE accounts SET ready=0, ready_reason=?, checked_at=? WHERE id=?`, reason, t.now, id); err != nil {
			return err
		}
		return t.accountEvent(fmt.Sprintf("账号「%s」认证失败，已标记为未就绪：%s", label, clip(message, 200)))
	}
	if !limitAt.Valid || t.now-limitAt.Int64 > limitWindow.Milliseconds() {
		level = 0
	}
	until := t.now + limitLadder[min(level, len(limitLadder)-1)].Milliseconds()
	if !retryAt.IsZero() && retryAt.UnixMilli() > t.now {
		until = min(retryAt.UnixMilli(), t.now+(24*time.Hour).Milliseconds())
	}
	if _, err := t.Exec(`UPDATE accounts SET paused_until=?, pause_reason=?, limit_level=?, limit_at=? WHERE id=?`, until, reason, level+1, t.now, id); err != nil {
		return err
	}
	return t.accountEvent(fmt.Sprintf("账号「%s」暂停到 %s：%s", label, time.UnixMilli(until).Format("15:04"), reason))
}

// accountEvent records an account change on every mission that still has work
// outstanding, so a waiting parent can see why packages are not moving.
func (t *tx) accountEvent(message string) error {
	missions, err := queryStrings(t, `SELECT DISTINCT mission_id FROM packages WHERE state IN (?,?,?)`, StatePending, StateLaunch, StateRunning)
	if err != nil {
		return err
	}
	for _, m := range missions {
		if _, err := t.event(m, "", 0, EvAccount, message); err != nil {
			return err
		}
	}
	return nil
}

// Verdict accepts or returns a package that is awaiting a verdict.
func (k *Kernel) Verdict(pkgID, verdict, note string) (*Package, error) {
	if verdict != "accept" && verdict != "return" {
		return nil, errf("INVALID", "结论只能是 accept 或 return")
	}
	err := k.write(func(t *tx) error {
		p, err := getPackage(t, pkgID)
		if err != nil {
			return err
		}
		if p.State != StateVerdict {
			return errf("WRONG_STATE", "包 %s 现在是「%s」，只有「待结论」的包可以采纳或退回", p.Key, stateLabel(p.State))
		}
		id := attemptID(p.ID, p.Attempt)
		if verdict == "accept" {
			if _, err := t.Exec(`UPDATE attempts SET state=? WHERE id=?`, StateAccepted, id); err != nil {
				return err
			}
			if err := t.setPackage(p, StateAccepted, ""); err != nil {
				return err
			}
			if _, err := t.event(p.MissionID, p.ID, p.Attempt, EvAccepted, joinLine("已采纳", note)); err != nil {
				return err
			}
			return t.dispatch()
		}
		if strings.TrimSpace(note) == "" {
			return errf("INVALID", "退回需要说明，它会带进下一次尝试的指令")
		}
		if _, err := t.Exec(`UPDATE attempts SET state=? WHERE id=?`, StateReturned, id); err != nil {
			return err
		}
		if _, err := t.Exec(`UPDATE packages SET next_note=? WHERE id=?`, clip(note, 8000), p.ID); err != nil {
			return err
		}
		if err := t.setPackage(p, StatePending, ""); err != nil {
			return err
		}
		if _, err := t.event(p.MissionID, p.ID, p.Attempt, EvReturned, "已退回："+clip(note, 1000)); err != nil {
			return err
		}
		return t.dispatch()
	})
	if err != nil {
		return nil, err
	}
	return k.Package(pkgID)
}

func joinLine(head, note string) string {
	if strings.TrimSpace(note) == "" {
		return head
	}
	return head + "：" + clip(strings.TrimSpace(note), 1000)
}

// Retry starts a new attempt of a failed package.
func (k *Kernel) Retry(pkgID, note string) (*Package, error) {
	err := k.write(func(t *tx) error {
		p, err := getPackage(t, pkgID)
		if err != nil {
			return err
		}
		if p.State != StateFailed {
			return errf("WRONG_STATE", "包 %s 现在是「%s」，只有「失败」的包可以重试", p.Key, stateLabel(p.State))
		}
		if _, err := t.Exec(`UPDATE packages SET next_note=? WHERE id=?`, clip(note, 8000), p.ID); err != nil {
			return err
		}
		if err := t.setPackage(p, StatePending, ""); err != nil {
			return err
		}
		if _, err := t.event(p.MissionID, p.ID, p.Attempt, EvRetry, joinLine("重试", note)); err != nil {
			return err
		}
		return t.dispatch()
	})
	if err != nil {
		return nil, err
	}
	return k.Package(pkgID)
}

// CancelResult reports what a cancel did.
type CancelResult struct {
	Cancelled []CancelledPackage `json:"cancelled"`
	Mission   *Mission           `json:"mission"`
}

// CancelledPackage is one package stopped by a cancel.
type CancelledPackage struct {
	ID        string `json:"id"`
	Key       string `json:"key"`
	From      string `json:"from"`
	Residual  bool   `json:"residual,omitempty"`
	Workspace string `json:"workspace,omitempty"`
	Detail    string `json:"detail,omitempty"`
}

// Cancel stops one package, or every unfinished package of a mission when
// pkgID is empty. The state changes first; the call then waits until each
// engine confirms its processes are gone or its session is interrupted.
func (k *Kernel) Cancel(missionID, pkgID string) (*CancelResult, error) {
	out := &CancelResult{Cancelled: []CancelledPackage{}}
	type job struct {
		index     int
		attemptID string
		mission   string
		pkg       string
		n         int
	}
	var jobs []job
	err := k.write(func(t *tx) error {
		var ids []string
		if pkgID != "" {
			p, err := getPackage(t, pkgID)
			if err != nil {
				return err
			}
			if p.State == StateAccepted || p.State == StateCanceled {
				return errf("WRONG_STATE", "包 %s 已经是「%s」，不能取消", p.Key, stateLabel(p.State))
			}
			missionID = p.MissionID
			ids = []string{pkgID}
		} else {
			if _, err := getMission(t, missionID); err != nil {
				return err
			}
			var err error
			ids, err = queryStrings(t, `SELECT id FROM packages WHERE mission_id=? AND state NOT IN (?,?) ORDER BY position`, missionID, StateAccepted, StateCanceled)
			if err != nil {
				return err
			}
		}
		for _, id := range ids {
			p, err := getPackage(t, id)
			if err != nil {
				return err
			}
			from := p.State
			if from == StateLaunch || from == StateRunning {
				aid := attemptID(p.ID, p.Attempt)
				if _, err := t.Exec(`UPDATE attempts SET state=?, finished_at=? WHERE id=?`, StateCanceled, t.now, aid); err != nil {
					return err
				}
				jobs = append(jobs, job{index: len(out.Cancelled), attemptID: aid, mission: p.MissionID, pkg: p.ID, n: p.Attempt})
			}
			if err := t.setPackage(p, StateCanceled, ""); err != nil {
				return err
			}
			if _, err := t.event(p.MissionID, p.ID, p.Attempt, EvCancelled, "已取消（原状态："+stateLabel(from)+"）"); err != nil {
				return err
			}
			t.drops = append(t.drops, p.ID)
			out.Cancelled = append(out.Cancelled, CancelledPackage{ID: p.ID, Key: p.Key, From: from})
		}
		return t.dispatch()
	})
	if err != nil {
		return nil, err
	}
	var wg sync.WaitGroup
	for _, j := range jobs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			k.forget(j.attemptID)
			res := k.eng.Cancel(j.attemptID)
			c := &out.Cancelled[j.index]
			c.Residual, c.Detail = res.Residual, res.Detail
			message := "进程和子进程已全部退出"
			if res.Residual {
				c.Workspace = res.Workspace
				message = "会话已中断。常驻引擎不按包隔离进程，它启动的命令可能仍在运行，请检查工作目录：" + res.Workspace
			}
			if res.Detail != "" {
				message += "（" + res.Detail + "）"
			}
			k.report("cancelled", j.attemptID, func(t *tx) error {
				_, err := t.event(j.mission, j.pkg, j.n, EvCancelled, message)
				return err
			})
		}()
	}
	wg.Wait()
	out.Mission, err = k.Mission(missionID)
	return out, err
}
