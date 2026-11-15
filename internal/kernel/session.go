package kernel

import (
	"bufio"
	"database/sql"
	"io"
	"os"
	"strings"
	"time"
)

type SessionItem struct {
	Seq     int64  `json:"seq"`
	Engine  string `json:"engine"`
	Session string `json:"session"`
	At      int64  `json:"at"`
	Role    string `json:"role"`
	Tool    string `json:"tool,omitempty"`
	Text    string `json:"text"`
	Ref     string `json:"ref,omitempty"`
}

func validateOwner(engine, session string) error {
	if (engine != "claude" && engine != "codex") || session == "" || session == "." || session == ".." || strings.ContainsAny(session, "/\\\x00") {
		return errf("INVALID", "需要 claude 或 codex 引擎及有效会话 ID")
	}
	return nil
}

func (k *Kernel) SetMissionOwner(mission, engine, session string) (*Mission, error) {
	if err := validateOwner(engine, session); err != nil {
		return nil, err
	}
	err := k.write(func(t *tx) error {
		if _, err := getMission(t, mission); err != nil {
			return err
		}
		if _, err := t.Exec(`UPDATE missions SET owner_engine=?,owner_session=? WHERE id=?`, engine, session, mission); err != nil {
			return err
		}
		t.touched[mission] = true
		return t.registerSession(Owner{Engine: engine, Session: session})
	})
	if err != nil {
		return nil, err
	}
	return k.Mission(mission)
}

func (k *Kernel) SyncMissionSession(mission string) error {
	m, err := k.Mission(mission)
	if err != nil {
		return err
	}
	if m.Owner == nil {
		return nil
	}
	return k.syncSession(*m.Owner)
}

// registerSession records a mission's parent session in the mutation that
// links it; the session is read after commit. Other engines have no session
// file Weaver can read, so they are left unregistered.
func (t *tx) registerSession(o Owner) error {
	if o.Session == "" || (o.Engine != "claude" && o.Engine != "codex") {
		return nil
	}
	if err := validateOwner(o.Engine, o.Session); err != nil {
		return err
	}
	if _, err := t.Exec(`INSERT OR IGNORE INTO owner_sessions(engine,session) VALUES(?,?)`, o.Engine, o.Session); err != nil {
		return err
	}
	t.sessions = append(t.sessions, o)
	return nil
}

func (k *Kernel) syncSession(owner Owner) error {
	if err := validateOwner(owner.Engine, owner.Session); err != nil {
		return err
	}
	k.sessionMu.Lock()
	defer k.sessionMu.Unlock()
	var path, state string
	var offset, synced int64
	err := k.read(func() error {
		return k.db.QueryRow(`SELECT path,offset,state,synced_at FROM owner_sessions WHERE engine=? AND session=?`, owner.Engine, owner.Session).Scan(&path, &offset, &state, &synced)
	})
	if err != nil {
		return err
	}
	if state == "rewritten" {
		return nil
	}
	setState := func(s string) error {
		return k.write(func(t *tx) error {
			_, e := t.Exec(`UPDATE owner_sessions SET path=?,state=?,synced_at=? WHERE engine=? AND session=?`, path, s, t.now, owner.Engine, owner.Session)
			return e
		})
	}
	if state == "missing" && k.ms()-synced < 30000 {
		return nil
	}
	savedPath := path
	if path == "" || state == "missing" {
		path = findSessionPath(os.Getenv("HOME"), owner)
	}
	f, err := os.Open(path)
	if os.IsNotExist(err) || path == "" {
		return setState("missing")
	}
	if err != nil {
		return err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return err
	}
	if st.Size() == offset && state == "" && savedPath == path {
		return nil
	}
	if st.Size() < offset {
		return setState("rewritten")
	}
	if _, err = f.Seek(offset, io.SeekStart); err != nil {
		return err
	}
	r := bufio.NewReader(f)
	for {
		select {
		case <-k.stop:
			return nil
		default:
		}
		start := offset
		var items []TranscriptItem
		count := 0
		for offset-start < 4<<20 && count < 2000 && len(items) < 2000 {
			line, e := r.ReadBytes('\n')
			if e == io.EOF {
				break
			}
			if e != nil {
				return e
			}
			items = append(items, parseTranscriptLine(line, owner.Engine)...)
			offset += int64(len(line))
			count++
		}
		if offset == start {
			return setState("")
		}
		err = k.write(func(t *tx) error {
			stmt, e := t.Prepare(`INSERT INTO session_items(engine,session,at,role,tool,text,ref) VALUES(?,?,?,?,?,?,?)`)
			if e != nil {
				return e
			}
			defer stmt.Close()
			for _, v := range items {
				// The tool has its own column; the stored summary does not repeat it.
				text := v.Text
				if v.Role == "tool" {
					text = strings.TrimPrefix(text, v.Tool+": ")
				}
				if _, e = stmt.Exec(owner.Engine, owner.Session, v.At, v.Role, v.Tool, text, v.Ref); e != nil {
					return e
				}
			}
			if _, e = t.Exec(`UPDATE owner_sessions SET path=?,offset=?,state='',synced_at=? WHERE engine=? AND session=?`, path, offset, t.now, owner.Engine, owner.Session); e != nil {
				return e
			}
			ids, e := queryStrings(t, `SELECT id FROM missions WHERE owner_engine=? AND owner_session=?`, owner.Engine, owner.Session)
			for _, id := range ids {
				t.touched[id] = true
			}
			return e
		})
		if err != nil {
			return err
		}
	}
}

func (k *Kernel) sessionLoop() {
	defer k.sessionWG.Done()
	ticker := time.NewTicker(300 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-k.stop:
			return
		case <-ticker.C:
		}
		var owners []Owner
		err := k.read(func() error {
			rows, e := k.db.Query(`SELECT DISTINCT owner_engine,owner_session FROM missions WHERE owner_engine IN ('claude','codex') AND owner_session<>'' AND (closed_at IS NULL OR closed_at>?)`, time.Now().UnixMilli()-int64(10*time.Minute/time.Millisecond))
			if e != nil {
				return e
			}
			defer rows.Close()
			for rows.Next() {
				var o Owner
				if e = rows.Scan(&o.Engine, &o.Session); e != nil {
					return e
				}
				owners = append(owners, o)
			}
			return rows.Err()
		})
		if err != nil {
			k.log.Error("session follow failed", "err", err)
			continue
		}
		for _, o := range owners {
			if err = k.syncSession(o); err != nil {
				k.log.Error("session sync failed", "err", err)
			}
		}
	}
}

// SessionItems returns sequence bounds (after, through]; zero through is unbounded.
func (k *Kernel) SessionItems(engine, session string, after, through int64) ([]SessionItem, error) {
	return k.sessionItems(`engine=? AND session=? AND seq>? AND (?=0 OR seq<=?)`, engine, session, after, through, through)
}

// SessionItemsAt returns an inclusive timestamp interval; zero end is unbounded.
func (k *Kernel) SessionItemsAt(engine, session string, start, end int64) ([]SessionItem, error) {
	return k.sessionItems(`engine=? AND session=? AND at>=? AND (?=0 OR at<=?)`, engine, session, start, end, end)
}
func (k *Kernel) SessionItem(seq int64) (*SessionItem, error) {
	items, err := k.sessionItems(`seq=?`, seq)
	if err != nil {
		return nil, err
	}
	if len(items) == 0 {
		return nil, sql.ErrNoRows
	}
	return &items[0], nil
}
func (k *Kernel) sessionItems(where string, args ...any) ([]SessionItem, error) {
	out := []SessionItem{}
	err := k.read(func() error {
		rows, e := k.db.Query(`SELECT seq,engine,session,at,role,tool,text,ref FROM session_items WHERE `+where+` ORDER BY seq`, args...)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var v SessionItem
			if e = rows.Scan(&v.Seq, &v.Engine, &v.Session, &v.At, &v.Role, &v.Tool, &v.Text, &v.Ref); e != nil {
				return e
			}
			out = append(out, v)
		}
		return rows.Err()
	})
	return out, err
}
