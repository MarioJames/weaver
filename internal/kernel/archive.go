package kernel

import (
	"database/sql"
	"strconv"
	"time"
)

func (k *Kernel) ArchiveMission(id string, archived bool) (*Mission, error) {
	var out *Mission
	err := k.write(func(t *tx) error {
		m, err := getMission(t, id)
		if err != nil {
			return err
		}
		// By hand the owner may also archive a settled mission it never closed.
		if archived && m.State != "done" && m.State != "settled" {
			return errf("INVALID", "进行中的主任务不能归档")
		}
		var at any
		if archived {
			at = t.now
		}
		if _, err = t.Exec(`UPDATE missions SET archived_at=? WHERE id=?`, at, id); err != nil {
			return err
		}
		out, err = getMission(t, id)
		return err
	})
	return out, err
}

// AutoArchive only archives closed missions whose latest event is old enough.
func (k *Kernel) AutoArchive() error {
	return k.write(func(t *tx) error {
		value := settingDefaults["archive_after_days"]
		if err := t.QueryRow(`SELECT value FROM settings WHERE key='archive_after_days'`).Scan(&value); err != nil && err != sql.ErrNoRows {
			return err
		}
		days, _ := strconv.Atoi(value)
		if days == 0 {
			return nil
		}
		ids, err := queryStrings(t, `SELECT id FROM missions WHERE archived_at IS NULL AND COALESCE((SELECT MAX(at) FROM events WHERE mission_id=missions.id),created_at) < ?`, t.now-int64(days)*int64(24*time.Hour/time.Millisecond))
		if err != nil {
			return err
		}
		for _, id := range ids {
			m, err := getMission(t, id)
			if err != nil {
				return err
			}
			if m.State == "done" {
				if _, err = t.Exec(`UPDATE missions SET archived_at=? WHERE id=?`, t.now, id); err != nil {
					return err
				}
			}
		}
		return nil
	})
}
func (k *Kernel) archiveLoop() {
	ticker := time.NewTicker(10 * time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-k.stop:
			return
		case <-ticker.C:
			if err := k.AutoArchive(); err != nil {
				k.log.Error("archive failed", "err", err)
			}
		}
	}
}
