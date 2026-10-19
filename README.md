# Weaver

Weaver is a local Node control plane for owner-led agent work. It ships as one public skill (`skills/weaver`, skill name `weaver`), one `weaver` CLI, and one foreground web process. The browser UI and the CLI call the same `CommandHandler`: the web serves loopback HTTP on `127.0.0.1`, the CLI connects through an authenticated Unix-socket transport, and both speak `weaver.v1`. There is no second daemon, no separate owner-model process, no MCP service, no remote API, and no database: state is a versioned JSON store owned by the running process.

The owner is the real agent that hosts the skill. It registers logical ownership in Weaver through the CLI and dispatches workers from there; Weaver never spawns an owner model itself. Saved routes launch real OpenCode, Pi, Grok, and Codex launchers through fixed argument adapters. `mock-jsonl` runs only when explicitly requested. A failed or unloaded real engine fails the dispatch; it never falls back to mock, Claude Code, or another engine. Claude Code real execution is deferred. Engine scan checks `PATH` and `--version` only.

## Install and build

Requires Node.js 22.12+ (`engines` in `package.json`). No system toolchain is installed.

```sh
npm ci
npm run build
npm start            # node dist/cli/main.mjs web
npm run check        # typecheck, tests, production build
npm run dev:web      # local dev web at http://127.0.0.1:4738
```

`npm run dev:web` is for developing Weaver itself: Vite serves the UI with HMR, `tsx watch` restarts the server on backend changes (a restart stops workers that process started), and state lives in the gitignored `.weaver-dev/` with port 4738, so it never touches a real instance on `~/.local/share/weaver` or port 4737. Point CLI commands at it with `--data-dir .weaver-dev`. Extra flags pass through, e.g. `npm run dev:web -- --port 0`.

Without a global install you can run the built CLI directly: `node dist/cli/main.mjs --help`. `package.json` exposes the `weaver` bin, but where `npm link` places it depends on your npm `globalPrefix`: check `npm prefix -g` first and never assume it is `~/.local`; only proceed when it is already a user-owned prefix (the install worker's verified setup used `globalPrefix=/home/mocha/.local`, then `npm link --offline --ignore-scripts` with no args; current npm rejects `npm link --global` with `ELINKGLOBAL`). After linking, verify `realpath ~/.local/bin/weaver` resolves into this repository's `dist/cli/main.mjs` and that `weaver --help` works. Do not overwrite an existing `weaver` bin or skill of the same name; keep both and stop. Installation and invocation acceptance records live in [VERIFICATION.md](VERIFICATION.md).

The public skill lives at `skills/weaver` in this repository. A user-level skill entry links or copies that directory to `~/.agents/skills/weaver`; it coexists with any preinstalled global `agents-cooperation` skill, which stays untouched. Never point the skill at the old Herdr scheduler.

## Run one local control plane

```sh
weaver web --no-open
```

`weaver web` is a foreground process and the only writer and supervisor. It binds `127.0.0.1` only (default port 4737; `--port` selects another, `0` picks a free port), prints the URL after the stores and endpoints are ready, and keeps running after the browser closes. `--dev` serves the UI with Vite on the same loopback origin. `--data-dir` overrides the state directory; the default is `$XDG_DATA_HOME/weaver` or `~/.local/share/weaver`, which is also the discoverable endpoint root (`control.v1.json`). A busy port reports `EADDRINUSE` and names `--port`. Weaver does not read, migrate, or delete `~/.config/weaver-desktop`.

Stop with Ctrl+C or SIGTERM: the process drains, stops the workers it started, and exits. Task and policy files are kept. Closing the browser tab does not stop tasks, and there is no second background daemon; if a client reports `APP_NOT_RUNNING`, start `weaver web --no-open` first.

## Skill entry and preflight

The skill instructs the owner to use Weaver CLI for capability inspection, routing, bounded packages, dispatch, and result verification; workers never delegate. Before any dispatch the owner checks existing state with the CLI:

```sh
weaver capabilities           # command catalog, limits, realExecution
weaver engines scan           # PATH + --version probe of the fixed engine catalog
weaver policy get             # saved owners, workers, weights, pins, blocks, revision
```

`capabilities.realExecution` means the real launcher module is loaded, not that a model ran or a login was proven. Engine scan proves an installed executable and version only; enabling an engine (`engines set-enabled`) still requires the probe and never creates a worker or owner role. Worker, model, and effort configuration is separate policy work, and real dispatch additionally requires an existing absolute workspace.

## One real task from the CLI

The values below are local examples from this machine's verified install, not a universal availability guarantee: OpenCode `opencode/glm-5.3-flash-free` effort `max`, Pi `cc-switch-agentplan/glm-5.3-flash` effort `high`, Grok `grok-4.7` effort `high`, Codex `gpt-6.1-sol` effort `xhigh`. Native provider authentication is reused from each engine's own configuration; Weaver never copies or prints credentials.

```sh
# 1. Register a logical owner and task together (one row in owners + tasks).
#    An omitted workspace becomes this CLI process's working directory;
#    an explicit relative path is resolved against the caller directory.
#    The server never substitutes its own repository path.
weaver tasks create --input task.json --command-id create-0731

# 2. Freeze the bounded work package (scope + acceptance criteria).
weaver packages create --task-id <taskId> --input package.json --command-id package-0731

# 3. Dispatch on the current saved route: the judgment class resolves
#    worker/engine/model/effort by eligibility, weights and tier order.
#    Without an explicit `only_engine` pin saved in policy this may not land
#    on Codex (Pi/Grok are eligible too); a Codex pin must be configured
#    explicitly in policy, not assumed here. An explicit `worker` is accepted.
weaver workers spawn --task-id <taskId> --input dispatch.json --command-id dispatch-0731

# 4. Bounded wait (1-600 seconds, default 30). Exiting wait or watch never cancels the task.
weaver tasks wait --task-id <taskId> --for 120
```

```json
task.json
{
  "title": "Fix flaky CLI test",
  "instruction": "Reproduce the flake on main and fix the timing assumption.",
  "ownerProfileId": "codex_owner",
  "workspace": "/home/you/your-repo",
  "acceptanceCriteria": ["targeted test passes three consecutive runs"]
}

package.json
{
  "scope": ["tests/cli-timeout.test.ts"],
  "acceptanceCriteria": ["test suite stable locally", "minimal diff"]
}

dispatch.json
{ "class": "judgment" }
```

`workers spawn` returns the frozen dispatch (owner, worker, engine, model, effort, execution, max_parallel bounds, max wait, workspace) and either starts the worker or queues it when the owner is at its `max_parallel`. Queued work freezes the chosen route: it is never silently reselected or moved to another engine. `--input -` reads JSON from stdin; a full `{apiVersion:"weaver.v1",commandId,command,args}` envelope is accepted the same way.

If a mutation reply is lost, do not retry with a new ID: `weaver operations get --command-id <id>` reads the durable receipt for the same command ID. Unknown commands are rejected before any dispatch; a command executed but not acknowledged returns `COMMAND_INDETERMINATE` and requires inspecting state, not blind replay.

## Configure: order, weights, pin

Policy is one validated document saved atomically with a revision check. It holds enabled engines, owners (ordered `workers` list, `worker_weights`, optional `only_engine`, `max_parallel`), workers (engine, model, effort, tags), and quota `blocks`.

- Weights are integers 0..1000, default 100; they are priority, not probability. Larger first within a tier; ties follow the owner's `workers` order. Weight `0` excludes the worker, and an explicitly named worker cannot bypass weight 0 or the pin.
- Class/tag eligibility is resolved first (mechanical/routine/judgment tiers, then tags), weights only reorder inside a tier.
- `only_engine` is a hard pin: every dispatch for that owner (automatic, explicit worker, or queued pump) is constrained to that engine. There is no fallback across engines. A pin whose selection set is empty or unavailable can be saved but every dispatch fails until it is fixed.
- Concurrency is per owner: `max_parallel`. The reported total is the sum of enabled owners, not a separate global limit. Lowering `max_parallel` leaves running tasks alone.
- Timeout is `herdr.max_wait_minutes` (1-1440); there is no 60-second default.

```sh
weaver policy validate --input config.json   # config.json is the config document itself
weaver policy preview  --input preview.json  # preview.json is a {owner, worker/class, runningCount} object
weaver policy save     --input save.json     # save.json is {revision, config, blocks}; validate and save take different shapes
weaver engines set-enabled --input toggle.json
```

Route preview is non-executing; dispatch separately applies current policy. Editing a weight or model later does not rewrite an already-queued route; blocked work stays queued with a bounded `queueReason` (capacity, policy, frozen route, workspace, launch).

```json
{ "owner": "codex_owner", "worker": "codex_worker", "runningCount": 2 }
```

## Result acceptance

Execution completion, delivery, acknowledgment, and acceptance are distinct states and never inferred from a green progress bar. Completion requires a valid final result and a zero-exit process; truncated or missing finals fail. The manual owner pulls and verifies independently:

```sh
weaver tasks results --task-id <taskId>        # manifest with artifact sha256 and manifestDigest
weaver artifacts read --task-id <taskId> --input read.json
# verify files/diffs/tests in your own tooling, outside Weaver
weaver results ack --task-id <taskId> --input ack.json --command-id ack-0731      # received, not accepted
weaver reviews submit --task-id <taskId> --input review.json --command-id review-0731
```

`results.ack` and `reviews.submit` must reference the current `manifestDigest` and expected task revision; stale digests are rejected. For manual owners `results.deliver` is unavailable by design: there is no push channel, the owner pulls. A rejected review does not rerun silently: `tasks retry` creates a new task linked to the previous one via `retryOf`, reusing owner binding.

```text
ack:    { "expectedRevision": <read the current revision from tasks results / tasks get>,
          "manifestDigest": "<digest from tasks results>" }
review: { "expectedRevision": <read the current revision again after ack; ack itself bumps it>,
          "manifestDigest": "<digest>", "decision": "accepted", "comment": "diff reproduced locally" }
```

A revision copied from the pre-ack step is already stale for the review and returns `REVISION_CONFLICT`; read it fresh before each submission.

## Data and process boundary

State is one versioned JSON store (`tasks.v1.json`) plus one policy store (`policy.v1.json`) written by the single running process with fsync + rename atomic replacement (intentionally no directory fsync). Caps: 200 tasks, 200 retained owners, 1,000 packages, 5,000 command receipts, 500 events per task, 20 artifacts per task, 32,000-character artifact content, 256 KiB policy document, 32 MiB store, 100 events per page. There is no retention UI yet.

The Unix CLI transport uses a random per-instance token in an owned private directory (`control-<instanceId>/`), 1 MiB frames, and a 15-second per-request timeout; token and discovery files are user-restricted and no token is ever placed in argv or output. The credential is **local trusted-user authority**, not per-owner isolation: do not connect untrusted external agents. A stale discovery file must not exist while another instance runs; verify no running instance before removing it manually. The local control plane targets Linux/Unix. `weaver web` starts its Unix CLI transport before the loopback HTTP layer and refuses to start on native Windows (`UNSUPPORTED_PLATFORM`, `src/main/local-ipc.ts`); supervised real workers additionally rely on Linux systemd user scopes.

Repository honesty: real runs record the frozen route, requested engine/model/effort, adapter, workspace identity, and the launcher's scope unit and observed evidence; vendor-only fields stay unknown when unreported, and observability metrics are `null` with an explicit source note unless a provider emits evidence. Testing or build counts are not acceptance; current verification evidence lives in [VERIFICATION.md](VERIFICATION.md).

## Layout and provenance

- [architecture](docs/architecture.md): components, single-writer authority, scheduling, lifecycle, storage, local boundaries
- [agent-interface](docs/agent-interface.md): command catalog, envelope, outputs, and a full real lifecycle example
- [local engine operation guide](docs/local-integration-plan.md): discovery, enablement, roles, models, timeout, cancellation, and failure diagnosis for OpenCode/Pi/Grok/Codex
- [script-migration](docs/script-migration.md): the real Apache-2.0 upstream provenance and migration mapping
- Skill: [skills/weaver/SKILL.md](skills/weaver/SKILL.md) with [references](skills/weaver/references/handoff.md)

Apache-2.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE).
