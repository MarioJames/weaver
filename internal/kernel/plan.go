package kernel

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var keyPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

const maxInstruction = 60000

// CreateMission registers a root task. notify may be nil. A repeated key
// returns the mission created the first time.
func (k *Kernel) CreateMission(key, title, workspace string, notify *Notify) (*Mission, error) {
	title = strings.TrimSpace(title)
	if title == "" {
		return nil, errf("INVALID", "主任务需要标题")
	}
	if err := checkWorkspace(workspace); err != nil {
		return nil, err
	}
	out := &Mission{}
	err := k.keyed(key, "mission.create", out, func(t *tx) error {
		id := newID("m_")
		session, pane := "", ""
		if notify != nil {
			session, pane = notify.Session, notify.Pane
		}
		if _, err := t.Exec(`INSERT INTO missions(id, title, workspace, notify_session, notify_pane, created_at) VALUES(?,?,?,?,?,?)`,
			id, clip(title, 200), workspace, session, pane, t.now); err != nil {
			return err
		}
		m, err := getMission(t, id)
		if err != nil {
			return err
		}
		*out = *m
		// The parent agent decomposes next; engines can load the workspace meanwhile.
		t.warms = append(t.warms, workspace)
		return nil
	})
	return out, err
}

func checkWorkspace(dir string) error {
	if !filepath.IsAbs(dir) {
		return errf("INVALID", "工作目录必须是绝对路径：%q", dir)
	}
	info, err := os.Stat(dir)
	if err != nil || !info.IsDir() {
		return errf("INVALID", "工作目录不存在或不是目录：%s", dir)
	}
	return nil
}

// SubmitPlan creates every package of a decomposition in one transaction and
// releases the ones that have nothing to wait for. A plan with a dependency
// cycle, an unknown dependency or a duplicate key creates nothing.
func (k *Kernel) SubmitPlan(key string, in PlanInput) (*PlanResult, error) {
	out := &PlanResult{}
	if err := k.keyed(key, "plan.submit", out, func(t *tx) error { return t.createPlan(&in, out) }); err != nil {
		return nil, err
	}
	return out, nil
}

// createPlan validates a plan and creates its packages inside the caller's transaction.
func (t *tx) createPlan(in *PlanInput, out *PlanResult) error {
	m, err := getMission(t, in.Mission)
	if err != nil {
		return err
	}
	if m.ClosedAt != 0 {
		return errf("CLOSED", "主任务 %s 已关闭", m.ID)
	}
	if len(in.Packages) == 0 {
		return errf("INVALID", "计划里没有工作包")
	}
	existing := map[string]string{}
	rows, err := t.Query(`SELECT key, id FROM packages WHERE mission_id=?`, m.ID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var key, id string
		if err := rows.Scan(&key, &id); err != nil {
			rows.Close()
			return err
		}
		existing[key] = id
	}
	rows.Close()

	ids := map[string]string{}
	for i := range in.Packages {
		p := &in.Packages[i]
		p.Key = strings.TrimSpace(p.Key)
		if !keyPattern.MatchString(p.Key) {
			return errf("INVALID", "第 %d 个包的 key %q 不合法：只能用字母、数字、点、下划线和连字符，最长 64", i+1, p.Key)
		}
		if _, dup := ids[p.Key]; dup {
			return errf("INVALID", "计划里 key %q 重复", p.Key)
		}
		if _, dup := existing[p.Key]; dup {
			return errf("INVALID", "主任务里已经有 key 为 %q 的包", p.Key)
		}
		if strings.TrimSpace(p.Instruction) == "" {
			return errf("INVALID", "包 %s 没有指令", p.Key)
		}
		if len(p.Instruction) > maxInstruction {
			return errf("INVALID", "包 %s 的指令超过 %d 字节", p.Key, maxInstruction)
		}
		if strings.TrimSpace(p.Title) == "" {
			p.Title = p.Key
		}
		if p.Workspace == "" {
			p.Workspace = m.Workspace
		}
		if err := checkWorkspace(p.Workspace); err != nil {
			return errf("INVALID", "包 %s：%s", p.Key, AsError(err).Message)
		}
		if p.Worker != "" {
			var n int
			if err := t.QueryRow(`SELECT COUNT(*) FROM workers WHERE id=?`, p.Worker).Scan(&n); err != nil {
				return err
			}
			if n == 0 {
				return errf("INVALID", "包 %s 指定的候选 %s 不存在", p.Key, p.Worker)
			}
		}
		if p.Engine != "" && p.Worker == "" {
			var n int
			if err := t.QueryRow(`SELECT COUNT(*) FROM workers WHERE engine=?`, p.Engine).Scan(&n); err != nil {
				return err
			}
			if n == 0 {
				return errf("INVALID", "包 %s 指定的引擎 %s 没有候选", p.Key, p.Engine)
			}
		}
		ids[p.Key] = newID("p_")
		if p.Workspace != m.Workspace {
			t.warms = append(t.warms, p.Workspace)
		}
	}
	graph := map[string][]string{}
	for _, p := range in.Packages {
		seen := map[string]bool{}
		for _, dep := range p.DependsOn {
			if dep == p.Key {
				return errf("CYCLE", "依赖成环：%s → %s", p.Key, p.Key)
			}
			if seen[dep] {
				continue
			}
			seen[dep] = true
			if _, ok := ids[dep]; ok {
				graph[p.Key] = append(graph[p.Key], dep)
			} else if _, ok := existing[dep]; !ok {
				return errf("INVALID", "包 %s 依赖的 %s 不在这份计划里，也不在主任务已有的包里", p.Key, dep)
			}
		}
	}
	if cycle := findCycle(in.Packages, graph); cycle != nil {
		return errf("CYCLE", "依赖成环：%s。整份计划未创建", strings.Join(cycle, " → "))
	}

	var position int
	if err := t.QueryRow(`SELECT COALESCE(MAX(position),0) FROM packages WHERE mission_id=?`, m.ID).Scan(&position); err != nil {
		return err
	}
	for _, p := range in.Packages {
		position++
		if _, err := t.Exec(`INSERT INTO packages(id, mission_id, key, title, instruction, workspace, worker, engine, state, position, created_at, updated_at, advisory, auto_accept)
			VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, ids[p.Key], m.ID, p.Key, clip(p.Title, 200), p.Instruction, p.Workspace, p.Worker, p.Engine, StatePending, position, t.now, t.now, b2i(p.Advisory), b2i(p.AutoAccept)); err != nil {
			return err
		}
	}
	for _, p := range in.Packages {
		seen := map[string]bool{}
		for _, dep := range p.DependsOn {
			if seen[dep] {
				continue
			}
			seen[dep] = true
			target := ids[dep]
			if target == "" {
				target = existing[dep]
			}
			if _, err := t.Exec(`INSERT INTO package_deps(package_id, depends_on) VALUES(?,?)`, ids[p.Key], target); err != nil {
				return err
			}
		}
	}
	if _, err := t.event(m.ID, "", 0, EvPlan, fmt.Sprintf("提交计划：%d 个工作包", len(in.Packages))); err != nil {
		return err
	}
	if err := t.dispatch(); err != nil {
		return err
	}
	*out = PlanResult{Mission: m.ID}
	for _, p := range in.Packages {
		pkg, err := loadPackage(t, ids[p.Key], false)
		if err != nil {
			return err
		}
		pkg.Instruction = ""
		out.Packages = append(out.Packages, pkg)
	}
	return t.QueryRow(`SELECT COALESCE(MAX(seq),0) FROM events WHERE mission_id=?`, m.ID).Scan(&out.Cursor)
}

// findCycle returns the keys along one dependency cycle, or nil.
func findCycle(packages []PackageInput, graph map[string][]string) []string {
	const (
		white = iota
		grey
		black
	)
	color := map[string]int{}
	var stack []string
	var visit func(key string) []string
	visit = func(key string) []string {
		color[key] = grey
		stack = append(stack, key)
		for _, dep := range graph[key] {
			switch color[dep] {
			case grey:
				for i, k := range stack {
					if k == dep {
						return append(append([]string{}, stack[i:]...), dep)
					}
				}
			case white:
				if cycle := visit(dep); cycle != nil {
					return cycle
				}
			}
		}
		stack = stack[:len(stack)-1]
		color[key] = black
		return nil
	}
	for _, p := range packages {
		if color[p.Key] == white {
			if cycle := visit(p.Key); cycle != nil {
				return cycle
			}
		}
	}
	return nil
}

func loadPackage(q querier, id string, withAttempts bool) (*Package, error) {
	p, err := getPackage(q, id)
	if err != nil {
		return nil, err
	}
	if p.DependsOn, err = depKeys(q, id); err != nil {
		return nil, err
	}
	attempts, err := listAttempts(q, id)
	if err != nil {
		return nil, err
	}
	if len(attempts) > 0 {
		p.Current = attempts[len(attempts)-1]
	}
	if withAttempts {
		p.Attempts = attempts
	}
	return p, nil
}

// Mission returns a mission with its package counts.
func (k *Kernel) Mission(id string) (*Mission, error) {
	var m *Mission
	err := k.read(func() (err error) { m, err = getMission(k.db, id); return })
	return m, err
}

// Missions lists missions, newest first. Closed missions are included only when all is set.
func (k *Kernel) Missions(all bool) ([]*Mission, error) {
	var out []*Mission
	err := k.read(func() error {
		query := `SELECT id FROM missions WHERE closed_at IS NULL ORDER BY created_at DESC`
		if all {
			query = `SELECT id FROM missions ORDER BY created_at DESC`
		}
		ids, err := queryStrings(k.db, query)
		if err != nil {
			return err
		}
		for _, id := range ids {
			m, err := getMission(k.db, id)
			if err != nil {
				return err
			}
			out = append(out, m)
		}
		return nil
	})
	return out, err
}

func queryStrings(q querier, query string, args ...any) ([]string, error) {
	rows, err := q.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// Packages lists a mission's packages in plan order, without instructions or results.
func (k *Kernel) Packages(mission string) ([]*Package, error) {
	var out []*Package
	err := k.read(func() error {
		if _, err := getMission(k.db, mission); err != nil {
			return err
		}
		ids, err := queryStrings(k.db, `SELECT id FROM packages WHERE mission_id=? ORDER BY position`, mission)
		if err != nil {
			return err
		}
		for _, id := range ids {
			p, err := loadPackage(k.db, id, false)
			if err != nil {
				return err
			}
			p.Instruction = ""
			if p.Current != nil {
				p.Current.Result = clip(p.Current.Result, 300)
			}
			out = append(out, p)
		}
		return nil
	})
	return out, err
}

// Package returns one package with every attempt.
func (k *Kernel) Package(id string) (*Package, error) {
	var p *Package
	err := k.read(func() (err error) { p, err = loadPackage(k.db, id, true); return })
	return p, err
}

// Events returns a mission's events after seq, oldest first.
func (k *Kernel) Events(mission string, after int64, limit int) ([]Event, error) {
	if limit <= 0 || limit > 1000 {
		limit = 1000
	}
	var out []Event
	err := k.read(func() error {
		if _, err := getMission(k.db, mission); err != nil {
			return err
		}
		rows, err := k.db.Query(`SELECT e.seq, e.mission_id, e.package_id, COALESCE(p.key,''), e.attempt, e.kind, e.wake, e.message, e.at
			FROM events e LEFT JOIN packages p ON p.id=e.package_id WHERE e.mission_id=? AND e.seq>? ORDER BY e.seq LIMIT ?`, mission, after, limit)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var e Event
			var wake int
			if err := rows.Scan(&e.Seq, &e.Mission, &e.Package, &e.Key, &e.Attempt, &e.Kind, &wake, &e.Message, &e.At); err != nil {
				return err
			}
			e.Wake = wake == 1
			out = append(out, e)
		}
		return rows.Err()
	})
	return out, err
}

// CloseMission hides a finished mission from the default list.
func (k *Kernel) CloseMission(id string) (*Mission, error) {
	err := k.write(func(t *tx) error {
		m, err := getMission(t, id)
		if err != nil {
			return err
		}
		if active := m.Counts[StateLaunch] + m.Counts[StateRunning]; active > 0 {
			return errf("ACTIVE", "主任务还有 %d 个包在运行，先取消或等它们结束", active)
		}
		_, err = t.Exec(`UPDATE missions SET closed_at=? WHERE id=? AND closed_at IS NULL`, t.now, id)
		return err
	})
	if err != nil {
		return nil, err
	}
	return k.Mission(id)
}
