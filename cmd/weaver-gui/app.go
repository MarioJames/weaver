// 后续账号/候选页面可复用 a.snapshot（服务 status 的统一快照）、a.client.call、
// a.write（异步写操作并立即刷新）、a.action（带忙碌/错误状态的异步任务）。
// view 和异步完成回调都持有 a.mu；后台任务只使用捕获的参数，不直接访问界面状态。
package main

import (
	"context"
	"sync"
	"time"

	"github.com/MarioJames/weaver/internal/rpc"
	"github.com/egoist/mygo/ui"
	"github.com/lobehub/lobe-mygo/pkg/theme"
)

// Wire-only models keep the desktop client independent of the service kernel.
// 新页面直接复用这些字段；认证秘密从不出现在 status 的快照里。
type account struct {
	ID          string `json:"id"`
	Engine      string `json:"engine"`
	Kind        string `json:"kind"`
	Label       string `json:"label,omitempty"`
	AuthDir     string `json:"authDir,omitempty"`
	HasAPIKey   bool   `json:"hasApiKey,omitempty"`
	HasConfig   bool   `json:"hasConfig,omitempty"`
	BaseURL     string `json:"baseUrl,omitempty"`
	Provider    string `json:"provider,omitempty"`
	Protocol    string `json:"protocol,omitempty"`
	Enabled     bool   `json:"enabled"`
	Ready       bool   `json:"ready"`
	ReadyReason string `json:"readyReason,omitempty"`
	CheckedAt   int64  `json:"checkedAt,omitempty"`
	PausedUntil int64  `json:"pausedUntil,omitempty"`
	PauseReason string `json:"pauseReason,omitempty"`
	Running     int    `json:"running"`
	Resident    string `json:"resident,omitempty"`
	Usage       *usage `json:"usage,omitempty"`
}
type usage struct {
	Month             usageTotals  `json:"month"`
	Models            []modelUsage `json:"models"`
	Balance           *float64     `json:"balance,omitempty"`
	BalanceAt         int64        `json:"balanceAt,omitempty"`
	AlertBelow        *float64     `json:"alertBelow,omitempty"`
	SpentSinceBalance *float64     `json:"spentSinceBalance,omitempty"`
	Remaining         *float64     `json:"remaining,omitempty"`
	Low               bool         `json:"low,omitempty"`
}
type usageTotals struct {
	Runs             int      `json:"runs"`
	InputTokens      int64    `json:"inputTokens"`
	OutputTokens     int64    `json:"outputTokens"`
	CacheReadTokens  int64    `json:"cacheReadTokens"`
	CacheWriteTokens int64    `json:"cacheWriteTokens"`
	Cost             *float64 `json:"cost,omitempty"`
	Unpriced         int      `json:"unpriced,omitempty"`
}
type modelUsage struct {
	Model    string      `json:"model"`
	Prices   usagePrices `json:"prices"`
	Runs     int         `json:"runs"`
	Cost     *float64    `json:"cost,omitempty"`
	Unpriced int         `json:"unpriced,omitempty"`
}
type usagePrices struct {
	Input      *float64 `json:"input,omitempty"`
	Output     *float64 `json:"output,omitempty"`
	CacheRead  *float64 `json:"cacheRead,omitempty"`
	CacheWrite *float64 `json:"cacheWrite,omitempty"`
}
type worker struct {
	ID          string   `json:"id"`
	Engine      string   `json:"engine"`
	Model       string   `json:"model"`
	Effort      string   `json:"effort,omitempty"`
	Weight      int      `json:"weight"`
	MaxParallel int      `json:"maxParallel,omitempty"`
	Enabled     bool     `json:"enabled"`
	Accounts    []string `json:"accounts"`
	Description string   `json:"description,omitempty"`
	Running     int      `json:"running"`
	Available   bool     `json:"available"`
	Reason      string   `json:"reason,omitempty"`
}
type overview struct {
	Missions int            `json:"openMissions"`
	Packages map[string]int `json:"packages"`
	Active   int            `json:"active"`
	Capacity int            `json:"capacity"`
	Timers   int            `json:"timers"`
}
type resident struct {
	AccountID string `json:"accountId"`
	State     string `json:"state"`
	Reason    string `json:"reason"`
	Port      int    `json:"port"`
	Sessions  int    `json:"sessions"`
}
type snapshot struct {
	Version   string            `json:"version"`
	PID       int               `json:"pid"`
	StartedAt int64             `json:"startedAt"`
	Home      string            `json:"home"`
	Accounts  []account         `json:"accounts"`
	Workers   []worker          `json:"workers"`
	Settings  map[string]string `json:"settings"`
	Residents []resident        `json:"residents"`
	Overview  overview          `json:"overview"`
}
type settingField struct {
	value string
	dirty bool
	err   string
}
type app struct {
	mu            sync.Mutex
	refreshMu     sync.Mutex
	client        client
	snapshot      snapshot
	page          string
	loaded        bool
	offline       bool
	reason        string
	busy          map[string]bool
	errors        map[string]string
	fields        map[string]*settingField
	toast         string
	toastUntil    time.Time
	confirming    bool
	confirmTitle  string
	confirmBody   string
	confirmAction func()
	skillState    string
	skillChecked  bool
	ctx           context.Context
	cancel        context.CancelFunc
	invalidate    func()
	wg            sync.WaitGroup
}

func newApp() *app {
	ctx, cancel := context.WithCancel(context.Background())
	return &app{client: client{rpc.Home()}, page: "概览", busy: map[string]bool{}, errors: map[string]string{}, fields: map[string]*settingField{}, ctx: ctx, cancel: cancel, skillState: "未安装"}
}
func (a *app) close() { a.cancel() }
func (a *app) notify() {
	if a.invalidate != nil {
		a.invalidate()
	}
}
func (a *app) start() {
	a.wg.Add(1)
	go func() {
		defer a.wg.Done()
		a.refresh()
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-a.ctx.Done():
				return
			case <-ticker.C:
				a.refresh()
			}
		}
	}()
}
func (a *app) refresh() {
	a.refreshMu.Lock()
	defer a.refreshMu.Unlock()
	if a.ctx.Err() != nil {
		return
	}
	var next snapshot
	err := a.client.call("status", nil, &next)
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.ctx.Err() != nil {
		return
	}
	if err != nil {
		a.offline = unavailable(err)
		if a.offline {
			a.confirming = false
		}
		a.reason = err.Error()
	} else {
		a.snapshot = next
		a.loaded = true
		a.offline = false
		a.reason = ""
		for _, key := range []string{"max_parallel", "stall_seconds", "resident", "standby"} {
			f := a.fields[key]
			if f == nil {
				f = &settingField{}
				a.fields[key] = f
			}
			if !f.dirty && !a.busy["config:"+key] {
				f.value = next.Settings[key]
			}
		}
	}
	a.notify()
}

// action 必须在界面线程（持有 a.mu）调用。work 在后台执行，done 在锁内处理结果。
func (a *app) action(key string, work func() (string, error), done func(string, error)) {
	if a.busy[key] {
		return
	}
	a.busy[key] = true
	delete(a.errors, key)
	a.wg.Add(1)
	go func() {
		defer a.wg.Done()
		message, err := work()
		a.mu.Lock()
		defer a.mu.Unlock()
		if a.ctx.Err() != nil {
			return
		}
		a.busy[key] = false
		if err != nil {
			a.errors[key] = err.Error()
		}
		if done != nil {
			done(message, err)
		} else if err == nil && message != "" {
			a.showToast(message)
		}
		a.notify()
	}()
}
func (a *app) write(key, method string, params any) {
	a.action(key, func() (string, error) {
		err := a.client.call(method, params, nil)
		if err == nil {
			a.refresh()
		}
		return "", err
	}, nil)
}
func (a *app) view(c *ui.Context) {
	a.mu.Lock()
	defer a.mu.Unlock()
	theme.Apply(c)
	// The tester has no native Window to invalidate. Its clock pumps pending results.
	if a.invalidate == nil {
		c.After(100 * time.Millisecond)
	}
	tk := theme.TokensOf(c)
	width, _ := c.Size()
	compact := width < 900
	var root ui.Element
	if compact {
		root = ui.Column(c)
	} else {
		root = ui.Row(c)
	}
	root.Fill().AlignItems(ui.Stretch).Padding(8).Gap(8).Background(tk.BgLayout)
	root.Children(func() {
		a.navigation(c, compact)
		card := ui.Column(c).Grow(1).Basis(0).MinWidth(0).MinHeight(0).Background(tk.BgContainer).
			Radius(tk.BorderRadiusLG).Border(1, tk.BorderSecondary).Clip()
		card.Children(func() {
			if a.offline {
				a.serviceUnavailable(c)
				return
			}
			padding, gap := float32(24), float32(16)
			if compact {
				padding, gap = 16, 14
			}
			ui.Scroll(c.Key(a.page)).Grow(1).Basis(0).MinHeight(0).Children(func() {
				ui.Column(c).Padding(padding).Gap(gap).Children(func() {
					if !a.loaded {
						stateLoading(c, "正在连接服务")
						fieldError(c, a.reason)
						return
					}
					fieldError(c, a.reason)
					switch a.page {
					case "概览":
						a.overviewPage(c)
					case "任务":
						a.tasksPage(c)
					case "账号":
						a.accountsPage(c)
					case "候选":
						a.workersPage(c)
					case "设置":
						a.settingsPage(c)
					}
				})
			})
		})
		a.toastView(c)
	})
	a.confirmView(c)
}
