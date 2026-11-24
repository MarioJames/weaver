// Command weaver is the CLI and the service of the Weaver scheduling engine.
package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/MarioJames/weaver/internal/daemon"
	"github.com/MarioJames/weaver/internal/rpc"
	"github.com/MarioJames/weaver/skills"
)

const usage = `weaver：需求开发的调度引擎。主任务拆成工作包，派给各引擎的 Agent 执行。

主任务与计划
  weaver mission create --title <标题> [--workspace <目录>] [--pane <Herdr 窗格>] [--no-notify] [--key <幂等编号>] [--owner-engine <引擎>] [--owner-session <会话>]
  weaver mission list [--all] [--archived]
  weaver mission show <主任务>
  weaver mission close <主任务>
  weaver mission archive|unarchive <主任务>
  weaver mission owner --mission <主任务> [--engine claude|codex --session <会话ID>] [--find]
  weaver artifact add --mission <主任务> (--file <绝对路径> | --url <链接>) [--url <链接>] [--kind design|report|evidence|doc] [--title <标题>] [--package <key>]
  weaver artifact list --mission <主任务>
  weaver artifact remove <产物>
  weaver plan submit --mission <主任务> [--file <计划.json>] [--key <幂等编号>]     计划默认从标准输入读；每个包必填 intelligence（1–10，步长 0.5，指令留给执行者的判断空间越大分值越高），
                                        包交给够格的最低档候选；回执的 shape 是并行宽度，宽度不足或高分包过多时带 advice
                                        包可带 "advisory": true（只出文档、不改文件）和 "autoAccept": true（出结果即采纳并放行下游）

对谈                                          两方或三方候选各出方案、互相评审，只在最终立场给出时唤醒
  weaver dialogue start --mission <主任务> [--name <名称>] [--rounds 1-3] [--workers <候选,候选[,候选]>] [--brief-file <说明.md>] [--key <幂等编号>]
                                        说明默认从标准输入读；默认使用甲方、乙方（配置丙方后启用三席）；--rounds 缺省取 dialogue_rounds 设置
  weaver dialogue show --mission <主任务> [--name <名称>]     各方各轮的全文

进度与唤醒
  weaver wait --mission <主任务> [--cursor <序号>] [--timeout 30m]
  weaver events --mission <主任务> [--after <序号>] [--follow]
  weaver timer set --mission <主任务> (--in 10m | --at <RFC 3339 时间>) [--note <说明>] [--key <幂等编号>]
  weaver timer list --mission <主任务>
  weaver timer cancel <定时器>
  weaver wake --mission <主任务> [--note <说明>]

工作包                                        <包> 可以写 ID，也可以写 <主任务>/<key>
  weaver package list --mission <主任务>
  weaver package show <包>
  weaver package result <包>
  weaver package log <包> [--stderr]
  weaver verdict --package <包> accept|return [--note <说明>]
  weaver retry --package <包> [--note <说明>]
  weaver cancel (--package <包> | --mission <主任务>)

账号、候选与引擎
  weaver account quota [<账号>]  读取订阅账号的额度窗口（已用百分比、重置时间）与额度系数
  weaver account list | check [<账号>] | login <账号> | pause <账号> --for 30m [--reason <原因>] | resume <账号> | remove <账号>
  weaver account add --engine <引擎> --kind subscription|api [--id <ID>] [--label <名称>] [--auth-dir <目录>] [--api-key-env <环境变量名>] [--base-url <地址>] [--provider <名称>] [--protocol <协议>]
  weaver account set <账号> [--label <名称>] [--enabled true|false] [--api-key-env <环境变量名>] [--base-url <地址>]
  weaver account config <账号>                  读回渠道配置（不含密钥）
  weaver account models <账号>                  从渠道接口拉取模型清单
  weaver account usage <账号> [--balance <美元>] [--clear-balance] [--alert-below <美元>] [--clear-alert]
                         [--model <模型> (--price-input|--price-output|--price-cache-read|--price-cache-write <美元/百万令牌> | --clear-prices)]
                                            用量按每次运行回报的令牌和费用累计，单价按模型设置，一次替换该模型的四项；
                                            不带参数时显示本月用量和估算剩余
  weaver account import-legacy [--from <旧库路径>] [--owner claude_owner]
  weaver worker list | remove <候选>
  weaver worker set <候选> [--engine <引擎>] [--model <模型>] [--effort <强度>] [--intelligence <能力分>] [--max-parallel <数量>] [--enabled true|false] [--accounts <账号,账号>]
  weaver engine list | start <账号> | stop <账号>
  weaver config list | set <键> <值>          archive_after_days: 0（关闭）/1/3/7（默认）/30
                                             quota_refresh_minutes: 额度自动刷新间隔，1–1440 分钟（默认 5）

服务
  weaver status
  weaver daemon                         在前台运行服务
  weaver service install|uninstall      安装或移除 systemd 用户服务 weaver.service；install 会接管 0.x 留下的同名服务
  weaver backup
  weaver skill                          打印父 Agent 使用的技能说明（agents-weaver）
  weaver skill install                  把技能装到 ~/.agents/skills/agents-weaver，并链接到 ~/.claude/skills、~/.codex/skills
  weaver version

数据目录取自 WEAVER_HOME，默认 ~/.local/share/weaver/v2；0.x 的数据留在 ~/.local/share/weaver，不读不改。输出是 JSON。
`

func main() {
	if err := run(os.Args[1:]); err != nil {
		var rpcErr *rpc.Error
		if errors.As(err, &rpcErr) {
			body, _ := json.Marshal(map[string]any{"error": rpcErr})
			fmt.Fprintln(os.Stderr, string(body))
			os.Exit(1)
		}
		if errors.Is(err, rpc.ErrUnavailable) {
			fmt.Fprintf(os.Stderr, "weaver 服务没有运行（%s）。用 `weaver service install` 安装并启动，或用 `weaver daemon` 在前台运行。\n", rpc.SocketPath(rpc.Home()))
			os.Exit(3)
		}
		fmt.Fprintln(os.Stderr, "weaver: "+err.Error())
		os.Exit(2)
	}
}

// args holds parsed command-line arguments: --name value pairs, boolean
// switches and positionals, in any order.
type args struct {
	flags map[string]string
	pos   []string
}

var switches = map[string]bool{"all": true, "archived": true, "follow": true, "stderr": true, "no-notify": true, "help": true,
	"clear-balance": true, "clear-alert": true, "clear-prices": true}

func parse(argv []string) (*args, error) {
	a := &args{flags: map[string]string{}}
	for i := 0; i < len(argv); i++ {
		arg := argv[i]
		if !strings.HasPrefix(arg, "--") || arg == "--" {
			a.pos = append(a.pos, arg)
			continue
		}
		name, value, hasValue := strings.Cut(arg[2:], "=")
		if switches[name] {
			a.flags[name] = "true"
			continue
		}
		if !hasValue {
			if i+1 >= len(argv) {
				return nil, fmt.Errorf("--%s 需要一个值", name)
			}
			i++
			value = argv[i]
		}
		a.flags[name] = value
	}
	return a, nil
}

func (a *args) get(name string) string { return a.flags[name] }
func (a *args) has(name string) bool   { _, ok := a.flags[name]; return ok }

func (a *args) need(name string) (string, error) {
	if v := a.flags[name]; v != "" {
		return v, nil
	}
	return "", fmt.Errorf("缺少 --%s", name)
}

func (a *args) arg(i int, what string) (string, error) {
	if i < len(a.pos) {
		return a.pos[i], nil
	}
	return "", fmt.Errorf("缺少参数：%s", what)
}

// allow rejects flags a command does not understand, so a typo is not silently ignored.
func (a *args) allow(names ...string) error {
	for flag := range a.flags {
		known := false
		for _, n := range names {
			if n == flag {
				known = true
			}
		}
		if !known {
			return fmt.Errorf("未知选项 --%s", flag)
		}
	}
	return nil
}

func emit(result json.RawMessage) error {
	if info, err := os.Stdout.Stat(); err == nil && info.Mode()&os.ModeCharDevice != 0 {
		var v any
		if json.Unmarshal(result, &v) == nil {
			pretty, _ := json.MarshalIndent(v, "", "  ")
			result = pretty
		}
	}
	_, err := fmt.Println(string(result))
	return err
}

func call(method string, params any) error {
	result, err := rpc.Call(rpc.Home(), method, params)
	if err != nil {
		return err
	}
	return emit(result)
}

// callPatiently retries while the service is unreachable, so a wait survives a service restart.
func callPatiently(method string, params any, each func(json.RawMessage) (done bool, err error)) error {
	deadline := time.Now().Add(60 * time.Second)
	for {
		conn, err := rpc.Dial(rpc.Home(), method, params)
		if err == nil {
			for {
				var result json.RawMessage
				if result, err = conn.Next(); err != nil {
					break
				}
				deadline = time.Now().Add(60 * time.Second)
				done, eachErr := each(result)
				if eachErr != nil || done {
					conn.Close()
					return eachErr
				}
			}
			conn.Close()
		}
		var rpcErr *rpc.Error
		if errors.As(err, &rpcErr) && rpcErr.Code != "SHUTDOWN" {
			return err
		}
		if time.Now().After(deadline) {
			return err
		}
		time.Sleep(300 * time.Millisecond)
	}
}

// canonical maps the flag spellings of 0.x, which agents and instructions still
// use (weaver --version, weaver --skill), onto the commands.
func canonical(argv []string) []string {
	if len(argv) == 0 {
		return []string{"help"}
	}
	if name, ok := map[string]string{"--help": "help", "-h": "help", "--version": "version", "--skill": "skill"}[argv[0]]; ok {
		return append([]string{name}, argv[1:]...)
	}
	return argv
}

func run(argv []string) error {
	argv = canonical(argv)
	if argv[0] == "help" {
		fmt.Print(usage)
		return nil
	}
	group := argv[0]
	a, err := parse(argv[1:])
	if err != nil {
		return err
	}
	if a.has("help") {
		fmt.Print(usage)
		return nil
	}
	sub := ""
	grouped := map[string]bool{"artifact": true, "mission": true, "plan": true, "package": true, "timer": true, "dialogue": true, "account": true, "worker": true, "engine": true, "config": true, "service": true}
	if grouped[group] {
		if len(a.pos) == 0 {
			return fmt.Errorf("%s 需要子命令，见 weaver help", group)
		}
		sub, a.pos = a.pos[0], a.pos[1:]
	}
	switch group + " " + sub {
	case "version ":
		fmt.Println(daemon.Version)
		return nil
	case "skill ":
		if len(a.pos) == 0 {
			fmt.Print(skills.Weaver)
			return nil
		}
		if a.pos[0] != "install" {
			return fmt.Errorf("skill 只有 install 这一个子命令，见 weaver help")
		}
		home, err := os.UserHomeDir()
		if err != nil {
			return err
		}
		res, err := installSkill(home)
		if err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(res)
	case "daemon ":
		return daemon.Run(rpc.Home())
	case "service install":
		return serviceInstall()
	case "service uninstall":
		return serviceUninstall()
	case "status ":
		return call("status", nil)
	case "backup ":
		return call("backup", nil)

	case "mission create":
		if err := a.allow("title", "workspace", "pane", "herdr-session", "no-notify", "key", "owner-engine", "owner-session"); err != nil {
			return err
		}
		title, err := a.need("title")
		if err != nil {
			return err
		}
		workspace := a.get("workspace")
		if workspace == "" {
			workspace, _ = os.Getwd()
		}
		workspace, _ = filepath.Abs(workspace)
		params := map[string]any{"title": title, "workspace": workspace, "key": a.get("key")}
		params["owner"] = missionOwner(a)
		// A parent agent running inside Herdr gets wake-ups pushed into its own pane.
		pane := a.get("pane")
		if pane == "" && !a.has("no-notify") {
			pane = os.Getenv("HERDR_PANE_ID")
		}
		if pane != "" && !a.has("no-notify") {
			session := a.get("herdr-session")
			if session == "" {
				session = os.Getenv("HERDR_SESSION")
			}
			params["notify"] = map[string]string{"session": session, "pane": pane}
		}
		return call("mission.create", params)
	case "mission list":
		return call("mission.list", map[string]any{"all": a.has("all"), "archived": a.has("archived")})
	case "mission show":
		id, err := a.arg(0, "主任务")
		if err != nil {
			return err
		}
		return call("mission.show", map[string]any{"id": id})
	case "mission close":
		id, err := a.arg(0, "主任务")
		if err != nil {
			return err
		}
		return call("mission.close", map[string]any{"id": id})

	case "mission archive", "mission unarchive":
		if err := a.allow(); err != nil {
			return err
		}
		id, err := a.arg(0, "主任务")
		if err != nil {
			return err
		}
		return call("mission."+sub, map[string]any{"mission": id})
	case "mission owner":
		if err := a.allow("mission", "engine", "session", "find"); err != nil {
			return err
		}
		id, err := a.need("mission")
		if err != nil {
			return err
		}
		if a.has("find") && (a.has("engine") || a.has("session")) {
			return fmt.Errorf("--find 不能与 --engine 或 --session 同用")
		}
		owner := missionOwner(a)
		if a.has("find") {
			home := os.Getenv("HOME")
			owner, err = findMissionOwner(id, map[string]string{"claude": filepath.Join(home, ".claude", "projects"), "codex": filepath.Join(home, ".codex", "sessions")})
			if err != nil {
				return err
			}
		} else if a.has("engine") || a.has("session") {
			if !a.has("engine") || !a.has("session") {
				return fmt.Errorf("--engine 和 --session 需要一起指定")
			}
			owner = map[string]string{"engine": a.get("engine"), "session": a.get("session")}
		}
		return call("mission.owner", map[string]any{"mission": id, "engine": owner["engine"], "session": owner["session"]})
	case "artifact add":
		if err := a.allow("mission", "file", "url", "kind", "title", "package"); err != nil {
			return err
		}
		mission, err := a.need("mission")
		if err != nil {
			return err
		}
		return call("artifact.add", map[string]any{"mission": mission, "path": a.get("file"), "url": a.get("url"), "kind": a.get("kind"), "title": a.get("title"), "package": a.get("package")})
	case "artifact list":
		if err := a.allow("mission"); err != nil {
			return err
		}
		mission, err := a.need("mission")
		if err != nil {
			return err
		}
		return call("artifact.list", map[string]any{"mission": mission})
	case "artifact remove":
		if err := a.allow(); err != nil {
			return err
		}
		id, err := a.arg(0, "产物")
		if err != nil {
			return err
		}
		return call("artifact.remove", map[string]any{"id": id})

	case "plan submit":
		if err := a.allow("mission", "file", "key"); err != nil {
			return err
		}
		mission, err := a.need("mission")
		if err != nil {
			return err
		}
		var body []byte
		if file := a.get("file"); file != "" && file != "-" {
			body, err = os.ReadFile(file)
		} else {
			body, err = io.ReadAll(os.Stdin)
		}
		if err != nil {
			return err
		}
		var plan map[string]json.RawMessage
		if err := json.Unmarshal(body, &plan); err != nil {
			// A bare array of packages is accepted too.
			var packages []json.RawMessage
			if json.Unmarshal(body, &packages) != nil {
				return fmt.Errorf("计划不是合法的 JSON：%v", err)
			}
			encoded, _ := json.Marshal(packages)
			plan = map[string]json.RawMessage{"packages": encoded}
		}
		if _, ok := plan["packages"]; !ok {
			return errors.New(`计划需要 "packages" 数组`)
		}
		return call("plan.submit", map[string]any{"mission": mission, "key": a.get("key"), "packages": plan["packages"]})

	case "dialogue start":
		if err := a.allow("mission", "name", "rounds", "workers", "brief-file", "key"); err != nil {
			return err
		}
		mission, err := a.need("mission")
		if err != nil {
			return err
		}
		var body []byte
		if file := a.get("brief-file"); file != "" && file != "-" {
			body, err = os.ReadFile(file)
		} else {
			body, err = io.ReadAll(os.Stdin)
		}
		if err != nil {
			return err
		}
		params := map[string]any{"mission": mission, "name": a.get("name"), "brief": string(body), "key": a.get("key")}
		if v := a.get("rounds"); v != "" {
			n, err := strconv.Atoi(v)
			if err != nil {
				return fmt.Errorf("--rounds 需要整数")
			}
			params["rounds"] = n
		}
		if v := a.get("workers"); v != "" {
			params["workers"] = strings.Split(v, ",")
		}
		return call("dialogue.start", params)
	case "dialogue show":
		if err := a.allow("mission", "name"); err != nil {
			return err
		}
		mission, err := a.need("mission")
		if err != nil {
			return err
		}
		return call("dialogue.show", map[string]any{"mission": mission, "name": a.get("name")})

	case "package list":
		mission, err := a.need("mission")
		if err != nil {
			return err
		}
		return call("package.list", map[string]any{"mission": mission})
	case "package show":
		ref, err := a.arg(0, "包")
		if err != nil {
			return err
		}
		return call("package.show", map[string]any{"package": ref})
	case "package result", "package log":
		ref, err := a.arg(0, "包")
		if err != nil {
			return err
		}
		result, err := rpc.Call(rpc.Home(), "package.show", map[string]any{"package": ref})
		if err != nil {
			return err
		}
		var pkg struct {
			Key     string `json:"key"`
			State   string `json:"state"`
			Current *struct {
				N              int    `json:"n"`
				Result         string `json:"result"`
				RunDir         string `json:"runDir"`
				Mode           string `json:"mode"`
				FailureMessage string `json:"failureMessage"`
			} `json:"current"`
		}
		if err := json.Unmarshal(result, &pkg); err != nil {
			return err
		}
		if pkg.Current == nil {
			return fmt.Errorf("包 %s 还没有开始过（%s）", pkg.Key, pkg.State)
		}
		if sub == "result" {
			if pkg.Current.Result == "" {
				return fmt.Errorf("包 %s 的第 %d 次尝试还没有结果（%s）%s", pkg.Key, pkg.Current.N, pkg.State, pkg.Current.FailureMessage)
			}
			fmt.Println(pkg.Current.Result)
			return nil
		}
		if pkg.Current.Mode == "resident" {
			return errors.New("这次尝试跑在 opencode 常驻服务上，没有单独的进程输出；进度见 weaver events")
		}
		name := "stdout.jsonl"
		if a.has("stderr") {
			name = "stderr.log"
		}
		if pkg.Current.RunDir == "" {
			return errors.New("这次尝试的输出已按保留期清理")
		}
		f, err := os.Open(filepath.Join(pkg.Current.RunDir, name))
		if err != nil {
			return err
		}
		defer f.Close()
		_, err = io.Copy(os.Stdout, f)
		return err

	case "events ":
		if err := a.allow("mission", "after", "follow", "limit"); err != nil {
			return err
		}
		mission, err := a.need("mission")
		if err != nil {
			return err
		}
		after, _ := strconv.ParseInt(a.get("after"), 10, 64)
		limit, _ := strconv.Atoi(a.get("limit"))
		params := map[string]any{"mission": mission, "after": after, "limit": limit, "follow": a.has("follow")}
		if !a.has("follow") {
			return call("events", params)
		}
		// One JSON event per line, resuming after the last one seen if the service restarts.
		return callPatiently("events", params, func(result json.RawMessage) (bool, error) {
			var events []json.RawMessage
			if err := json.Unmarshal(result, &events); err != nil {
				return true, err
			}
			for _, e := range events {
				fmt.Println(string(e))
				var seq struct {
					Seq int64 `json:"seq"`
				}
				if json.Unmarshal(e, &seq) == nil {
					params["after"] = seq.Seq
				}
			}
			return false, nil
		})

	case "wait ":
		if err := a.allow("mission", "cursor", "timeout"); err != nil {
			return err
		}
		mission, err := a.need("mission")
		if err != nil {
			return err
		}
		params := map[string]any{"mission": mission}
		if a.has("cursor") {
			cursor, err := strconv.ParseInt(a.get("cursor"), 10, 64)
			if err != nil {
				return errors.New("--cursor 需要整数")
			}
			params["cursor"] = cursor
		}
		if a.has("timeout") {
			d, err := time.ParseDuration(a.get("timeout"))
			if err != nil || d <= 0 {
				return errors.New("--timeout 需要时长，例如 30m")
			}
			params["timeoutMs"] = d.Milliseconds()
		}
		return callPatiently("wait", params, func(result json.RawMessage) (bool, error) { return true, emit(result) })

	case "verdict ":
		if err := a.allow("package", "note"); err != nil {
			return err
		}
		pkg, err := a.need("package")
		if err != nil {
			return err
		}
		verdict, err := a.arg(0, "accept 或 return")
		if err != nil {
			return err
		}
		return call("verdict", map[string]any{"package": pkg, "verdict": verdict, "note": a.get("note")})
	case "retry ":
		pkg, err := a.need("package")
		if err != nil {
			return err
		}
		return call("retry", map[string]any{"package": pkg, "note": a.get("note")})
	case "cancel ":
		if err := a.allow("package", "mission"); err != nil {
			return err
		}
		return call("cancel", map[string]any{"package": a.get("package"), "mission": a.get("mission")})

	case "timer set":
		if err := a.allow("mission", "in", "at", "note", "key"); err != nil {
			return err
		}
		mission, err := a.need("mission")
		if err != nil {
			return err
		}
		params := map[string]any{"mission": mission, "note": a.get("note"), "key": a.get("key")}
		switch {
		case a.has("in"):
			d, err := time.ParseDuration(a.get("in"))
			if err != nil || d <= 0 {
				return errors.New("--in 需要时长，例如 10m")
			}
			params["dueAt"] = time.Now().Add(d).UnixMilli()
		case a.has("at"):
			at, err := time.Parse(time.RFC3339, a.get("at"))
			if err != nil {
				return errors.New("--at 需要 RFC 3339 时间，例如 2026-11-14T18:30:00+08:00")
			}
			params["dueAt"] = at.UnixMilli()
		default:
			return errors.New("需要 --in 或 --at")
		}
		return call("timer.set", params)
	case "timer list":
		mission, err := a.need("mission")
		if err != nil {
			return err
		}
		return call("timer.list", map[string]any{"mission": mission})
	case "timer cancel":
		id, err := a.arg(0, "定时器")
		if err != nil {
			return err
		}
		return call("timer.cancel", map[string]any{"id": id})
	case "wake ":
		mission, err := a.need("mission")
		if err != nil {
			return err
		}
		return call("wake", map[string]any{"mission": mission, "note": a.get("note"), "key": a.get("key")})

	case "account list":
		return call("account.list", nil)
	case "account quota":
		id := ""
		if len(a.pos) > 0 {
			id = a.pos[0]
		}
		return call("account.quota", map[string]any{"id": id})
	case "account check":
		id := ""
		if len(a.pos) > 0 {
			id = a.pos[0]
		}
		return call("account.check", map[string]any{"id": id})
	case "account add":
		if err := a.allow("engine", "kind", "id", "label", "auth-dir", "api-key-env", "base-url", "provider", "protocol", "config-file"); err != nil {
			return err
		}
		params := map[string]any{"engine": a.get("engine"), "kind": a.get("kind"), "id": a.get("id"), "label": a.get("label"), "authDir": a.get("auth-dir"),
			"baseUrl": a.get("base-url"), "provider": a.get("provider"), "protocol": a.get("protocol")}
		if err := secretParams(a, params); err != nil {
			return err
		}
		return call("account.add", params)
	case "account set":
		if err := a.allow("label", "enabled", "api-key-env", "base-url", "provider", "protocol", "config-file"); err != nil {
			return err
		}
		id, err := a.arg(0, "账号")
		if err != nil {
			return err
		}
		params := map[string]any{"id": id}
		for flag, field := range map[string]string{"label": "label", "base-url": "baseUrl", "provider": "provider", "protocol": "protocol"} {
			if a.has(flag) {
				params[field] = a.get(flag)
			}
		}
		if a.has("enabled") {
			params["enabled"] = a.get("enabled") == "true"
		}
		if err := secretParams(a, params); err != nil {
			return err
		}
		return call("account.set", params)
	case "account remove", "account resume":
		id, err := a.arg(0, "账号")
		if err != nil {
			return err
		}
		return call("account."+sub, map[string]any{"id": id})
	case "account pause":
		id, err := a.arg(0, "账号")
		if err != nil {
			return err
		}
		d, err := time.ParseDuration(a.get("for"))
		if err != nil || d <= 0 {
			return errors.New("需要 --for 时长，例如 30m")
		}
		return call("account.pause", map[string]any{"id": id, "forMs": d.Milliseconds(), "reason": a.get("reason")})
	case "account login":
		id, err := a.arg(0, "账号")
		if err != nil {
			return err
		}
		return login(id)
	case "account config":
		id, err := a.arg(0, "账号")
		if err != nil {
			return err
		}
		return call("account.config", map[string]any{"id": id})
	case "account models":
		id, err := a.arg(0, "账号")
		if err != nil {
			return err
		}
		return call("account.models", map[string]any{"id": id})
	case "account usage":
		if err := a.allow("balance", "clear-balance", "alert-below", "clear-alert", "model", "price-input", "price-output", "price-cache-read", "price-cache-write", "clear-prices"); err != nil {
			return err
		}
		id, err := a.arg(0, "账号")
		if err != nil {
			return err
		}
		params := map[string]any{"id": id}
		changed := false
		number := func(flag string) (float64, error) {
			v, err := strconv.ParseFloat(a.get(flag), 64)
			if err != nil || math.IsNaN(v) || math.IsInf(v, 0) || v < 0 {
				return 0, fmt.Errorf("--%s 需要不小于 0 的数字，例如 5.00", flag)
			}
			return v, nil
		}
		set := func(target map[string]any, flag, clear, key string) error {
			if a.has(flag) && a.has(clear) {
				return fmt.Errorf("--%s 和 --%s 不能同时使用", flag, clear)
			}
			if a.has(flag) {
				v, err := number(flag)
				if err != nil {
					return err
				}
				target[key] = v
				changed = true
			} else if clear != "clear-prices" && a.has(clear) {
				target[key] = nil
				changed = true
			}
			return nil
		}
		if err := set(params, "balance", "clear-balance", "balance"); err != nil {
			return err
		}
		if err := set(params, "alert-below", "clear-alert", "alertBelow"); err != nil {
			return err
		}
		// Prices belong to one model: the price flags replace all four of it.
		price := map[string]any{"model": a.get("model")}
		for flag, key := range map[string]string{"price-input": "input", "price-output": "output", "price-cache-read": "cacheRead", "price-cache-write": "cacheWrite"} {
			if err := set(price, flag, "clear-prices", key); err != nil {
				return err
			}
		}
		if len(price) > 1 || a.has("clear-prices") {
			if a.get("model") == "" {
				return errors.New("单价按模型设置，需要 --model <模型>")
			}
			params["prices"] = []any{price}
			changed = true
		} else if a.has("model") {
			return errors.New("--model 要和 --price-* 或 --clear-prices 一起用")
		}
		if !changed {
			return call("account.usage", params)
		}
		return call("account.usage.set", params)
	case "account import-legacy":
		from := a.get("from")
		if from == "" {
			home, _ := os.UserHomeDir()
			from = filepath.Join(home, ".local", "share", "weaver", "weaver.db")
		}
		owner := a.get("owner")
		if owner == "" {
			owner = "claude_owner"
		}
		return call("account.import", map[string]any{"path": from, "owner": owner})

	case "worker list":
		return call("worker.list", nil)
	case "worker remove":
		id, err := a.arg(0, "候选")
		if err != nil {
			return err
		}
		return call("worker.remove", map[string]any{"id": id})
	case "worker set":
		if err := a.allow("engine", "model", "effort", "intelligence", "max-parallel", "enabled", "accounts", "description"); err != nil {
			return err
		}
		id, err := a.arg(0, "候选")
		if err != nil {
			return err
		}
		params := map[string]any{"id": id, "engine": a.get("engine"), "model": a.get("model")}
		for _, flag := range []string{"effort", "description"} {
			if a.has(flag) {
				params[flag] = a.get(flag)
			}
		}
		for flag, field := range map[string]string{"max-parallel": "maxParallel"} {
			if a.has(flag) {
				n, err := strconv.Atoi(a.get(flag))
				if err != nil {
					return fmt.Errorf("--%s 需要整数", flag)
				}
				params[field] = n
			}
		}
		if a.has("intelligence") {
			n, err := strconv.ParseFloat(a.get("intelligence"), 64)
			if err != nil || (n != 0 && (n < 1 || n > 10 || math.Mod(n*2, 1) != 0)) {
				return errors.New("INVALID：能力分只能为 0（未评分）或 1–10，步长 0.5")
			}
			params["intelligence"] = n
		}
		if a.has("enabled") {
			params["enabled"] = a.get("enabled") == "true"
		}
		if a.has("accounts") {
			params["accounts"] = strings.Split(a.get("accounts"), ",")
		}
		return call("worker.set", params)

	case "engine list":
		return call("engine.list", nil)
	case "engine start", "engine stop":
		id, err := a.arg(0, "账号")
		if err != nil {
			return err
		}
		return call("engine."+sub, map[string]any{"account": id})

	case "config list":
		return call("config.list", nil)
	case "config set":
		key, err := a.arg(0, "键")
		if err != nil {
			return err
		}
		value, err := a.arg(1, "值")
		if err != nil {
			return err
		}
		return call("config.set", map[string]any{"key": key, "value": value})
	}
	return fmt.Errorf("未知命令 %s，见 weaver help", strings.TrimSpace(group+" "+sub))
}

// secretParams reads secrets from the environment or a file, never from the
// command line, where they would be visible to every process on the machine.
func secretParams(a *args, params map[string]any) error {
	if name := a.get("api-key-env"); name != "" {
		value := os.Getenv(name)
		if value == "" {
			return fmt.Errorf("环境变量 %s 是空的", name)
		}
		params["apiKey"] = value
	}
	if file := a.get("config-file"); file != "" {
		body, err := os.ReadFile(file)
		if err != nil {
			return err
		}
		params["config"] = string(body)
	}
	return nil
}

// login runs the engine's own sign-in command in this terminal, pointed at the
// account's credential directory, then re-checks the account.
func login(id string) error {
	result, err := rpc.Call(rpc.Home(), "account.login", map[string]any{"id": id})
	if err != nil {
		return err
	}
	var info struct {
		Argv []string          `json:"argv"`
		Env  map[string]string `json:"env"`
	}
	if err := json.Unmarshal(result, &info); err != nil {
		return err
	}
	if len(info.Argv) > 0 && info.Argv[0] == "agy" {
		if err := loginAgy(id, info.Argv, info.Env); err != nil {
			return err
		}
		return call("account.check", map[string]any{"id": id})
	}
	cmd := exec.Command(info.Argv[0], info.Argv[1:]...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	cmd.Env = mergeEnv(os.Environ(), info.Env)
	fmt.Fprintf(os.Stderr, "在账号 %s 的认证目录里运行：%s\n", id, strings.Join(info.Argv, " "))
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("登录命令没有成功：%v", err)
	}
	return call("account.check", map[string]any{"id": id})
}

func mergeEnv(base []string, overrides map[string]string) []string {
	out := make([]string, 0, len(base)+len(overrides))
	for _, kv := range base {
		name, _, _ := strings.Cut(kv, "=")
		if _, overridden := overrides[name]; overridden {
			continue
		}
		out = append(out, kv)
	}
	for key, value := range overrides {
		out = append(out, key+"="+value)
	}
	return out
}

var reGoogleOAuthURL = regexp.MustCompile(`https://accounts\.google\.com/o/oauth2/auth\S+`)

// loginAgy runs agy's isolated OAuth sign-in flow: backs up any existing token
// before re-login (restoring it on failure/cancellation), forwards the printed
// OAuth URL to $BROWSER when set (so Weaver GUI offers its link bar), forwards
// the pasted authorization code, and closes stdin so agy exits cleanly after
// saving the token without running a prompt turn.
func loginAgy(id string, argv []string, env map[string]string) error {
	tokPath := filepath.Join(env["HOME"], ".gemini", "antigravity-cli", "antigravity-oauth-token")
	bakPath := tokPath + ".login-bak"
	hadBackup := false
	if _, err := os.Stat(tokPath); err == nil {
		if err := os.Rename(tokPath, bakPath); err != nil {
			return fmt.Errorf("无法暂存旧凭据：%v", err)
		}
		hadBackup = true
	}
	restore := func() {
		if hadBackup {
			_ = os.Remove(tokPath)
			_ = os.Rename(bakPath, tokPath)
		}
	}

	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Env = mergeEnv(os.Environ(), env)
	stdinPipe, err := cmd.StdinPipe()
	if err != nil {
		restore()
		return err
	}
	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		restore()
		return err
	}
	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		restore()
		return err
	}
	fmt.Fprintf(os.Stderr, "在账号 %s 的认证目录里运行 Antigravity OAuth 登录…\n", id)
	if err := cmd.Start(); err != nil {
		restore()
		return fmt.Errorf("无法启动 agy 登录：%v", err)
	}

	var browserOnce sync.Once
	notifyURL := func(line string) {
		if u := reGoogleOAuthURL.FindString(line); u != "" {
			browserOnce.Do(func() {
				if browser := os.Getenv("BROWSER"); browser != "" {
					go func() { _ = exec.Command(browser, u).Run() }()
				}
			})
		}
	}

	var wg sync.WaitGroup
	stream := func(r io.Reader, dst io.Writer) {
		defer wg.Done()
		sc := bufio.NewScanner(r)
		sc.Buffer(make([]byte, 0, 16<<10), 256<<10)
		for sc.Scan() {
			line := sc.Text()
			notifyURL(line)
			// Skip agy's final stream-json error frame emitted on empty EOF.
			if strings.HasPrefix(strings.TrimSpace(line), `{"event":`) {
				continue
			}
			fmt.Fprintln(dst, line)
		}
	}
	wg.Add(2)
	go stream(stdoutPipe, os.Stdout)
	go stream(stderrPipe, os.Stderr)

	// Forward the pasted authorization code line from the user's terminal and
	// immediately close stdin so agy saves the token and exits without running
	// an agent turn.
	go func() {
		reader := bufio.NewReader(os.Stdin)
		for {
			line, readErr := reader.ReadString('\n')
			if strings.TrimSpace(line) != "" {
				_, _ = io.WriteString(stdinPipe, line)
				_ = stdinPipe.Close()
				return
			}
			if readErr != nil {
				_ = stdinPipe.Close()
				return
			}
		}
	}()

	wg.Wait()
	runErr := cmd.Wait()
	if info, statErr := os.Stat(tokPath); statErr == nil && info.Size() > 0 {
		if hadBackup {
			_ = os.Remove(bakPath)
		}
		return nil
	}
	restore()
	if runErr != nil {
		return fmt.Errorf("登录命令没有成功：%v", runErr)
	}
	return errors.New("未生成 Antigravity 登录凭据")
}

// skillInstall is what "weaver skill install" did.
type skillInstall struct {
	Installed string   `json:"installed"`
	Links     []string `json:"links"`
	Skipped   []string `json:"skipped,omitempty"`
}

// installSkill writes the embedded skill to ~/.agents/skills/agents-weaver and
// links it into the skill directories of the agents present on this machine.
// The directory is Weaver's own, so an older copy is replaced whole: the 0.x
// skill shipped reference files whose commands no longer exist. A skill of the
// same name that an agent directory holds as a real directory is left alone.
func installSkill(home string) (*skillInstall, error) {
	dir := filepath.Join(home, ".agents", "skills", "agents-weaver")
	if err := os.RemoveAll(dir); err != nil { // a symlink to a checkout is removed, not followed
		return nil, err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte(skills.Weaver), 0o644); err != nil {
		return nil, err
	}
	res := &skillInstall{Installed: dir, Links: []string{}}
	for _, agent := range []string{".claude", ".codex"} {
		parent := filepath.Join(home, agent, "skills")
		if _, err := os.Stat(parent); err != nil {
			continue
		}
		link := filepath.Join(parent, "agents-weaver")
		if info, err := os.Lstat(link); err == nil {
			if info.Mode()&os.ModeSymlink == 0 {
				res.Skipped = append(res.Skipped, link+"：已有同名技能且不是链接，没有改动")
				continue
			}
			if err := os.Remove(link); err != nil {
				return nil, err
			}
		}
		if err := os.Symlink(dir, link); err != nil {
			return nil, err
		}
		res.Links = append(res.Links, link)
	}
	return res, nil
}

const unitName = "weaver.service"

func unitPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", "systemd", "user", unitName)
}

func serviceInstall() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	if exe, err = filepath.EvalSymlinks(exe); err != nil {
		return err
	}
	// KillMode=process: stopping or restarting the service must leave running
	// agents and resident engines alone. They live in their own scopes.
	unit := fmt.Sprintf(`[Unit]
Description=Weaver scheduling engine

[Service]
ExecStart=%s daemon
Environment=WEAVER_HOME=%s
Environment=PATH=%s
Restart=always
RestartSec=1
KillMode=process

[Install]
WantedBy=default.target
`, exe, rpc.Home(), os.Getenv("PATH"))
	if err := os.MkdirAll(filepath.Dir(unitPath()), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(unitPath(), []byte(unit), 0o644); err != nil {
		return err
	}
	for _, argv := range [][]string{{"daemon-reload"}, {"enable", "--now", unitName}, {"restart", unitName}} {
		if out, err := exec.Command("systemctl", append([]string{"--user"}, argv...)...).CombinedOutput(); err != nil {
			return fmt.Errorf("systemctl --user %s: %v %s", strings.Join(argv, " "), err, out)
		}
	}
	fmt.Printf("已安装并启动 %s\n", unitPath())
	return nil
}

func serviceUninstall() error {
	_ = exec.Command("systemctl", "--user", "disable", "--now", unitName).Run()
	if err := os.Remove(unitPath()); err != nil && !os.IsNotExist(err) {
		return err
	}
	_ = exec.Command("systemctl", "--user", "daemon-reload").Run()
	fmt.Println("已移除 " + unitName + "。正在运行的 Agent 和常驻引擎不受影响；数据目录保留。")
	return nil
}

// missionOwner runs in the CLI, where the parent Agent's environment is available.
func missionOwner(a *args) map[string]string {
	engine, session := "", ""
	ancestor, found := ancestorAgent()
	if found {
		switch ancestor {
		case "claude":
			session = os.Getenv("CLAUDE_CODE_SESSION_ID")
		case "codex":
			session = os.Getenv("CODEX_THREAD_ID")
		}
		if session != "" {
			engine = ancestor
		}
	} else if session = os.Getenv("CLAUDE_CODE_SESSION_ID"); session != "" {
		engine = "claude"
	} else if session = os.Getenv("CODEX_THREAD_ID"); session != "" {
		engine = "codex"
	}
	if a.has("owner-engine") {
		engine = a.get("owner-engine")
	}
	if a.has("owner-session") {
		session = a.get("owner-session")
	}
	return map[string]string{"engine": engine, "session": session}
}
