package kernel

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/MarioJames/weaver/internal/quota"
)

// AccountQuota is the public, credential-free quota view.
type AccountQuota struct {
	Status    string         `json:"status"`
	Windows   []quota.Window `json:"windows"`
	Detail    string         `json:"detail,omitempty"`
	CheckedAt int64          `json:"checkedAt,omitempty"`
	Error     string         `json:"error,omitempty"`
	Factor    float64        `json:"factor"`
}

func supportsQuota(engine, kind string) bool {
	return kind == "subscription" && (engine == "codex" || engine == "claude" || engine == "opencode")
}
func parseQuota(raw string) *quota.Snapshot {
	var s quota.Snapshot
	if raw == "" || json.Unmarshal([]byte(raw), &s) != nil {
		return nil
	}
	return &s
}
func quotaView(raw string, checked int64, message string, now time.Time) *AccountQuota {
	s := parseQuota(raw)
	v := &AccountQuota{Status: "unknown", Windows: []quota.Window{}, CheckedAt: checked, Error: message, Factor: quota.Factor(s, "", now)}
	if s != nil {
		v.Status, v.Windows, v.Detail = s.Status, s.Windows, s.Detail
	}
	return v
}

// RefreshQuota performs network I/O outside the kernel transaction. Probe errors
// are stored in the view; they never change credential readiness.
func (k *Kernel) RefreshQuota(id string) (*Account, error) {
	return k.refreshQuota(context.Background(), id)
}
func (k *Kernel) refreshQuota(ctx context.Context, id string) (*Account, error) {
	a, err := k.EngineAccount(id)
	if err != nil {
		return nil, err
	}
	if !supportsQuota(a.Engine, a.Kind) {
		return nil, errf("UNSUPPORTED", "只有 Codex、Claude、OpenCode 的订阅账号有额度窗口")
	}
	s, fetchErr := k.quotaClient.Fetch(ctx, quota.Source{Engine: a.Engine, AuthDir: a.AuthDir}, k.now())
	message := ""
	if fetchErr != nil {
		message = "额度读取失败"
		var qe *quota.Error
		if errors.As(fetchErr, &qe) {
			message = qe.Message
			if qe.Kind == "renewal_pending" {
				message = "访问令牌已到期，等待引擎下次运行续期"
			}
		}
	}
	var raw []byte
	if fetchErr == nil {
		raw, err = json.Marshal(s)
		if err != nil {
			return nil, err
		}
	}
	err = k.write(func(t *tx) error {
		if fetchErr != nil {
			_, err := t.Exec("UPDATE accounts SET quota_error=? WHERE id=?", message, id)
			return err
		}
		_, err := t.Exec("UPDATE accounts SET quota=?, quota_checked_at=?, quota_error='' WHERE id=?", string(raw), t.now, id)
		return err
	})
	if err != nil {
		return nil, err
	}
	return k.Account(id)
}

// RefreshQuotas refreshes one account or all supported accounts, including
// disabled ones for an explicit request. One probe failure does not stop a batch.
func (k *Kernel) RefreshQuotas(id string) ([]*Account, error) {
	accounts, err := k.refreshQuotas(context.Background(), id, false)
	if err != nil {
		return nil, err
	}
	if err := k.Dispatch(); err != nil {
		return nil, err
	}
	return accounts, nil
}
func (k *Kernel) refreshQuotas(ctx context.Context, id string, enabledOnly bool) ([]*Account, error) {
	if id != "" {
		a, err := k.refreshQuota(ctx, id)
		if err != nil {
			return nil, err
		}
		return []*Account{a}, nil
	}
	accounts, err := k.Accounts()
	if err != nil {
		return nil, err
	}
	out := []*Account{}
	for _, a := range accounts {
		if !supportsQuota(a.Engine, a.Kind) || (enabledOnly && !a.Enabled) {
			continue
		}
		if ctx.Err() != nil {
			break
		}
		refreshed, err := k.refreshQuota(ctx, a.ID)
		if err != nil {
			continue
		}
		out = append(out, refreshed)
	}
	return out, nil
}
func (k *Kernel) quotaLoop() {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-k.stop:
			cancel()
		case <-done:
		}
	}()
	delay := 10 * time.Second
	for {
		timer := time.NewTimer(delay)
		select {
		case <-k.stop:
			timer.Stop()
			return
		case <-timer.C:
		}
		_, _ = k.refreshQuotas(ctx, "", true)
		if ctx.Err() != nil {
			return
		}
		if err := k.Dispatch(); err != nil {
			k.log.Error("quota dispatch failed", "err", err)
		}
		delay = 5 * time.Minute
	}
}
func quotaExhaustedReason(name string, s *quota.Snapshot, model string, now time.Time) string {
	reason := fmt.Sprintf("账号「%s」额度已用完", name)
	var reset int64
	if s != nil {
		for _, w := range s.Windows {
			if w.UsedPercent < 100 || w.ResetsAt <= now.UnixMilli() {
				continue
			}
			if w.Scope != "account" && !(w.Scope == "model" && model != "" && w.Model != "" &&
				(strings.Contains(strings.ToLower(model), strings.ToLower(w.Model)) || strings.Contains(strings.ToLower(w.Model), strings.ToLower(model)))) {
				continue
			}
			// All blocking windows must reset before this route can run.
			if w.ResetsAt > reset {
				reset = w.ResetsAt
			}
		}
	}
	if reset != 0 {
		reason += "，" + time.UnixMilli(reset).Local().Format("15:04") + " 重置"
	}
	return reason
}
