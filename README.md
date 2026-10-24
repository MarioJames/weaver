![Weaver 珊瑚版品牌标识](docs/assets/brand/weaver-lockup.png)

# Weaver

**让父 Agent，把任务编织给不同引擎的子 Agent。**

[品牌素材与使用规范](docs/assets/brand/README.md)

Weaver is a local Node control plane for owner-led agent work. It ships as one public skill (`skills/agents-weaver`, skill name `agents-weaver`), one `weaver` CLI, and one Weaver service — running in the background with `weaver server start`, or in the foreground as `weaver web` for development and debugging. The browser UI and the CLI call the same `CommandHandler`: the web serves loopback HTTP on `127.0.0.1`, the CLI connects through an authenticated Unix-socket transport, and both speak `weaver.v1`. There is no second daemon — the service is that one process — no MCP service, and no remote API: state is a single `weaver.db` SQLite store owned by the running service.

The owner is the real agent that hosts the skill. It registers logical ownership in Weaver through the CLI and dispatches workers from there. Registration is metadata only; explicitly requesting `owners switch` with `launch:true`, or `owners launch`, makes Weaver prepare the continuation prompt, start the new owner in Herdr and deliver that prompt (Claude Code and Codex hosts). These commands return the final launch result; a failed launch leaves the ownership switch in place. Saved routes launch real OpenCode, Pi, Grok, Codex, Qoder (`qodercli`), and DeepSeek Harness (`dsh`) launchers through fixed argument adapters. `mock-jsonl` runs only when explicitly requested. A failed or unloaded real engine fails the dispatch; real execution never falls back to mock. An explicit `tasks retry` can dispatch a continuation on another eligible worker, including a sibling on the same engine. Claude Code real workers also use the fixed CLI launcher. Engine scan checks `PATH` and `--version` only.

## Install

Download the standalone executable for your platform from GitHub Releases. It needs no Node, npm or source checkout:

```sh
curl -fsSL https://raw.githubusercontent.com/MarioJames/weaver/main/install.sh | bash
weaver --version
```

The script picks `weaver-linux-x64`, `weaver-linux-arm64` or `weaver-darwin-arm64`, checks it against the release `SHA256SUMS`, and places it at `~/.local/bin/weaver` (`--bin-dir` to change, `--version v0.1.0` to pin, `--uninstall` to remove only the executable). It refuses to replace an existing `weaver` that is not a Weaver release unless you pass `--force`; state in `~/.local/share/weaver` is never touched. The manual equivalent is a download plus the execute bit:

```sh
curl -fsSLo ~/.local/bin/weaver https://github.com/MarioJames/weaver/releases/latest/download/weaver-linux-x64
chmod +x ~/.local/bin/weaver
```

Each executable embeds the web UI and the mock worker (about 85 MB, the Bun runtime included). `weaver web --dev` needs a source checkout. Real worker launches still need the engine CLIs on `PATH` and, on Linux, `systemd-run --user`; macOS builds are compiled but not yet exercised against real engines.

Releases are built by `.github/workflows/release.yml` on a `v*` tag that matches `package.json`: `npm run dist` builds the renderer, then `scripts/build-standalone.mjs --all` compiles every target with Bun into `dist/release/` with `SHA256SUMS`. Locally, `node scripts/build-standalone.mjs` (after `npm run build`) builds only this machine's target, and `./install.sh --dist-dir dist/release` installs it.

## Build from source

Requires Node.js 22.13+ (`engines` in `package.json`). No system toolchain is installed.

```sh
npm ci
npm run build
npm start            # node dist/cli/main.mjs web
npm run check        # typecheck, tests, production build
npm run dev          # local dev web at http://127.0.0.1:4738
```

`npm run dev` is for developing Weaver itself: Vite serves the UI with HMR, `tsx watch` restarts the server on backend changes (a restart stops workers that process started), and state lives in the gitignored `.weaver-dev/` with port 4738, so it never touches a real instance on `~/.local/share/weaver` or port 4737. Point CLI commands at it with `--data-dir .weaver-dev`. Extra flags pass through, e.g. `npm run dev -- --port 0`. To run source against your real data directory, use `npx tsx src/cli/main.ts web --dev`.

Without a global install you can run the built CLI directly: `node dist/cli/main.mjs --help`. `package.json` exposes the `weaver` bin, but where `npm link` places it depends on your npm `globalPrefix`: check `npm prefix -g` first and never assume it is `~/.local`; only proceed when it is already a user-owned prefix (the install worker's verified setup used `globalPrefix=/home/mocha/.local`, then `npm link --offline --ignore-scripts` with no args; current npm rejects `npm link --global` with `ELINKGLOBAL`). After linking, verify `realpath ~/.local/bin/weaver` resolves into this repository's `dist/cli/main.mjs` and that `weaver --help` works. Do not overwrite an existing `weaver` bin or skill of the same name; keep both and stop. Installation and invocation acceptance records live in [VERIFICATION.md](VERIFICATION.md).

The public skill lives at `skills/agents-weaver` and every executable carries a copy. Install it for your agents with:

```sh
weaver skills install                     # ~/.agents/skills/agents-weaver, linked from ~/.claude/skills and ~/.codex/skills
weaver skills install --agent codex       # link only one agent
weaver skills install --link              # source checkout: link to skills/agents-weaver so edits apply at once
```

It refuses to replace a skill or link at those paths that it did not install (`--force` to override) and updates its own copy on rerun. The skill reads the saved policy through the CLI: the owner profile for the host engine, worker weights, `herdr.max_wait_minutes` as the longest interval between two checks on a worker, `herdr.max_command_minutes` as the longest a single command may run before health suspects it, blocks, and `chatgpt_review`, which turns on ChatGPT Pro review gates through [Convorel](https://github.com/MarioJames/convorel)'s `chatgpt-review` skill. It coexists with a global `agents-cooperation` skill, which stays untouched.

## Run the Weaver service

The Weaver service is the single process that holds the task and policy stores, supervises workers and answers both the CLI and the browser UI. One machine shares one service across every agent session; start it with:

```sh
weaver server start
```

It launches detached, writes its log to `<data-dir>/server.log`, and returns only once the service answers — when a service is already running it returns that one's info instead of starting a second. `--port` (default 4737) and `--data-dir` (default `$XDG_DATA_HOME/weaver` or `~/.local/share/weaver`) select the instance; when a login service is installed for the same port and data dir, `start` starts that one. A client that reports `APP_NOT_RUNNING` just needs this command.

```sh
weaver server status    # running: pid, url, port, data dir, version, running workers, managedBy
weaver server stop      # SIGTERM, then wait
```

`status` prints that block when the service runs and says it is stopped otherwise; either way it also reports whether a login service is installed. `stop` sends SIGTERM and waits: running workers are not cancelled, they keep running and reattach automatically after restart (the result names how many); `--cancel-workers` cancels running workers first and waits until none remain, failing without signalling when `--timeout` expires. Stopping is the user's call — an owner agent never stops the service as task cleanup, since other sessions share it.

To bring the service up at login, from the installed standalone binary:

```sh
weaver server install      # systemd user unit weaver.service (Linux) / launchd agent dev.weaver.server (macOS)
weaver server uninstall
```

`install` takes `--port` and `--data-dir`, captures the current `PATH` so workers keep finding the agent CLIs, and replaces an existing login service only with `--force`. A server that is running but not managed by that unit is left alone with a hint. An endpoint left behind by a crashed server (a discovery file whose socket no longer answers) is removed automatically at startup, so `weaver server start` recovers on its own.

`weaver web` stays the foreground mode, for development and debugging, and opens the browser:

```sh
weaver web              # same service, in this terminal; --no-open skips the browser
```

It is the same single writer and supervisor: it binds `127.0.0.1` only (default port 4737; `--port` selects another, `0` picks a free port), prints the URL after the stores and endpoints are ready, and keeps running after the browser closes. When a Weaver service is already running, `weaver web` returns that service's address instead of failing. `--dev` serves the UI with Vite on the same loopback origin. `--data-dir` overrides the state directory, which is also the discoverable endpoint root (`control.v1.json`). A busy port reports `EADDRINUSE` and names `--port`. Stop it with Ctrl+C or SIGTERM: the process drains, stops the workers it started, and exits. Task and policy data in `weaver.db` is kept, closing the browser tab does not stop tasks, and there is no second daemon behind any of this. Weaver does not read, migrate, or delete `~/.config/weaver-desktop`.

## Temporary directory cleanup

Weaver and its tests create short-lived directories under the OS temp root (`wv-*`, plus reserved `weaver-cli-*`, `weaver-policy-*` and `weaver-owner-*` scratch). The running service sweeps them at startup and then every 6 hours by default. A directory is removed only when all of these hold:

- its name starts with an allow-listed Weaver prefix (plain `weaver-` task scratch is never touched);
- it is a real directory owned by the service uid;
- its newest recursive mtime is at least 24 hours old (bounded traversal, symlinks are never followed);
- it is not a Weaver data directory and no live process has it as its cwd or an open file (checked through `/proc` on Linux; other platforms skip the process check but still require the TTL).

The defaults live in the policy as `"janitor": {"enabled": true, "ttl_hours": 24, "interval_hours": 6}`. Save a different section with `weaver policy save`, or set `"enabled": false` to turn scheduled cleanup off. Every sweep records each removed or skipped candidate and why in `weaver.db` (newest 50 sweeps); the same summary is written to `server.log`. Run a sweep immediately, or preview it without deleting anything:

```sh
weaver janitor sweep --dry-run
weaver janitor sweep
weaver janitor status
```

`janitor` commands talk to the running service, so the same live-process and active-data-directory checks apply.

## 定时任务

`schedules.*` 与网页共用 `weaver.v1` 命令和回执；多词与点号形式等价，支持 `--output json|jsonl|text`。写命令传稳定的 `--command-id`，重试同一次操作时复用它。下面创建每小时运行一次的脚本（省略 workspace 使用 CLI 调用方目录，也可显式指定）：

```sh
weaver schedules create --command-id hourly-check-create --input - <<'JSON'
{"name":"每小时检查","kind":"script","enabled":true,"timing":{"mode":"interval","seconds":3600},"script":{"command":"git status --short","timeoutSeconds":60}}
JSON
weaver schedules list --output json
```

Agent 任务使用已配置的父 Agent profile；从 `weaver policy get` 选择有效 `ownerProfileId`，把下面的 `your-owner-profile` 替换为该 ID，再执行：

```sh
weaver schedules create --command-id daily-agent-create --input - <<'JSON'
{"name":"每日项目检查","kind":"agent","enabled":true,"timing":{"mode":"cron","expression":"0 9 * * 1-5","timezone":"Asia/Shanghai"},"agent":{"goal":"检查项目状态并汇报风险，不推送代码","ownerProfileId":"your-owner-profile","acceptanceCriteria":["提供检查结果与实际验证证据"],"constraints":["保留现有未提交修改"]}}
JSON
```

`interval.seconds` 为 1–31536000；cron 只接受 5/6 段表达式及有效 IANA 时区，不接受日期字符串。仅在服务运行时触发，同一任务不重叠。重启时，没有活跃运行的已启用记录将错过的触发最多合并执行一次，不逐次补跑；旧活跃脚本须先核实所属进程已结束或将其回收，再记为 `interrupted` 并释放活跃标记，其忙期间错过的触发直接跳过。无法核实进程身份时，记录保持活跃并显示恢复错误，不启动重叠运行。`schedules run` 接受请求返回 `running`，不代表成功；Agent 每次创建独立 root，经 `tasks.start` 启动父 Agent 链路，等任务终态才结算。通过 `schedules get` / `schedules runs` 查状态和分页历史摘要，Agent 的 `taskId` 可继续用 `tasks get` 查看。先分页取得 run id，再查询单条完整输出，避免历史日志累计超过 IPC 的 1 MiB 单帧上限：

```sh
weaver schedules runs --schedule-id <UUID> --input '{"offset":0,"limit":20}' --output json
weaver schedules runs --schedule-id <UUID> --input '{"runId":"<run-UUID>"}' --output json
```

管理时用返回的 schedule `id` 和最新 `revision`；例如 `weaver schedules disable --schedule-id <UUID> --expected-revision <revision> --command-id <stable-id>` 只停用未来触发，正在运行的任务继续。手动 `schedules run` 可运行停用记录；`schedules cancel --schedule-id <UUID> --input '{"runId":"<active-run-UUID>"}' --command-id <stable-id>` 只取消指定本次运行。运行中只允许改 enabled，不能删除；内置额度刷新由 policy quota 配置管理，不能删除或改成任意脚本。

脚本是显式 shell 命令，以 Weaver 服务账户权限执行；自定义脚本的执行与安全恢复当前要求 Linux 和可用的 systemd 用户会话，其他平台会明确失败。只使用可信命令与工作区，输出会进入运行历史，避免打印凭据。脚本超时为 1–86400 秒，取消会终止本次进程组。

最多保存 100 条定时任务定义（包括内置任务），每条仅保留最近 100 次运行；单次 stdout 与 stderr 合并输出最多 64 KiB，超限会标记 `truncated`。分页摘要也可能带该标记，判断完整输出是否截断应读取单次详情。运行历史不是永久审计档案。完整输入、更新与分页例子见 [Agent 接口](docs/agent-interface.md#定时任务命令)。

## Skill entry and preflight

The skill instructs the owner to use Weaver CLI for capability inspection, routing, bounded packages, dispatch, and result verification; workers never delegate. Before any dispatch the owner checks existing state with the CLI:

```sh
weaver --help --output json    # complete command catalog and exact inputs
weaver capabilities           # process capabilities, limits, realExecution
weaver engines scan           # PATH + --version probe of the fixed engine catalog
weaver policy get             # saved owners, workers, weights, blocks, revision
weaver policy history         # every saved policy revision (number, time, source)
weaver workers probe-status   # free-channel probe schedule, ladder state and history
weaver quota get              # 只读 weaver.db 中最近一次 Codex / Claude Code / Grok / OpenCode Go 额度（OpenCode 不增删整引擎阻断），不联网
weaver engines health         # stall penalty summaries; no history
weaver engines penalty --engine <id>  # retained history for one engine
```

`capabilities.realExecution` means the real launcher module is loaded, not that a model ran or a login was proven. Engine scan proves an installed executable and version only; enabling an engine (`engines set-enabled`) still requires the probe and never creates a worker or owner role. Worker, model, and effort configuration is separate policy work, and real dispatch additionally requires an existing absolute workspace.

## One real task from the CLI

Configure an account/channel before selecting an owner or worker. The Accounts & Channels page imports existing official CLI logins into private authentication roots; direct creation is for API channels (provider, endpoint, protocol and private key/native config). Qoder API requires its native `/model` Custom setup and import, rather than the generic API form. Pi and dsh support API channels only; dsh currently uses the native deepseek-official Messages provider. Roles select `channel`, `model` and `effort`; the channel resolves the underlying engine. Enabling a CLI alone does not create a usable account.

New runs receive isolated native configuration and credentials from the selected channel. Weaver copies imported authentication into private storage without changing the source/global active account. Repeated imports preserve managed credentials by default; explicitly replacing an import creates a new private root for future starts while existing processes keep the old root. Keys/config are never returned by the ordinary channel read API. See [the current account/channel contract](docs/account-channels-design.md) for per-engine overrides, migration and verification limits. This machine has no installed Pi and Qoder BYOK is not enabled; examples are not a universal availability guarantee.

The first `owners attach` needs no credential: it is the existing locally authenticated control-plane registration and returns the logical owner plus `credentialPath`. From then on use the same instance and credential for every command: `weaver --data-dir <instance> --owner-file <credentialPath> ...`. The token exists only in that user-only (0600) file and is never printed. A Herdr-started root or continuation first reads `profileId` with `owners get` / `policy get`, then calls `owners attach` with `ownerId` to claim its existing row (name = the actual agent name, session = the current host session); it must not register a second owner.

```sh
# 1. Register this agent session as an owner, once per session. `session`
#    is `$CODEX_THREAD_ID`, else `$HERDR_PANE_ID`, else the workspace path;
#    `name` is `<Host> · <workspace dir> · <HH:MM>`. Keep the returned id and
#    credentialPath, and prefix every later command with
#    `weaver --data-dir <instance> --owner-file <credentialPath>`.
#    Once the main task is clear, set its board title (update on change):
#    weaver --data-dir <instance> --owner-file <credentialPath> owners describe --input '{"ownerId":"<id>","title":"..."}' --command-id <stable-id>
weaver owners attach --input owner.json --command-id owner-0731-4f2a

# 2. Create the task against that owner instance (ownerId, not the profile).
#    An omitted workspace becomes this CLI process's working directory;
#    an explicit relative path is resolved against the caller directory.
#    The server never substitutes its own repository path.
weaver tasks create --input task.json --command-id create-0731

# 3. Freeze the bounded work package (scope + acceptance criteria).
weaver packages create --task-id <taskId> --input package.json --command-id package-0731

# 4. Dispatch: Weaver picks the worker by balancing weights against the
#    global running + cancelling load. Omit `worker`; follow returned `next`.
weaver workers spawn --task-id <taskId> --input dispatch.json --command-id dispatch-0731

# 5. For a wait action, check first events within 1–2 minutes of spawn.
weaver tasks wait --task-id <taskId> --for 60
weaver tasks events --task-id <taskId>
# No worker output yet is suspect: inspect health before deciding it is stuck.
weaver tasks health --task-id <taskId>
# Then keep waiting at the default interval. Exiting wait/watch never cancels.
weaver tasks wait --task-id <taskId>
```

```json
owner.json
{
  "profileId": "codex_owner",
  "name": "Codex · your-repo · 14:20",
  "session": "/home/you/your-repo"
}

task.json
{
  "title": "Fix flaky CLI test",
  "instruction": "Reproduce the flake on main and fix the timing assumption.",
  "ownerId": "<id returned by owners attach>",
  "workspace": "/home/you/your-repo",
  "acceptanceCriteria": ["targeted test passes three consecutive runs"]
}

package.json
{
  "scope": ["tests/cli/cli-timeout.test.ts"],
  "acceptanceCriteria": ["test suite stable locally", "minimal diff"]
}

dispatch.json
{}
```

Every step after the first attach (create, describe, freeze, spawn, wait/watch, ack, review and complete) must reuse the same `--data-dir` and `--owner-file <credentialPath>`; `tasks wait` and `tasks watch` apply that identity to every internal `tasks get`/`events`/`health` poll. Use JSON files or safe stdin, never shell interpolation of a task goal, and never copy the token into a request, prompt or artifact.

`workers spawn` returns the frozen dispatch, `started`, and a `next` action: real execution or queued work gives a wait command; native execution gives `run_subagent` with model, effort, the full prompt and the completion command (`then`). The owner follows `next`.

Real workers count as started only after their first valid vendor output; spawn and retry wait within an 8 s total request budget and return `started:false` if output has not arrived yet. No valid vendor output within 120 s fails the attempt as `no_output`. Vendor rate-limit and quota errors fail fast; `task.failure` carries `kind`, `message`, and, when available, `stderrTail`, `vendorError` and `retryAt`. OpenCode uses `--print-logs --log-level ERROR` to surface limit errors promptly (commit `76933be` reports about 2 s; this is not a timing guarantee). Codex uses `--sandbox danger-full-access`, giving workers host access to Docker, ports and network, like the other engines’ bypass modes.

Native inheritance requires the selected worker and owner to use the same channel, the parent root to record that channel, and `root.run.policyRevision` to equal the current policy revision; otherwise Weaver uses the isolated CLI, even for the same engine. Existing runs keep their original route. For native work Weaver launches nothing: the task holds an owner slot while the owner uses its built-in subagent tool, then reports with `weaver workers complete` and a stable `--command-id`. Work queues when that owner instance reaches its profile's `max_parallel`; the chosen route stays frozen except when a vendor-limit block reroutes queued work. After waiting on queued work, read `tasks get` again: a now-running native task returns its `next` there too, so a lost spawn response is recoverable. `--input -` reads JSON from stdin; a full `{apiVersion:"weaver.v1",commandId,command,args}` envelope is accepted the same way.

If a mutation reply is lost, do not retry with a new ID: `weaver operations get --command-id <id>` reads the durable receipt for the same command ID. Unknown commands are rejected before any dispatch; a command executed but not acknowledged returns `COMMAND_INDETERMINATE` and requires inspecting state, not blind replay.

## Configure: weights

Policy is one validated document saved atomically with a revision check. It holds engines, account/API channels, owners (`channel`, `workers` list, `worker_weights`, `max_parallel`), workers (channel, model, effort, description, optional `max_parallel` capping how many tasks that worker runs at once across every owner; unset means no cap, and a full worker is skipped in routing or its task waits in the queue until a slot frees), and manual, quota, vendor-limit and stall `blocks`.

- Dispatch balances load by weight: Weaver picks the available worker with the lowest `(running + cancelling + 1) / weight`, counting tasks per worker across all owners. Idle work goes to the highest weight; concurrent work spreads in proportion to the weights (10 and 5 split about 2:1). Ties go to the higher weight, then the owner's `workers` order. Weights are integers 0..10, default 5. A saved policy with older 0..100 weights is converted once on load (rounded /10, minimum 1, 0 stays 0) and the previous file is kept as `policy.v1.json.pre-weight10-<timestamp>`; new input above 10 is rejected. Weight `0` excludes the worker, and an explicitly named worker cannot bypass weight 0.
- A disabled worker, channel or engine, or a matching engine/channel/model block skips that worker. Pause an engine from its card on the Engines page; exhausted subscription quota adds and removes its own channel block. Runtime vendor-limit blocks show a short reason, e.g. `限流：Rate limit exceeded…`. Repeated rate limits within 2 h use a 10 → 30 → 60 min release ladder, reset after 2 h quiet; a later vendor retry time wins. Quota errors without a retry time stay blocked until manual unblock. Queued tasks on a vendor-blocked worker or engine reroute to another eligible worker; a reroute still honors the retry chain's excluded workers. The failed attempt itself is not automatically retried.
- Concurrency is per owner **instance**: each instance has its profile's `max_parallel` slots. `owners attach` identifies a new instance by `profileId` + `name` + `session`, or claims an existing row when it carries `ownerId`; multiple sessions on one profile have independent capacity. The reported total is the sum of enabled profile limits, a scale hint rather than a global capacity cap. Lowering `max_parallel` leaves running tasks alone.
- `herdr.max_wait_minutes` (1-1440) is the longest interval between two checks on a worker: wait only with `weaver tasks wait --task-id` — it returns as soon as the task ends, and without `--for` one call waits `herdr.max_wait_minutes` × 60 s (30 s if policy is unreadable); an explicit `--for` accepts any whole number of seconds of at least 1, with no upper bound. Never sleep or set a longer timer instead. This setting does not impose an execution deadline; inspect `tasks health` before deciding whether to keep waiting, cancel, or retry.
- `herdr.max_command_minutes` (1-1440, default 30) is the longest a single command under a worker may stay in `running_command` before health reports `stalled` with reason `command_timeout` and names the command. `tasks wait` then returns early so the owner can cancel or retry. Weaver never stops the command itself.
- `display.timezone` is an optional IANA time zone name (for example `Asia/Shanghai`) used to render dates in the web UI. Leave it unset or empty to follow the browser. `policy save` rejects a name Intl does not support with a field error on `$.display.timezone`; `policy get` returns it.

```sh
weaver policy validate --input config.json   # config.json is the config document itself
weaver policy preview  --input preview.json  # preview.json is a {owner, worker?, runningCount} object
weaver policy save     --input save.json     # save.json is {revision, config, blocks}; validate and save take different shapes
weaver engines set-enabled --input toggle.json
```

Route preview is non-executing; dispatch separately applies current policy. Editing a weight or model later does not rewrite an already-queued route; blocked work stays queued with a bounded `queueReason` (capacity, policy, frozen route, workspace, launch), except that vendor-limit blocks reroute queued work to another eligible engine.

```json
{ "owner": "codex_owner", "worker": "codex_worker", "runningCount": 2 }
```

## 原生账户额度

`quota get`只读最近一次观测；`quota refresh`按渠道探测Codex、Claude Code、Grok与OpenCode Go的官方订阅额度，不执行推理。账号与渠道页可单独刷新，`channels.*.quota_refresh`控制定时刷新；API不显示官方订阅额度。Codex/Claude/Grok的新鲜明确耗尽仅暂停对应渠道，不影响同引擎其他账号；OpenCode Go窗口仅展示，不自动增删quota block。失败、未知或陈旧观测保留旧限制，人工限制仍独立。

```sh
weaver quota get --output json
weaver quota refresh --input '{"channel":"<channel-id>"}' --output json
weaver quota refresh --help --output json
```

刷新输入支持可选`channel`或`engine`过滤；省略时探测支持额度的已配置订阅渠道。只有按channel刷新执行对应自动策略合并，定时任务也逐channel调用。每个渠道独立缓存、冷却和持久化观测；这些非公开原生额度接口不保证长期稳定，也不证明模型可以运行。OpenCode优先读取所选私有DB的固定Console account/org，认证失败不回退另一个账号。

旧引擎页的OpenCode全局登录、切账号与额度池控制面已由渠道导入取代。导入在SQLite在线备份副本内枚举/选组织，原始全局游标不变；同refresh grant额外组织默认停用，跨组织并发续期未实证。完整入口、恢复方式与当前验证边界见[账号与渠道](docs/account-channels-design.md)。本轮只验证真实数据库只读备份副本升级schema13和认证隔离导入；共享0.7.9/schema12服务没有在此任务中升级。

## Result acceptance

Execution completion, delivery, acknowledgment, and acceptance are distinct states and never inferred from a green progress bar. Completion requires a valid final result and a zero-exit process; truncated or missing finals fail. The manual owner pulls and verifies independently:

```sh
weaver tasks results --task-id <taskId>        # manifest with artifact sha256 and manifestDigest
weaver artifacts read --task-id <taskId> --input read.json
# verify files/diffs/tests in your own tooling, outside Weaver
weaver results ack --task-id <taskId> --input ack.json --command-id ack-0731      # received, not accepted
weaver reviews submit --task-id <taskId> --input review.json --command-id review-0731
```

`results.ack` and `reviews.submit` must reference the current `manifestDigest` and expected task revision; stale digests are rejected. For manual owners `results.deliver` is unavailable by design: there is no push channel, the owner pulls. The owner reviews each child as soon as its result arrives, against that child's own criteria, and does not hold the submission for other children or the integrated check; integration problems go into a corrective child. A rejected review does not rerun silently: use the explicit retry command below.

```text
ack:    { "expectedRevision": <read the current revision from tasks results / tasks get>,
          "manifestDigest": "<digest from tasks results>" }
review: { "expectedRevision": <read the current revision again after ack; ack itself bumps it>,
          "manifestDigest": "<digest>", "decision": "accepted", "comment": "diff reproduced locally" }
```

A revision copied from the pre-ack step is already stale for the review and returns `REVISION_CONFLICT`; read it fresh before each submission.

## Root progress: owner push, overview pull

运行中的 owner root（`executionRole:'owner'` 且无 parent）由 root owner 主动推送进度；Master、Bot 状态菜单与用户读同一份全局概览。进度写入通道是 `tasks report`，聚合读取是 `tasks overview`；向运行中 owner 追加目标走正式 `tasks followup`（见 Skill 与 Master guideline），不要复用 `tasks describe`（只回填标题/验收标准，首个子任务后即锁定）冒充送达。版本能力先按实际 CLI 能力检测：旧 `0.7.4` 基线既无 `followup` 也无 `report`/`overview`；正式 `0.7.6` 与 `0.7.5` 提供正式 `followup`（`taskId` + `message` 1–8000 + 可选 `source` ≤40），`report`/`overview` 从正式 `0.7.6` 提供。`delivered:true` 只表示 Herdr 接受了追加消息，不表示 owner 已处理、不表示新报告已生成，绝不把 `delivered` 当新报告读。

```sh
weaver --data-dir <instance> --owner-file <credentialPath> tasks report --task-id <root> --input - --command-id report-0731-01 <<'JSON'
{"summary":"已复现并定位到竞态，补丁验证中","percent":42,"phase":"验证","blockers":["等待 code review"],"nextSteps":["合入补丁"]}
JSON
weaver --data-dir <instance> tasks overview --output json
weaver --data-dir <instance> tasks get --task-id <root> --view full --output json
weaver --data-dir <instance> tasks followup --help --output json
```

字段以同一实例的 `weaver --data-dir <instance> tasks report --help --output json`、`tasks overview --help --output json`、`tasks followup --help --output json` 与 `tasks get --help --output json` 为准：`summary` 必填 1–2000；`percent` 可选（有限数 0–100，省略则保留 root 进度，不从子任务推算）；`phase` 可选 1–120；`blockers`/`nextSteps` 可选数组，各 ≤10 项、每项 ≤500；`expectedRevision` 可选。每次成功上报更新最新报告与 revision 并追加一条 progress 事件；同一 `--command-id` 幂等（先查 `weaver operations get --command-id <id>`）。只有该任务的 owner 凭证能上报运行中的 owner root（`report` 额外带 `--owner-file`，`overview`/`get`/`followup help` 绑定同一 `--data-dir` 即可）；上报时机为 describe/split 之后、每次 dispatch/review 轮次、阻塞或失败时立即、complete 之前，内容简洁、可核查、不含凭据。`tasks overview` 返回全部运行中 owner root 的 `ownerReport`（`summary`/`percent|null`/`phase|null`/`blockers`/`nextSteps`/`reportedAt`）、`reportAgeSeconds|null`、`reportStale`、直接子任务状态计数与 `lastError`，不含子任务详情；`tasks get --view full` 返回同一个 `ownerReport`，未上报的旧任务为 `ownerReport:null`，`--view brief` 的键集合保持不变。

Staleness 只描述报告的新鲜度：`reportStale` 为真（`floor(上报年龄秒数) >= staleAfterSeconds`，默认 900 秒；未上报的 root 恒为 `reportAgeSeconds:null`、`reportStale:false`）表示该上报已过期、需要 owner 重新上报，不表示任务失败。stale 的正确反应是等 owner 的下一轮 `tasks report`，不是重试/取消/宣布失败；但用户明确追加目标走正式 `followup` 即时送达，不要说成“只能等下一轮上报”。Master 回答进度时先读同一实例的 `tasks overview`、先讲阻塞与新鲜度，只在用户明确追问某个任务时才查它的子任务。

Master 与 Bot 默认从 `tasks overview` 读运行中的 root 清单和进度：`tasks list` 还会返回 children，不能拿它当默认根任务库存，也不能把子任务拼成 root 进展。只有用户明确追问某个 root 的子任务、历史或排队情况时，才按既有 `--status`/`--view`/`--fields`/分页读 `tasks list`。旧 CLI 没有 `tasks overview` 时，明确说明该版本没有整体 root 报告；可以读单个 `tasks get`，但不要用 children 冒充根进展。Bot 状态文本逐 root 显示标题、上报进度/阶段（有才显示）、摘要、阻塞、新鲜度和直接子任务计数；未上报显示 root 进度与最近错误；没有运行中的根任务时只用一句中文说明没有运行中的根任务，不展示实现命令。文本只做逐字段截断，不做整体截断，正常的 12/20 个 root 必须全部出现。

Phase1 保持 push 优先：owner 在自己的执行上下文里决定上报什么、什么时候上报；任何拉取式追问（定时 ping 运行中的 owner、向忙终端注入消息）都会打断执行、跨越 Herdr 会话边界。进度上报通道之外没有轮询式进度拉取；已实现的正式送达是 `tasks followup`（服务只读核验运行中根任务的 Herdr 宿主 pane/workspace/tab/terminal/engine 后同步投递，`delivered:true` 仅表示 Herdr 已接受追加消息），绝不等同于直接 Herdr 注入，Agent 不得直接 Herdr 注入/终端写入。尚未实现的是带关联 ID、超时与回应状态的结构化 pull 进度请求，仍只是设计（DESIGN ONLY，未实现、不做原型、不添加 pull 产品）。用户明确追加目标按实际 CLI 能力检测走正式 `followup`；完整版本区分、送达语义与追加目标处理规范见 [root 进度文档](docs/root-task-progress.md)。

部署唯一完整流程见 [root 进度文档](docs/root-task-progress.md)（构建/备份/停服/安装/技能/验读/回滚顺序，同一实例绑定、fail-closed 备份恢复、worker 默认不取消、回滚不动数据库）。本任务以 `npm run build` 语义作为开发验收引用；**未生成或安装 standalone 发布产物、未部署、未停服/重启共享服务、未覆盖已安装的二进制或技能、未修改生产数据库**。备份路径不是凭据；文档与示例不出现任何 secret。

## Health and continuation retries

`weaver tasks health --task-id <id>` reports `starting` before a real worker’s first output, then `working`, `waiting_model`, `running_command` or `stalled` with silence time and CPU activity. CPU is the union of the worker scope and the worker CLI's whole process tree, so a command moved to another cgroup by `systemd-run --scope` still counts. A live command suppresses a stall; `stalled` requires no live command, silence and continuous CPU-idle for 5 minutes, or a command past `herdr.max_command_minutes` (`reason:'command_timeout'`). Missing CPU evidence never proves a stall. Finished tasks return `ended` with their final `taskStatus`. Check health before declaring a worker stuck. `tasks wait` returns early with reason `stalled`, health and a retry/cancel hint; `tasks watch` reports the transition and keeps watching.

Service restarts do not break `tasks get/wait/watch/events/health`: they reconnect within `--reconnect-grace` (default 60 s, `WEAVER_CLI_RECONNECT_GRACE_S`), reporting progress on stderr while stdout keeps one envelope. `tasks wait` may return `reason: 'handoff'` with a `run_subagent` instruction bound to `taskId`+`attemptId` — run that attempt with the built-in subagent tool only if it is not already started, never start a second one. New-lifecycle runs report `RESULT_NOT_READY` from `tasks results` until `run.finalizedAt` commits, and `wait` does not return terminal before that.

```sh
weaver tasks retry --task-id <id> --command-id retry-0731
# For an in-flight attempt, add --cancel to abandon it after preflight.
weaver tasks retry --task-id <id> --cancel --command-id retry-0732
```

Retry is one step: preflight, optional cancellation, a linked task and cloned frozen package with a continuation note, then dispatch and `next`. It keeps the owner binding, workspace, constraints, scope and acceptance criteria. Follow `next`; no second spawn is needed. Workers from failed/cancelled/cancelling attempts in that retry chain are excluded by worker ID; another worker on the same engine stays eligible, and completed workers remain eligible. A vendor limit excludes only that worker from the chain, so the retry can take that engine's sibling. With no eligible alternative, `NO_ALTERNATIVE_WORKER` is returned before cancelling or creating anything. Real retries never fall back to mock.

At least two workers on one engine silent and CPU-idle for 5 minutes trigger a stall penalty, pausing new dispatch to that engine without cancelling its workers. Penalties do not expire with time: level 1 probes after 5 minutes, level 2 after 10, and one successful recovery probe lifts either. Level 3 probes every 10 minutes and requires three consecutive successes or user intervention. Automatic recovery removes only its own stall block.

`weaver engines health` summarizes penalties without history; `weaver engines penalty --engine <id>` includes retained history. `weaver engines unblock --engine <id> --command-id <id>` is a manual full unblock: it clears all manual, quota, model and stall blocks on that exact engine and resets its penalty, retaining history. This is the user's call; owners use it only when the user has asked.

`weaver workers unblock --worker <id> --command-id <id>` unblocks one worker: it removes every block naming that worker (any source or model) and the affected channel-level "all workers rate-limited" vendor block when that channel is no longer fully blocked afterwards. Manual or other-source engine blocks, other workers' blocks and the vendor rate-limit ladder are kept; that worker's free-channel probe is reset, and its engine's stall ladder only when no stall block remains there. Queued tasks are then rerouted. Unknown workers return `NOT_FOUND` without writing anything. This is the user's call; owners use it only when the user has asked.

## Data and process boundary

Tasks and control-plane records are persisted in `weaver.db` with built-in `node:sqlite`, WAL journaling and FULL synchronous commits. Tasks, events, artifact bodies, owners, frozen packages and command receipts are stored separately; command intent is committed before process effects. Task/control-plane records and private channel-secret records live in that `weaver.db`; native authentication roots remain private files under the data directory: tasks and control-plane records, the policy (engines, channels, owners, ordered owner-worker links with weights, workers, settings such as `quota`, `herdr`, `free_channel_probe` and `display`, and blocks, one table each), a `policy_revisions` history that records every save with its number, time, source and full snapshot, the stall penalty ladder and history, the vendor rate-limit ladder, the free-channel probe state and history, and the last quota snapshot. The schema is built by ordered migrations tracked in `PRAGMA user_version`: an empty database climbs from 0, an up-to-date one is left alone. Policy/task startup reads `weaver.db`; first-time native channel import also reads the selected CLI source files without changing them. It never reads or writes a legacy policy `*.v1.json` (the JSON in the data directory is limited to the endpoint/token discovery file `control.v1.json`, the private owner credential files under `owner-credentials/`, and the private channel authentication/configuration roots under `channels/` and per-run prompts/configs/sessions under `agent-state/`). Read it all through the CLI (`tasks get`, `policy get`, `policy history`, `engines penalty`, `workers probe-status`, `quota get`); do not open the database or any file by hand. Rolling a policy back is `weaver policy rollback --input '{"revision":N}'`, which records a new revision. Data from an older JSON-based install is moved in once, by hand and outside the product, with a separate migration script that never touches the source files. Retained limits: 500 events per task, 20 artifacts per task, 32,000-character artifact content, 256 KiB policy document and 100 events per page. There is no retention UI yet.

The Unix CLI transport uses a random per-instance token in an owned private directory (`control-<instanceId>/`), 1 MiB frames, and a 15-second per-request timeout; token and discovery files are user-restricted and no token is ever placed in argv or output. An owner attach additionally writes that owner's credential to `<data-dir>/owner-credentials/<ownerId>.json` (mode 0600, regular file, no symlink); the response carries only `credentialPath`. `--owner-file` reads it through the same ownership/permission/symlink/size checks, attaches `ownerAuth` at the logical request top level and fails before sending if the file is missing, unsafe or malformed. Both are **local trusted-user authority**, not per-owner or tenant isolation: do not connect untrusted external agents. A stale endpoint left by a crashed server (a discovery file whose socket no longer answers) is removed automatically, so `weaver server start` recovers on its own. Weaver targets Linux/Unix. `weaver web` starts its Unix CLI transport before the loopback HTTP layer and refuses to start on native Windows (`UNSUPPORTED_PLATFORM`, `src/main/local-ipc.ts`); supervised real workers additionally rely on Linux systemd user scopes.

Repository honesty: real runs record the frozen route, requested engine/model/effort, adapter, workspace identity, and the launcher's scope unit and observed evidence; vendor-only fields stay unknown when unreported, and observability metrics are `null` with an explicit source note unless a provider emits evidence. Testing or build counts are not acceptance; current verification evidence lives in [VERIFICATION.md](VERIFICATION.md).

## Layout and provenance

- [architecture](docs/architecture.md): components, single-writer authority, scheduling, lifecycle, storage, local boundaries
- [agent-interface](docs/agent-interface.md): command catalog, envelope, outputs, and a full real lifecycle example
- [local engine operation guide](docs/local-integration-plan.md): discovery, enablement, roles, models, timeout, cancellation, and failure diagnosis for OpenCode/Pi/Grok/Codex
- [script-migration](docs/script-migration.md): the real Apache-2.0 upstream provenance and migration mapping
- [feishu-im](docs/feishu-im.md)：手机飞书单聊接入的企业自建应用逐步配置（权限/事件/回调/机器人菜单）、open_id 白名单、多实例限制与已验证边界
- Skill: [skills/agents-weaver/SKILL.md](skills/agents-weaver/SKILL.md) with references for [the CLI handoff](skills/agents-weaver/references/handoff.md), [policy](skills/agents-weaver/references/config.md) and [Convorel review](skills/agents-weaver/references/convorel.md)

Apache-2.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE).
