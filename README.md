![Weaver 珊瑚版品牌标识](docs/assets/brand/weaver-lockup.png)

# Weaver

**让父 Agent，把任务编织给不同引擎的子 Agent。**

[品牌素材与使用规范](docs/assets/brand/README.md)

Weaver is a local Node control plane for owner-led agent work. It ships as one public skill (`skills/agents-weaver`, skill name `agents-weaver`), one `weaver` CLI, and one Weaver service — running in the background with `weaver server start`, or in the foreground as `weaver web` for development and debugging. The browser UI and the CLI call the same `CommandHandler`: the web serves loopback HTTP on `127.0.0.1`, the CLI connects through an authenticated Unix-socket transport, and both speak `weaver.v1`. There is no second daemon — the service is that one process — no MCP service, and no remote API: state is a single `weaver.db` SQLite store owned by the running service.

The owner is the real agent that hosts the skill. It registers logical ownership in Weaver through the CLI and dispatches workers from there. Registration is metadata only; explicitly requesting `owners switch` with `launch:true`, or `owners launch`, makes Weaver prepare the continuation prompt, start the new owner in Herdr and deliver that prompt (Claude Code and Codex hosts). These commands return the final launch result; a failed launch leaves the ownership switch in place. Saved routes launch real OpenCode, Pi, Grok, Codex, Zcode, and Qoder (`qodercli`) launchers through fixed argument adapters. `mock-jsonl` runs only when explicitly requested. A failed or unloaded real engine fails the dispatch; real execution never falls back to mock. An explicit `tasks retry` can dispatch a continuation on another eligible engine. Claude Code real execution is deferred. Engine scan checks `PATH` and `--version` only.

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

It refuses to replace a skill or link at those paths that it did not install (`--force` to override) and updates its own copy on rerun. The skill reads the saved policy through the CLI: the owner profile for the host engine, worker weights, `herdr.max_wait_minutes` as the longest interval between two checks on a worker, blocks, and `chatgpt_review`, which turns on ChatGPT Pro review gates through [Convorel](https://github.com/MarioJames/convorel)'s `chatgpt-review` skill. It coexists with a global `agents-cooperation` skill, which stays untouched.

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

`status` prints that block when the service runs and says it is stopped otherwise; either way it also reports whether a login service is installed. `stop` refuses with `SERVER_BUSY` while workers are running, because stopping cancels them; `--force` overrides. Stopping is the user's call — an owner agent never stops the service as task cleanup, since other sessions share it.

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

## Skill entry and preflight

The skill instructs the owner to use Weaver CLI for capability inspection, routing, bounded packages, dispatch, and result verification; workers never delegate. Before any dispatch the owner checks existing state with the CLI:

```sh
weaver --help --output json    # complete command catalog and exact inputs
weaver capabilities           # process capabilities, limits, realExecution
weaver engines scan           # PATH + --version probe of the fixed engine catalog
weaver policy get             # saved owners, workers, weights, blocks, revision
weaver policy history         # every saved policy revision (number, time, source)
weaver workers probe-status   # free-channel probe schedule, ladder state and history
weaver quota get              # 只读 weaver.db 中最近一次 Codex / Claude Code / Grok 额度，不联网
weaver engines health         # stall penalty summaries; no history
weaver engines penalty --engine <id>  # retained history for one engine
```

`capabilities.realExecution` means the real launcher module is loaded, not that a model ran or a login was proven. Engine scan proves an installed executable and version only; enabling an engine (`engines set-enabled`) still requires the probe and never creates a worker or owner role. Worker, model, and effort configuration is separate policy work, and real dispatch additionally requires an existing absolute workspace.

## One real task from the CLI

The values below are local examples from this machine's verified install, not a universal availability guarantee: OpenCode `opencode/glm-5.3-flash-free` effort `max`, Pi `cc-switch-agentplan/glm-5.3-flash` effort `high`, Grok `grok-4.7` effort `high`, Codex `gpt-6.1-sol` effort `xhigh`. Native provider authentication is reused from each engine's own configuration; Weaver never copies or prints credentials.

```sh
# 1. Register this agent session as an owner, once per session. `session`
#    is `$CODEX_THREAD_ID`, else `$HERDR_PANE_ID`, else the workspace path;
#    `name` is `<Host> · <workspace dir> · <HH:MM>`. Keep the returned id.
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

`workers spawn` returns the frozen dispatch, `started`, and a `next` action: real execution or queued work gives a wait command; native execution gives `run_subagent` with model, effort, the full prompt and the completion command (`then`). The owner follows `next`.

Real workers count as started only after their first valid vendor output; spawn and retry wait within an 8 s total request budget and return `started:false` if output has not arrived yet. No valid vendor output within 120 s fails the attempt as `no_output`. Vendor rate-limit and quota errors fail fast; `task.failure` carries `kind`, `message`, and, when available, `stderrTail`, `vendorError` and `retryAt`. OpenCode uses `--print-logs --log-level ERROR` to surface limit errors promptly (commit `76933be` reports about 2 s; this is not a timing guarantee). Codex uses `--sandbox danger-full-access`, giving workers host access to Docker, ports and network, like the other engines’ bypass modes.

For native work Weaver launches nothing: the task holds an owner slot while the owner uses its built-in subagent tool, then reports with `weaver workers complete` and a stable `--command-id`. Work queues when that owner instance reaches its profile's `max_parallel`; the chosen route stays frozen except when a vendor-limit block reroutes queued work. After waiting on queued work, read `tasks get` again: a now-running native task returns its `next` there too, so a lost spawn response is recoverable. `--input -` reads JSON from stdin; a full `{apiVersion:"weaver.v1",commandId,command,args}` envelope is accepted the same way.

If a mutation reply is lost, do not retry with a new ID: `weaver operations get --command-id <id>` reads the durable receipt for the same command ID. Unknown commands are rejected before any dispatch; a command executed but not acknowledged returns `COMMAND_INDETERMINATE` and requires inspecting state, not blind replay.

## Configure: weights

Policy is one validated document saved atomically with a revision check. It holds enabled engines, owners (`workers` list, `worker_weights`, `max_parallel`), workers (engine, model, effort, description), and manual, quota, vendor-limit and stall `blocks`.

- Dispatch balances load by weight: Weaver picks the available worker with the lowest `(running + cancelling + 1) / weight`, counting tasks per worker across all owners. Idle work goes to the highest weight; concurrent work spreads in proportion to the weights (10 and 5 split about 2:1). Ties go to the higher weight, then the owner's `workers` order. Weights are integers 0..10, default 5. A saved policy with older 0..100 weights is converted once on load (rounded /10, minimum 1, 0 stays 0) and the previous file is kept as `policy.v1.json.pre-weight10-<timestamp>`; new input above 10 is rejected. Weight `0` excludes the worker, and an explicitly named worker cannot bypass weight 0.
- A disabled worker, a disabled engine, or an active block on the engine/model skips that worker. Pause an engine from its card on the Engines page; exhausted quota adds and removes its own block. Runtime vendor-limit blocks show a short reason, e.g. `限流：Rate limit exceeded…`. Repeated rate limits within 2 h use a 10 → 30 → 60 min release ladder, reset after 2 h quiet; a later vendor retry time wins. Quota errors without a retry time stay blocked until manual unblock. Queued tasks on a vendor-blocked engine reroute to another eligible engine; the failed attempt itself is not automatically retried.
- Concurrency is per owner **instance**: each instance has its profile's `max_parallel` slots. `owners attach` identifies an instance by `profileId` + `name` + `session`; multiple sessions on one profile have independent capacity. The reported total is the sum of enabled profile limits, a scale hint rather than a global capacity cap. Lowering `max_parallel` leaves running tasks alone.
- `herdr.max_wait_minutes` (1-1440) is the longest interval between two checks on a worker: wait only with `weaver tasks wait --task-id` — it returns as soon as the task ends, and without `--for` one call waits min(600 s, `herdr.max_wait_minutes` × 60) at most (30 s if policy is unreadable). Never sleep or set a longer timer instead. This setting does not impose an execution deadline; inspect `tasks health` before deciding whether to keep waiting, cancel, or retry.
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

`quota get` 只读已入库的最近一次观测，不联网；`quota refresh` 手动探测 Codex、Claude Code 和 Grok，并同步 Weaver 自建的 `policy.blocks`。运行中的 `weaver web` 还会按设置页的间隔（policy `quota`，缺省每 15 分钟）自动刷新开启了「主动刷新额度」（`engines.*.quota_refresh`）的已启用引擎；额度耗尽时自动阻断该引擎，恢复或到重置时间后自动解除。最近一次额度观测存入 `weaver.db`，进程重启后 `quota get` 仍可读到（超过保鲜期显示为陈旧）；自动阻断保存在策略 blocks 中。额度状态不保证模型能够运行，引擎启用、角色、权重与 pin 仍独立配置。

```sh
weaver quota get --output json
weaver quota refresh --output jsonl
weaver quota get --output text
printf '{"engine":"claude"}\n' | weaver quota refresh --input - --output json
weaver quota refresh --help --output json
```

两条命令都支持 `json`、`jsonl`、`text`；刷新缺省探测全部三家，输入只接受可选的 `engine: codex|claude|grok`，不接受 command/task ID。可用 `weaver --help --output json` 读取完整目录与参数；`capabilities.quota` 提供发现入口。

成功观测在内存中保鲜 5 分钟，每家网络请求至少间隔 60 秒，并遵守接口的 `Retry-After`。没有后台轮询或强制绕过。只有新鲜、明确的账户耗尽会增加自有阻断，只有新鲜 `available` 会解除自有阻断；未知、失败或过期观测保留旧阻断。人工和其他来源的阻断保持原样；已过期的人工引擎阻断妨碍自动阻断时，刷新返回 `QUOTA_POLICY_CONFLICT`（HTTP 409），整次策略合并不落盘。

探测只读取已有原生登录凭据，通过固定 HTTPS GET 调用三家的非公开额度接口；不刷新或改写登录、不启动推理。接口来源、原生凭据路径、状态解释及完整输出示例见 [额度 CLI 契约](docs/agent-interface.md#31-原生账户额度)。Grok CLI 订阅额度与 xAI API 钱包、RPM/TPM 或 token 费用不同。

## Result acceptance

Execution completion, delivery, acknowledgment, and acceptance are distinct states and never inferred from a green progress bar. Completion requires a valid final result and a zero-exit process; truncated or missing finals fail. The manual owner pulls and verifies independently:

```sh
weaver tasks results --task-id <taskId>        # manifest with artifact sha256 and manifestDigest
weaver artifacts read --task-id <taskId> --input read.json
# verify files/diffs/tests in your own tooling, outside Weaver
weaver results ack --task-id <taskId> --input ack.json --command-id ack-0731      # received, not accepted
weaver reviews submit --task-id <taskId> --input review.json --command-id review-0731
```

`results.ack` and `reviews.submit` must reference the current `manifestDigest` and expected task revision; stale digests are rejected. For manual owners `results.deliver` is unavailable by design: there is no push channel, the owner pulls. A rejected review does not rerun silently: use the explicit retry command below.

```text
ack:    { "expectedRevision": <read the current revision from tasks results / tasks get>,
          "manifestDigest": "<digest from tasks results>" }
review: { "expectedRevision": <read the current revision again after ack; ack itself bumps it>,
          "manifestDigest": "<digest>", "decision": "accepted", "comment": "diff reproduced locally" }
```

A revision copied from the pre-ack step is already stale for the review and returns `REVISION_CONFLICT`; read it fresh before each submission.

## Health and continuation retries

`weaver tasks health --task-id <id>` reports `starting` before a real worker’s first output, then `working`, `waiting_model` or `stalled` with silence time and CPU activity from its own scope. Finished tasks return `ended` with their final `taskStatus`. A stall requires both silence and continuous CPU-idle for 5 minutes; missing CPU evidence never proves a stall. Check health before declaring a worker stuck. `tasks wait` returns early with reason `stalled`, health and a retry/cancel hint; `tasks watch` reports the transition and keeps watching.

```sh
weaver tasks retry --task-id <id> --command-id retry-0731
# For an in-flight attempt, add --cancel to abandon it after preflight.
weaver tasks retry --task-id <id> --cancel --command-id retry-0732
```

Retry is one step: preflight, optional cancellation, a linked task and cloned frozen package with a continuation note, then dispatch and `next`. It keeps the owner binding, workspace, constraints, scope and acceptance criteria. Follow `next`; no second spawn is needed. Engines from failed/cancelled/cancelling attempts in that retry chain are excluded; completed engines remain eligible. With no eligible alternative, `NO_ALTERNATIVE_ENGINE` is returned before cancelling or creating anything. Real retries never fall back to mock.

At least two workers on one engine silent and CPU-idle for 5 minutes trigger a stall penalty, pausing new dispatch to that engine without cancelling its workers. Penalties do not expire with time: level 1 probes after 5 minutes, level 2 after 10, and one successful recovery probe lifts either. Level 3 probes every 10 minutes and requires three consecutive successes or user intervention. Automatic recovery removes only its own stall block.

`weaver engines health` summarizes penalties without history; `weaver engines penalty --engine <id>` includes retained history. `weaver engines unblock --engine <id> --command-id <id>` is a manual full unblock: it clears all manual, quota, model and stall blocks on that exact engine and resets its penalty, retaining history. This is the user's call; owners use it only when the user has asked.

## Data and process boundary

Tasks and control-plane records are persisted in `weaver.db` with built-in `node:sqlite`, WAL journaling and FULL synchronous commits. Tasks, events, artifact bodies, owners, frozen packages and command receipts are stored separately; command intent is committed before process effects. Everything Weaver persists lives in that one `weaver.db`: tasks and control-plane records, the policy (engines, owners, ordered owner-worker links with weights, workers, settings such as `quota`, `herdr`, `free_channel_probe` and `display`, and blocks, one table each), a `policy_revisions` history that records every save with its number, time, source and full snapshot, the stall penalty ladder and history, the vendor rate-limit ladder, the free-channel probe state and history, and the last quota snapshot. The schema is built by ordered migrations tracked in `PRAGMA user_version`: an empty database climbs from 0, an up-to-date one is left alone. Startup reads only `weaver.db`; it never reads or writes a `*.v1.json` (the only JSON in the data directory is the endpoint/token discovery file `control.v1.json`, plus the private per-run prompts and sessions under `agent-state/`). Read it all through the CLI (`tasks get`, `policy get`, `policy history`, `engines penalty`, `workers probe-status`, `quota get`); do not open the database or any file by hand. Rolling a policy back is `weaver policy rollback --input '{"revision":N}'`, which records a new revision. Data from an older JSON-based install is moved in once, by hand and outside the product, with a separate migration script that never touches the source files. Retained limits: 500 events per task, 20 artifacts per task, 32,000-character artifact content, 256 KiB policy document and 100 events per page. There is no retention UI yet.

The Unix CLI transport uses a random per-instance token in an owned private directory (`control-<instanceId>/`), 1 MiB frames, and a 15-second per-request timeout; token and discovery files are user-restricted and no token is ever placed in argv or output. The credential is **local trusted-user authority**, not per-owner isolation: do not connect untrusted external agents. A stale endpoint left by a crashed server (a discovery file whose socket no longer answers) is removed automatically, so `weaver server start` recovers on its own. Weaver targets Linux/Unix. `weaver web` starts its Unix CLI transport before the loopback HTTP layer and refuses to start on native Windows (`UNSUPPORTED_PLATFORM`, `src/main/local-ipc.ts`); supervised real workers additionally rely on Linux systemd user scopes.

Repository honesty: real runs record the frozen route, requested engine/model/effort, adapter, workspace identity, and the launcher's scope unit and observed evidence; vendor-only fields stay unknown when unreported, and observability metrics are `null` with an explicit source note unless a provider emits evidence. Testing or build counts are not acceptance; current verification evidence lives in [VERIFICATION.md](VERIFICATION.md).

## Layout and provenance

- [architecture](docs/architecture.md): components, single-writer authority, scheduling, lifecycle, storage, local boundaries
- [agent-interface](docs/agent-interface.md): command catalog, envelope, outputs, and a full real lifecycle example
- [local engine operation guide](docs/local-integration-plan.md): discovery, enablement, roles, models, timeout, cancellation, and failure diagnosis for OpenCode/Pi/Grok/Codex
- [script-migration](docs/script-migration.md): the real Apache-2.0 upstream provenance and migration mapping
- Skill: [skills/agents-weaver/SKILL.md](skills/agents-weaver/SKILL.md) with references for [the CLI handoff](skills/agents-weaver/references/handoff.md), [policy](skills/agents-weaver/references/config.md) and [Convorel review](skills/agents-weaver/references/convorel.md)

Apache-2.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE).
