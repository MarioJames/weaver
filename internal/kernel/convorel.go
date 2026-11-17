package kernel

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

var readConvorelHistory = func(ctx context.Context, id string) ([]byte, error) {
	path, err := exec.LookPath("convorel")
	if err != nil {
		home, e := os.UserHomeDir()
		if e != nil {
			return nil, e
		}
		path = filepath.Join(home, ".local", "bin", "convorel")
	}
	return exec.CommandContext(ctx, path, "history", "--id", id).Output()
}

const convorelRefresh = 3 * time.Second

type convorelRun struct {
	State          string `json:"state"`
	Input          string `json:"input"`
	SubmittedAt    string `json:"submittedAt"`
	CreatedAt      string `json:"createdAt"`
	LastObservedAt string `json:"lastObservedAt"`
	ObservedModel  string `json:"observedModel"`
	Error          string `json:"error"`
	Delivery       struct {
		RequestSent bool `json:"requestSent"`
	} `json:"delivery"`
	Reply struct {
		Final    bool   `json:"final"`
		Markdown string `json:"markdown"`
	} `json:"reply"`
}
type convorelHistory struct {
	ID   string        `json:"id"`
	Runs []convorelRun `json:"runs"`
}
type convorelCacheEntry struct {
	history   *convorelHistory
	operation int64
	fetched   time.Time
	complete  bool
}

// prefetchConvorel reads the Convorel records a mission's session refers to
// into the cache. The command can take seconds, so this runs outside the
// kernel lock; composing a timeline only reads the cache.
func (k *Kernel) prefetchConvorel(mission string) error {
	refs := map[string]int64{}
	err := k.read(func() error {
		rows, err := k.db.Query(`SELECT i.ref, MAX(i.seq) FROM session_items i JOIN missions m ON m.owner_engine=i.engine AND m.owner_session=i.session WHERE m.id=? AND i.ref<>'' GROUP BY i.ref`, mission)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var ref string
			var operation int64
			if err := rows.Scan(&ref, &operation); err != nil {
				return err
			}
			if id, ok := strings.CutPrefix(ref, "convorel:"); ok && id != "" {
				refs[id] = operation
			}
		}
		return rows.Err()
	})
	if err != nil {
		return err
	}
	for id, operation := range refs {
		k.convorelMu.Lock()
		cached, ok := k.convorel[id]
		k.convorelMu.Unlock()
		// A finished record changes only when the session touches it again.
		if ok && cached.operation == operation && (cached.complete || time.Since(cached.fetched) < convorelRefresh) {
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), convorelRefresh)
		data, err := readConvorelHistory(ctx, id)
		cancel()
		entry := convorelCacheEntry{operation: operation, fetched: time.Now()}
		if err == nil {
			var h convorelHistory
			if json.Unmarshal(data, &h) == nil && h.ID == id && len(h.Runs) > 0 {
				entry.history, entry.complete = &h, true
				for _, run := range h.Runs {
					entry.complete = entry.complete && run.State == "complete" && run.Reply.Final
				}
			}
		}
		k.convorelMu.Lock()
		if k.convorel == nil {
			k.convorel = map[string]convorelCacheEntry{}
		}
		k.convorel[id] = entry
		k.convorelMu.Unlock()
	}
	return nil
}

func (k *Kernel) convorelCached(id string) *convorelHistory {
	k.convorelMu.Lock()
	defer k.convorelMu.Unlock()
	return k.convorel[id].history
}

type convorelText struct {
	entry TimelineEntry
	text  string
}

func convorelMillis(s string) int64 {
	at, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return 0
	}
	return at.UnixMilli()
}

// timelineConvorel only authorizes rounds belonging to this mission's session interval.
func (k *Kernel) timelineConvorel(m *Mission, items []SessionItem) ([]convorelText, map[string]bool, error) {
	refs := map[string]bool{}
	order := []string{}
	for _, item := range items {
		if item.Role == "tool" && strings.HasPrefix(item.Ref, "convorel:") && len(item.Ref) > len("convorel:") && !refs[item.Ref] {
			refs[item.Ref] = true
			order = append(order, item.Ref)
		}
	}
	represented := map[string]bool{}
	if len(order) == 0 {
		return nil, represented, nil
	}
	start, end, err := timelineSessionBounds(k.db, m)
	if err != nil {
		return nil, nil, err
	}
	if end == -1 {
		return nil, represented, nil
	}
	var from, through int64
	for _, bound := range []struct {
		seq int64
		at  *int64
	}{{start, &from}, {end, &through}} {
		if bound.seq != 0 {
			if err = k.db.QueryRow(`SELECT at FROM session_items WHERE seq=?`, bound.seq).Scan(bound.at); err != nil {
				return nil, nil, err
			}
		}
	}
	var out []convorelText
	for _, ref := range order {
		id := strings.TrimPrefix(ref, "convorel:")
		history := k.convorelCached(id)
		if history == nil {
			continue
		}
		represented[ref] = true
		for i, run := range history.Runs {
			submitted := run.SubmittedAt
			if submitted == "" {
				submitted = run.CreatedAt
			}
			at := convorelMillis(submitted)
			if at == 0 || (from != 0 && at < from) || (through != 0 && at >= through) {
				continue
			}
			round := i + 1
			ask := TimelineEntry{Kind: "ask", At: at, Convorel: id, Round: round}
			ask.body(run.Input, fmt.Sprintf("ask:%s:%d", id, round))
			ask.Ord = timelineOrd(at, 0, ask.Ref)
			out = append(out, convorelText{ask, run.Input})
			review := TimelineEntry{Kind: "review", At: at + 1, Convorel: id, Round: round, Model: run.ObservedModel, State: run.State}
			text := run.Error
			switch run.State {
			case "prepared":
				// A persisted send intent is not proof that delivery succeeded or
				// failed. Only a run without that intent is known to be unsent.
				if run.SubmittedAt != "" || run.Delivery.RequestSent {
					review.State = "delivery_unknown"
				} else {
					review.State = "not_sent"
				}
			case "delivered":
				review.State = "waiting"
				if run.Error != "" {
					review.State = "blocked"
				}
			case "complete":
				review.State = "incomplete"
				if run.Reply.Final {
					review.State, text = "complete", run.Reply.Markdown
				}
			case "rejected", "delivery_unknown", "failed", "blocked", "superseded", "lost":
				// Preserve the provider's unsuccessful outcome and its reason.
			default:
				review.State = "unknown"
			}
			if run.State == "failed" || (run.State == "complete" && run.Reply.Final) {
				if observed := convorelMillis(run.LastObservedAt); observed != 0 {
					review.At = observed
				}
			}
			review.body(text, fmt.Sprintf("review:%s:%d", id, round))
			review.Ord = timelineOrd(review.At, 0, review.Ref)
			out = append(out, convorelText{review, text})
		}
	}
	return out, represented, nil
}
