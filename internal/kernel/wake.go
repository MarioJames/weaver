package kernel

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// keyed runs fn once per idempotency key: a repeat of the same key returns
// the stored result of the first call without running fn again. out must be
// a pointer that fn fills in.
func (k *Kernel) keyed(key, method string, out any, fn func(t *tx) error) error {
	return k.write(func(t *tx) error {
		if key != "" {
			var stored, storedMethod string
			err := t.QueryRow(`SELECT method, response FROM commands WHERE key=?`, key).Scan(&storedMethod, &stored)
			if err == nil {
				if storedMethod != method {
					return errf("KEY_REUSED", "幂等编号 %s 已用于 %s，不能再用于 %s", key, storedMethod, method)
				}
				return json.Unmarshal([]byte(stored), out)
			}
		}
		if err := fn(t); err != nil {
			return err
		}
		if key == "" {
			return nil
		}
		body, err := json.Marshal(out)
		if err != nil {
			return err
		}
		_, err = t.Exec(`INSERT INTO commands(key, method, response, at) VALUES(?,?,?,?)`, key, method, string(body), t.now)
		return err
	})
}

// collect returns the wake events after the cursor and advances the mission's
// stored cursor past them. When there are none it reports whether anything
// could still wake the mission.
func (k *Kernel) collect(mission string, cursor *int64) (*WaitResult, error) {
	res := &WaitResult{Wakes: []Wake{}}
	err := k.write(func(t *tx) error {
		m, err := getMission(t, mission)
		if err != nil {
			return err
		}
		from := m.Cursor
		if cursor != nil {
			from = *cursor
		}
		rows, err := t.Query(`SELECT e.seq, e.kind, e.package_id, COALESCE(p.key,''), COALESCE(p.title,''), COALESCE(p.state,''), e.attempt, e.message, e.at,
			COALESCE((SELECT result FROM attempts a WHERE a.package_id=e.package_id AND a.n=e.attempt),'')
			FROM events e LEFT JOIN packages p ON p.id=e.package_id
			WHERE e.mission_id=? AND e.wake=1 AND e.seq>? ORDER BY e.seq LIMIT 200`, mission, from)
		if err != nil {
			return err
		}
		for rows.Next() {
			var w Wake
			var result string
			if err := rows.Scan(&w.Seq, &w.Kind, &w.Package, &w.Key, &w.Title, &w.State, &w.Attempt, &w.Message, &w.At, &result); err != nil {
				rows.Close()
				return err
			}
			if w.Kind == EvResult {
				w.Summary = tail(strings.TrimSpace(result), 2000)
			}
			res.Wakes = append(res.Wakes, w)
			from = w.Seq
		}
		rows.Close()
		res.Cursor = from
		if len(res.Wakes) > 0 {
			if _, err := t.Exec(`UPDATE missions SET wake_cursor=MAX(wake_cursor,?) WHERE id=?`, from, mission); err != nil {
				return err
			}
			m.Cursor = max(m.Cursor, from)
			res.Mission = m
			return nil
		}
		res.Mission = m
		var timers, releasable int
		if err := t.QueryRow(`SELECT COUNT(*) FROM timers WHERE mission_id=? AND fired_at IS NULL AND cancelled_at IS NULL`, mission).Scan(&timers); err != nil {
			return err
		}
		if err := t.QueryRow(`SELECT COUNT(*) FROM packages p WHERE p.mission_id=? AND p.state=? AND NOT EXISTS
			(SELECT 1 FROM package_deps d JOIN packages u ON u.id=d.depends_on WHERE d.package_id=p.id AND u.state<>?)`, mission, StatePending, StateAccepted).Scan(&releasable); err != nil {
			return err
		}
		if m.Counts[StateLaunch]+m.Counts[StateRunning] == 0 && timers == 0 && releasable == 0 {
			res.Idle = true
			res.Hint = idleHint(m)
		}
		return nil
	})
	return res, err
}

func idleHint(m *Mission) string {
	var parts []string
	for _, s := range []string{StateVerdict, StateFailed, StatePending, StateAccepted, StateCanceled} {
		if n := m.Counts[s]; n > 0 {
			parts = append(parts, fmt.Sprintf("%s %d", stateLabel(s), n))
		}
	}
	if len(parts) == 0 {
		return "主任务里还没有工作包，没有可以等待的事。"
	}
	return "没有在跑的包，也没有定时器，继续等不会有新的唤醒。当前：" + strings.Join(parts, "、") + "。"
}

// Wait blocks until the mission has something for its parent agent: a result,
// a failure, a stall, a timer or an external wake. It returns at once when
// such events are already past the cursor, or when nothing could ever arrive.
// A nil cursor means "since the last wait or push".
func (k *Kernel) Wait(ctx context.Context, mission string, cursor *int64, timeout time.Duration) (*WaitResult, error) {
	ch, unsubscribe := k.subscribe(mission)
	defer unsubscribe()
	k.subMu.Lock()
	k.waiters[mission]++
	k.subMu.Unlock()
	defer func() {
		k.subMu.Lock()
		if k.waiters[mission]--; k.waiters[mission] <= 0 {
			delete(k.waiters, mission)
		}
		k.subMu.Unlock()
	}()
	var deadline <-chan time.Time
	if timeout > 0 {
		timer := time.NewTimer(timeout)
		defer timer.Stop()
		deadline = timer.C
	}
	for {
		res, err := k.collect(mission, cursor)
		if err != nil {
			return nil, err
		}
		if len(res.Wakes) > 0 || res.Idle {
			return res, nil
		}
		select {
		case <-ch:
		case <-deadline:
			res.TimedOut = true
			return res, nil
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-k.stop:
			return nil, errf("SHUTDOWN", "服务正在停止，请重新等待")
		}
	}
}

// Follow blocks until the mission has events after seq, the context ends, or the kernel stops.
func (k *Kernel) Follow(ctx context.Context, mission string, after int64) ([]Event, error) {
	ch, unsubscribe := k.subscribe(mission)
	defer unsubscribe()
	for {
		events, err := k.Events(mission, after, 0)
		if err != nil || len(events) > 0 {
			return events, err
		}
		select {
		case <-ch:
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-k.stop:
			return nil, errf("SHUTDOWN", "服务正在停止")
		}
	}
}

// maybePush delivers pending wakes into the parent agent's Herdr pane when
// nobody is waiting on the mission. The cursor moves first so that a wait
// arriving during delivery does not see the same wakes again; it moves back
// if delivery fails.
func (k *Kernel) maybePush(mission string) {
	if k.push == nil {
		return
	}
	k.subMu.Lock()
	if k.waiters[mission] > 0 || k.pushing[mission] {
		k.subMu.Unlock()
		return
	}
	k.pushing[mission] = true
	k.subMu.Unlock()
	go func() {
		defer func() {
			k.subMu.Lock()
			delete(k.pushing, mission)
			k.subMu.Unlock()
		}()
		for {
			// Results that land together are delivered together.
			select {
			case <-time.After(300 * time.Millisecond):
			case <-k.stop:
				return
			}
			k.subMu.Lock()
			waiting := k.waiters[mission] > 0
			k.subMu.Unlock()
			if waiting {
				return
			}
			m, err := k.Mission(mission)
			if err != nil || m.Notify == nil {
				return
			}
			before := m.Cursor
			res, err := k.collect(mission, nil)
			if err != nil || len(res.Wakes) == 0 {
				return
			}
			if err := k.push(m.Notify.Session, m.Notify.Pane, PushText(res)); err != nil {
				k.log.Warn("push failed", "mission", mission, "err", err)
				k.report("push", mission, func(t *tx) error {
					if _, err := t.Exec(`UPDATE missions SET wake_cursor=? WHERE id=? AND wake_cursor=?`, before, mission, res.Cursor); err != nil {
						return err
					}
					_, err := t.event(mission, "", 0, EvProgress, "推送到父 Agent 会话失败，结果留给下一次等待："+clip(err.Error(), 300))
					return err
				})
				return
			}
		}
	}()
}

// PushText renders a wait result for delivery into an agent session. The JSON
// is the same document `weaver wait` prints.
func PushText(res *WaitResult) string {
	body, _ := json.Marshal(res)
	return fmt.Sprintf("[Weaver] 主任务 %s 有 %d 条新进展（与 weaver wait 的返回相同，已标记为已读）：\n%s", res.Mission.ID, len(res.Wakes), body)
}

// SetTimer schedules a wake-up of the mission.
func (k *Kernel) SetTimer(key, mission string, due time.Time, note string) (*Timer, error) {
	out := &Timer{}
	err := k.keyed(key, "timer.set", out, func(t *tx) error {
		if _, err := getMission(t, mission); err != nil {
			return err
		}
		if due.UnixMilli() <= t.now {
			return errf("INVALID", "唤醒时间必须在将来")
		}
		*out = Timer{ID: newID("t_"), Mission: mission, DueAt: due.UnixMilli(), Note: clip(strings.TrimSpace(note), 1000), CreatedAt: t.now}
		if _, err := t.Exec(`INSERT INTO timers(id, mission_id, due_at, note, created_at) VALUES(?,?,?,?,?)`, out.ID, mission, out.DueAt, out.Note, t.now); err != nil {
			return err
		}
		t.timers = true
		t.touched[mission] = true
		return nil
	})
	return out, err
}

// Timers lists the timers of a mission that have not fired or been cancelled.
func (k *Kernel) Timers(mission string) ([]Timer, error) {
	out := []Timer{}
	err := k.read(func() error {
		if _, err := getMission(k.db, mission); err != nil {
			return err
		}
		rows, err := k.db.Query(`SELECT id, mission_id, due_at, note, created_at FROM timers WHERE mission_id=? AND fired_at IS NULL AND cancelled_at IS NULL ORDER BY due_at`, mission)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var tm Timer
			if err := rows.Scan(&tm.ID, &tm.Mission, &tm.DueAt, &tm.Note, &tm.CreatedAt); err != nil {
				return err
			}
			out = append(out, tm)
		}
		return rows.Err()
	})
	return out, err
}

// CancelTimer cancels a timer that has not fired.
func (k *Kernel) CancelTimer(id string) error {
	return k.write(func(t *tx) error {
		var mission string
		if err := t.QueryRow(`SELECT mission_id FROM timers WHERE id=? AND fired_at IS NULL AND cancelled_at IS NULL`, id).Scan(&mission); err != nil {
			return errf("NOT_FOUND", "定时器 %s 不存在，或已经触发、已取消", id)
		}
		if _, err := t.Exec(`UPDATE timers SET cancelled_at=? WHERE id=?`, t.now, id); err != nil {
			return err
		}
		t.timers = true
		t.touched[mission] = true
		return nil
	})
}

// Wake ends the mission's wait from outside, with a note for the parent agent.
func (k *Kernel) Wake(key, mission, note string) (*Event, error) {
	out := &Event{}
	err := k.keyed(key, "wake", out, func(t *tx) error {
		if _, err := getMission(t, mission); err != nil {
			return err
		}
		message := "外部唤醒"
		if strings.TrimSpace(note) != "" {
			message += "：" + strings.TrimSpace(note)
		}
		seq, err := t.event(mission, "", 0, EvExternal, message)
		*out = Event{Seq: seq, Mission: mission, Kind: EvExternal, Wake: true, Message: clip(message, 4000), At: t.now}
		return err
	})
	return out, err
}

// timerLoop fires timers when they fall due. Timers live in the database, so
// one that came due while the service was down fires as soon as it is back.
func (k *Kernel) timerLoop() {
	for {
		var next int64
		_ = k.read(func() error {
			return k.db.QueryRow(`SELECT COALESCE(MIN(due_at),0) FROM timers WHERE fired_at IS NULL AND cancelled_at IS NULL`).Scan(&next)
		})
		var wait <-chan time.Time
		var timer *time.Timer
		if next > 0 {
			timer = time.NewTimer(max(time.Until(time.UnixMilli(next)), 0))
			wait = timer.C
		}
		select {
		case <-wait:
			k.fireTimers()
		case <-k.timerKick:
		case <-k.stop:
			return
		}
		if timer != nil {
			timer.Stop()
		}
	}
}

func (k *Kernel) fireTimers() {
	k.report("timers", "", func(t *tx) error {
		rows, err := t.Query(`SELECT id, mission_id, due_at, note FROM timers WHERE fired_at IS NULL AND cancelled_at IS NULL AND due_at<=?`, t.now)
		if err != nil {
			return err
		}
		var due []Timer
		for rows.Next() {
			var tm Timer
			if err := rows.Scan(&tm.ID, &tm.Mission, &tm.DueAt, &tm.Note); err != nil {
				rows.Close()
				return err
			}
			due = append(due, tm)
		}
		rows.Close()
		for _, tm := range due {
			if _, err := t.Exec(`UPDATE timers SET fired_at=? WHERE id=?`, t.now, tm.ID); err != nil {
				return err
			}
			message := "定时唤醒（定在 " + time.UnixMilli(tm.DueAt).Format("15:04:05") + "）"
			if tm.Note != "" {
				message += "：" + tm.Note
			}
			if _, err := t.event(tm.Mission, "", 0, EvTimer, message); err != nil {
				return err
			}
		}
		return nil
	})
}
