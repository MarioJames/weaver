package daemon

import (
	"context"
	"encoding/json"
	"time"

	"github.com/MarioJames/weaver/internal/engine"
	"github.com/MarioJames/weaver/internal/kernel"
)

// handler serves one method. send writes an extra reply line for streaming
// methods; a non-nil result is written as the final line.
type handler func(s *Server, ctx context.Context, params json.RawMessage, send func(any) error) (any, error)

// decode parses params into a typed struct.
func decode[T any](params json.RawMessage) (T, error) {
	var v T
	if len(params) == 0 || string(params) == "null" {
		return v, nil
	}
	if err := json.Unmarshal(params, &v); err != nil {
		return v, &kernel.Error{Code: "INVALID", Message: "参数格式不对：" + err.Error()}
	}
	return v, nil
}

// simple adapts a typed function to a handler.
func simple[P any](fn func(s *Server, p P) (any, error)) handler {
	return func(s *Server, _ context.Context, params json.RawMessage, _ func(any) error) (any, error) {
		p, err := decode[P](params)
		if err != nil {
			return nil, err
		}
		return fn(s, p)
	}
}

type ok struct {
	OK bool `json:"ok"`
}

type missionView struct {
	*kernel.Mission
	Packages []*kernel.Package `json:"packages"`
	Timers   []kernel.Timer    `json:"timers"`
}

var methods = map[string]handler{
	"status": simple(func(s *Server, _ struct{}) (any, error) {
		overview, err := s.kernel.Overview()
		if err != nil {
			return nil, err
		}
		accounts, err := s.kernel.Accounts()
		if err != nil {
			return nil, err
		}
		workers, err := s.kernel.Workers()
		if err != nil {
			return nil, err
		}
		settings, _ := s.kernel.Settings()
		return map[string]any{
			"version": Version, "home": s.home, "pid": pid(), "startedAt": s.started.UnixMilli(),
			"overview": overview, "accounts": s.withResidents(accounts), "workers": workers,
			"residents": s.engines.Resident.Status(), "settings": settings,
		}, nil
	}),

	"mission.create": simple(func(s *Server, p struct {
		Key       string         `json:"key"`
		Title     string         `json:"title"`
		Workspace string         `json:"workspace"`
		Notify    *kernel.Notify `json:"notify"`
	}) (any, error) {
		return s.kernel.CreateMission(p.Key, p.Title, p.Workspace, p.Notify)
	}),
	"mission.list": simple(func(s *Server, p struct {
		All bool `json:"all"`
	}) (any, error) {
		return emptyIfNil(s.kernel.Missions(p.All))
	}),
	"mission.show": simple(func(s *Server, p struct {
		ID string `json:"id"`
	}) (any, error) {
		m, err := s.kernel.Mission(p.ID)
		if err != nil {
			return nil, err
		}
		packages, err := s.kernel.Packages(p.ID)
		if err != nil {
			return nil, err
		}
		timers, err := s.kernel.Timers(p.ID)
		if err != nil {
			return nil, err
		}
		if packages == nil {
			packages = []*kernel.Package{}
		}
		return missionView{Mission: m, Packages: packages, Timers: timers}, nil
	}),
	"mission.close": simple(func(s *Server, p struct {
		ID string `json:"id"`
	}) (any, error) {
		return s.kernel.CloseMission(p.ID)
	}),

	"plan.submit": simple(func(s *Server, p struct {
		Key string `json:"key"`
		kernel.PlanInput
	}) (any, error) {
		return s.kernel.SubmitPlan(p.Key, p.PlanInput)
	}),

	"dialogue.start": simple(func(s *Server, p struct {
		Key string `json:"key"`
		kernel.DialogueInput
	}) (any, error) {
		return s.kernel.StartDialogue(p.Key, p.DialogueInput)
	}),
	"dialogue.show": simple(func(s *Server, p struct {
		Mission string `json:"mission"`
		Name    string `json:"name"`
	}) (any, error) {
		return s.kernel.Dialogue(p.Mission, p.Name)
	}),

	"package.show": simple(func(s *Server, p struct {
		Package string `json:"package"`
	}) (any, error) {
		id, err := s.kernel.ResolvePackage(p.Package)
		if err != nil {
			return nil, err
		}
		return s.kernel.Package(id)
	}),
	"package.list": simple(func(s *Server, p struct {
		Mission string `json:"mission"`
	}) (any, error) {
		return emptyIfNil(s.kernel.Packages(p.Mission))
	}),

	"events": func(s *Server, ctx context.Context, params json.RawMessage, send func(any) error) (any, error) {
		p, err := decode[struct {
			Mission string `json:"mission"`
			After   int64  `json:"after"`
			Limit   int    `json:"limit"`
			Follow  bool   `json:"follow"`
		}](params)
		if err != nil {
			return nil, err
		}
		events, err := s.kernel.Events(p.Mission, p.After, p.Limit)
		if err != nil {
			return nil, err
		}
		if events == nil {
			events = []kernel.Event{}
		}
		if !p.Follow {
			return events, nil
		}
		for {
			if len(events) > 0 {
				if err := send(events); err != nil {
					return nil, nil
				}
				p.After = events[len(events)-1].Seq
			}
			if events, err = s.kernel.Follow(ctx, p.Mission, p.After); err != nil {
				return nil, err
			}
		}
	},

	"wait": func(s *Server, ctx context.Context, params json.RawMessage, _ func(any) error) (any, error) {
		p, err := decode[struct {
			Mission   string `json:"mission"`
			Cursor    *int64 `json:"cursor"`
			TimeoutMs int64  `json:"timeoutMs"`
		}](params)
		if err != nil {
			return nil, err
		}
		return s.kernel.Wait(ctx, p.Mission, p.Cursor, time.Duration(p.TimeoutMs)*time.Millisecond)
	},

	"verdict": simple(func(s *Server, p struct {
		Package string `json:"package"`
		Verdict string `json:"verdict"`
		Note    string `json:"note"`
	}) (any, error) {
		id, err := s.kernel.ResolvePackage(p.Package)
		if err != nil {
			return nil, err
		}
		return s.kernel.Verdict(id, p.Verdict, p.Note)
	}),
	"retry": simple(func(s *Server, p struct {
		Package string `json:"package"`
		Note    string `json:"note"`
	}) (any, error) {
		id, err := s.kernel.ResolvePackage(p.Package)
		if err != nil {
			return nil, err
		}
		return s.kernel.Retry(id, p.Note)
	}),
	"cancel": simple(func(s *Server, p struct {
		Mission string `json:"mission"`
		Package string `json:"package"`
	}) (any, error) {
		if p.Package == "" && p.Mission == "" {
			return nil, &kernel.Error{Code: "INVALID", Message: "取消需要 --package 或 --mission"}
		}
		id := ""
		if p.Package != "" {
			var err error
			if id, err = s.kernel.ResolvePackage(p.Package); err != nil {
				return nil, err
			}
		}
		return s.kernel.Cancel(p.Mission, id)
	}),

	"timer.set": simple(func(s *Server, p struct {
		Key     string `json:"key"`
		Mission string `json:"mission"`
		DueAt   int64  `json:"dueAt"`
		InMs    int64  `json:"inMs"`
		Note    string `json:"note"`
	}) (any, error) {
		due := time.UnixMilli(p.DueAt)
		if p.DueAt == 0 {
			due = time.Now().Add(time.Duration(p.InMs) * time.Millisecond)
		}
		return s.kernel.SetTimer(p.Key, p.Mission, due, p.Note)
	}),
	"timer.list": simple(func(s *Server, p struct {
		Mission string `json:"mission"`
	}) (any, error) {
		return s.kernel.Timers(p.Mission)
	}),
	"timer.cancel": simple(func(s *Server, p struct {
		ID string `json:"id"`
	}) (any, error) {
		return ok{true}, s.kernel.CancelTimer(p.ID)
	}),
	"wake": simple(func(s *Server, p struct {
		Key     string `json:"key"`
		Mission string `json:"mission"`
		Note    string `json:"note"`
	}) (any, error) {
		return s.kernel.Wake(p.Key, p.Mission, p.Note)
	}),

	"account.list": simple(func(s *Server, _ struct{}) (any, error) {
		accounts, err := s.kernel.Accounts()
		if err != nil {
			return nil, err
		}
		return s.withResidents(accounts), nil
	}),
	"account.add": simple(func(s *Server, p kernel.AccountInput) (any, error) { return s.kernel.AddAccount(p) }),
	"account.set": simple(func(s *Server, p struct {
		ID string `json:"id"`
		kernel.AccountPatch
	}) (any, error) {
		return s.kernel.UpdateAccount(p.ID, p.AccountPatch)
	}),
	"account.remove": simple(func(s *Server, p struct {
		ID string `json:"id"`
	}) (any, error) {
		if err := s.kernel.RemoveAccount(p.ID); err != nil {
			return nil, err
		}
		s.engines.Resident.Stop(p.ID)
		return ok{true}, nil
	}),
	"account.check": simple(func(s *Server, p struct {
		ID string `json:"id"`
	}) (any, error) {
		if p.ID != "" {
			s.kernel.CheckAccounts(p.ID)
			return s.kernel.Account(p.ID)
		}
		s.kernel.CheckAccounts()
		accounts, err := s.kernel.Accounts()
		if err != nil {
			return nil, err
		}
		return s.withResidents(accounts), nil
	}),
	"account.pause": simple(func(s *Server, p struct {
		ID     string `json:"id"`
		ForMs  int64  `json:"forMs"`
		Reason string `json:"reason"`
	}) (any, error) {
		return s.kernel.PauseAccount(p.ID, time.Now().Add(time.Duration(p.ForMs)*time.Millisecond), p.Reason)
	}),
	"account.resume": simple(func(s *Server, p struct {
		ID string `json:"id"`
	}) (any, error) {
		return s.kernel.ResumeAccount(p.ID)
	}),
	// account.login returns the native sign-in command; the CLI runs it in the user's terminal.
	"account.login": simple(func(s *Server, p struct {
		ID string `json:"id"`
	}) (any, error) {
		a, err := s.kernel.EngineAccount(p.ID)
		if err != nil {
			return nil, err
		}
		argv, env, err := engine.LoginCommand(a)
		if err != nil {
			return nil, &kernel.Error{Code: "INVALID", Message: err.Error()}
		}
		return map[string]any{"argv": argv, "env": env, "authDir": a.AuthDir}, nil
	}),
	"account.import": simple(func(s *Server, p struct {
		Path  string `json:"path"`
		Owner string `json:"owner"`
	}) (any, error) {
		return s.kernel.ImportLegacy(p.Path, p.Owner)
	}),

	"worker.list":   simple(func(s *Server, _ struct{}) (any, error) { return s.kernel.Workers() }),
	"worker.set":    simple(func(s *Server, p kernel.WorkerInput) (any, error) { return s.kernel.SetWorker(p) }),
	"worker.remove": simple(func(s *Server, p struct{ ID string }) (any, error) { return ok{true}, s.kernel.RemoveWorker(p.ID) }),

	"config.list": simple(func(s *Server, _ struct{}) (any, error) { return s.kernel.Settings() }),
	"config.set": simple(func(s *Server, p struct {
		Key   string `json:"key"`
		Value string `json:"value"`
	}) (any, error) {
		if err := s.kernel.SetSetting(p.Key, p.Value); err != nil {
			return nil, err
		}
		return s.kernel.Settings()
	}),

	"engine.list": simple(func(s *Server, _ struct{}) (any, error) { return s.engines.Resident.Status(), nil }),
	"engine.start": simple(func(s *Server, p struct {
		Account string `json:"account"`
	}) (any, error) {
		a, err := s.kernel.EngineAccount(p.Account)
		if err != nil {
			return nil, err
		}
		if a.Engine != "opencode" || a.Kind != "subscription" {
			return nil, &kernel.Error{Code: "INVALID", Message: "只有 opencode 订阅账号有常驻服务"}
		}
		s.engines.Resident.Ensure(a)
		return s.engines.Resident.Status(), nil
	}),
	"engine.stop": simple(func(s *Server, p struct {
		Account string `json:"account"`
	}) (any, error) {
		if !s.engines.Resident.Stop(p.Account) {
			return nil, &kernel.Error{Code: "NOT_FOUND", Message: "账号 " + p.Account + " 没有常驻服务"}
		}
		return s.engines.Resident.Status(), nil
	}),

	"backup": simple(func(s *Server, _ struct{}) (any, error) {
		path, err := s.kernel.Backup(true)
		if err != nil {
			return nil, err
		}
		return map[string]string{"path": path}, nil
	}),
}

func emptyIfNil[T any](list []T, err error) (any, error) {
	if err != nil {
		return nil, err
	}
	if list == nil {
		list = []T{}
	}
	return list, nil
}

func (s *Server) withResidents(accounts []*kernel.Account) []*kernel.Account {
	states := map[string]string{}
	for _, r := range s.engines.Resident.Status() {
		states[r.AccountID] = r.State
	}
	for _, a := range accounts {
		a.Resident = states[a.ID]
	}
	return accounts
}
