package kernel

import (
	"strings"

	"github.com/MarioJames/weaver/internal/engine"
)

// SaveResident implements engine.ResidentStore.
func (k *Kernel) SaveResident(r engine.ResidentRecord) error {
	return k.write(func(t *tx) error {
		_, err := t.Exec(`INSERT INTO residents(account_id, unit, port, secret, dir, started_at) VALUES(?,?,?,?,?,?)
			ON CONFLICT(account_id) DO UPDATE SET unit=excluded.unit, port=excluded.port, secret=excluded.secret, dir=excluded.dir, started_at=excluded.started_at`,
			r.AccountID, r.Unit, r.Port, r.Secret, r.Dir, r.StartedAt)
		return err
	})
}

// DeleteResident implements engine.ResidentStore.
func (k *Kernel) DeleteResident(accountID string) error {
	return k.write(func(t *tx) error {
		_, err := t.Exec(`DELETE FROM residents WHERE account_id=?`, accountID)
		return err
	})
}

// Residents implements engine.ResidentStore.
func (k *Kernel) Residents() ([]engine.ResidentRecord, error) {
	var out []engine.ResidentRecord
	err := k.read(func() error {
		rows, err := k.db.Query(`SELECT account_id, unit, port, secret, dir, started_at FROM residents`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var r engine.ResidentRecord
			if err := rows.Scan(&r.AccountID, &r.Unit, &r.Port, &r.Secret, &r.Dir, &r.StartedAt); err != nil {
				return err
			}
			out = append(out, r)
		}
		return rows.Err()
	})
	return out, err
}

// ResidentAccounts lists the accounts that should have a resident server:
// enabled, ready opencode subscriptions bound to an enabled candidate.
func (k *Kernel) ResidentAccounts() ([]engine.Account, error) {
	var out []engine.Account
	err := k.read(func() error {
		ids, err := queryStrings(k.db, `SELECT DISTINCT a.id FROM accounts a JOIN worker_accounts wa ON wa.account_id=a.id JOIN workers w ON w.id=wa.worker_id
			WHERE a.engine='opencode' AND a.kind='subscription' AND a.enabled=1 AND a.ready=1 AND w.enabled=1`)
		if err != nil {
			return err
		}
		for _, id := range ids {
			a, err := accountSecrets(k.db, id)
			if err != nil {
				return err
			}
			out = append(out, a)
		}
		return nil
	})
	return out, err
}

// ResolvePackage turns a package reference into its ID. A reference is either
// an ID or "<mission>/<key>".
func (k *Kernel) ResolvePackage(ref string) (string, error) {
	mission, key, ok := strings.Cut(ref, "/")
	if !ok {
		return ref, nil
	}
	var id string
	err := k.read(func() error {
		return k.db.QueryRow(`SELECT id FROM packages WHERE mission_id=? AND key=?`, mission, key).Scan(&id)
	})
	if err != nil {
		return "", errf("NOT_FOUND", "主任务 %s 里没有 key 为 %s 的包", mission, key)
	}
	return id, nil
}

// Overview is the service-wide summary shown by `weaver status`.
type Overview struct {
	Missions int            `json:"openMissions"`
	Packages map[string]int `json:"packages"`
	Active   int            `json:"active"`
	Capacity int            `json:"capacity"`
	Timers   int            `json:"timers"`
}

func (k *Kernel) Overview() (*Overview, error) {
	out := &Overview{Packages: map[string]int{}}
	err := k.write(func(t *tx) error {
		if err := t.QueryRow(`SELECT COUNT(*) FROM missions WHERE closed_at IS NULL`).Scan(&out.Missions); err != nil {
			return err
		}
		rows, err := t.Query(`SELECT p.state, COUNT(*) FROM packages p JOIN missions m ON m.id=p.mission_id WHERE m.closed_at IS NULL GROUP BY p.state`)
		if err != nil {
			return err
		}
		for rows.Next() {
			var state string
			var n int
			if err := rows.Scan(&state, &n); err != nil {
				rows.Close()
				return err
			}
			out.Packages[state] = n
		}
		rows.Close()
		rt, err := t.loadRouting()
		if err != nil {
			return err
		}
		out.Active, out.Capacity = rt.Active, rt.Cap
		return t.QueryRow(`SELECT COUNT(*) FROM timers WHERE fired_at IS NULL AND cancelled_at IS NULL`).Scan(&out.Timers)
	})
	return out, err
}

// OpenWorkspaces lists the working directories of missions that are still open.
func (k *Kernel) OpenWorkspaces() ([]string, error) {
	var out []string
	err := k.read(func() (err error) {
		out, err = queryStrings(k.db, `SELECT workspace FROM missions WHERE closed_at IS NULL UNION SELECT p.workspace FROM packages p JOIN missions m ON m.id=p.mission_id WHERE m.closed_at IS NULL AND p.state IN (?,?)`, StatePending, StateLaunch)
		return
	})
	return out, err
}
