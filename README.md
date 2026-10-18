# Weaver

An Electron + TypeScript + React control plane for owner-led work. The unified interface is implemented and exercised with deterministic mock owners/workers. **No real agent, provider API, or project edit is performed.** Vendor-specific owner/worker adapters remain disabled.

## Run and verify

Requires Node.js 22.12+ and a supported Electron desktop.

```sh
npm ci
npm run dev
npm run check
```

`dev` builds then launches Electron; `start` uses an existing build. Do not disable Chromium's sandbox to bypass a restricted environment. Installers and signing are not included.

## Implemented flow

1. Enter task goal, workspace, owner profile and acceptance criteria. One command creates a logical mock owner and task atomically; no session/pane input is needed.
2. Dispatch a mock worker. Weaver freezes a package, applies configured routing/availability/quota rules and actual concurrency limits, then runs or queues the bundled subprocess. A selected provider/model is policy metadata; actual execution is always mock.
3. Inspect synchronized task status, bounded events, artifacts, correlation IDs and best-effort-redacted logs. Tokens/cost/context usage are unknown when not reported.
4. Completion requires a valid final result and successful process exit. Result delivery, acknowledgment and acceptance/rejection are distinct states. Reviews bind a result digest and current task revision.
5. Cancel queued/running work; running cancellation waits for exit. Retry creates a new task linked to immutable prior history.
6. Switch a mock owner manually, or configure idle continuation (default 60 minutes, null disables). Expiry is checked on the next valid worker dispatch, not by a background timer. A bounded context pack, readiness/acknowledgment and atomic epoch handoff preserve context. Active/scheduled work blocks rotation. This is user policy, not a vendor cache promise.

Settings save into app-owned `policy.v1.json`. Route preview is non-executing; dispatch separately applies current policy. The global mock cap is two, additionally bounded by the selected owner's configured cap. Blocked queued work remains queued; it never silently falls back to a real provider.

## CLI and shared command contract

The app is the sole writer and process supervisor. The CLI never opens the task database or creates a fallback daemon.

```sh
npm run build
node dist/cli/main.mjs capabilities --json
node dist/cli/main.mjs tasks create --input request.json --command-id unique-retry-key --json --no-input
node dist/cli/main.mjs tasks get --task-id UUID --json
```

`package.json` exposes the `weaver` bin for normal package installation/linking. Inputs can be argument objects or full `{apiVersion:"weaver.v1",commandId,command,args}` envelopes; `--input -` reads stdin. Keep the same command ID when retrying an uncertain mutation. stdout contains one JSON response; exit 0 means the command was handled successfully, exit 1 means failure. Successful submission is not successful execution. See [logical command examples](skills/agents-cooperation/references/handoff.md).

Implemented commands include capabilities, owners spawn/attach/get/list/switch/continuation settings, tasks create/get/list/cancel/retry/events/results, packages create/get, workers spawn, artifacts read, result delivery/ack, reviews, command receipts, observability and synchronization snapshots. The command envelope is also exposed through the narrow renderer preload bridge.

### Transport and authorization boundary

Unix-domain IPC uses a random per-app-instance credential in an owned private directory; token/discovery/socket files are restricted. No token is put in argv or output. The credential grants **local trusted-user demo authority**, not per-owner isolation. Unknown providers fail closed. Do not connect untrusted external agents to this demo authority.

App absent returns `APP_NOT_RUNNING`. IPC requests/clients/timeouts are bounded. CLI disconnect never cancels app work. Windows transport is intentionally unavailable until current-user pipe ACLs are implemented; the desktop UI can still run. A stale discovery file fails closed: verify no app instance is running before manually removing stale `control.v1.json` from app userData. No automatic overwrite or unsafe endpoint takeover is performed.

## Architecture and persistence

Renderer / CLI → shared `CommandHandler` → `TaskStore`, policy, scheduler and adapters. Generic `OwnerHostAdapter`, `WorkerProviderAdapter` and a capability-checked registry are implemented. The mock owner supports delivery, acknowledgment, restoration and context handoff; the mock worker uses the existing bounded JSONL subprocess supervisor. No second control plane lives in the CLI.

The versioned JSON store retains tasks, owners, frozen packages, receipts, continuation history and a monotonic snapshot revision. In-process transactions atomically replace one file. Mutation intent is persisted before effects; an interrupted command returns `COMMAND_INDETERMINATE` rather than blindly repeating a spawn. This is not exactly-once external execution or a transactional outbox. The single writer uses fsync + rename, but no directory fsync. Caps include 200 tasks, 200 retained owners, 1,000 packages, 5,000 receipts, 32 MiB store and 500 events/task. There is no retention UI yet.

Renderer notifications invalidate snapshots; subscribe before loading and reload after missed notifications/reconnect. `sync.status` detects changed revision and `sync.snapshot` returns bounded summaries. Event queries use retained event IDs; expired cursors return `CURSOR_EXPIRED`, not silent loss. This is not a durable global push stream.

## Remaining integration and hardening

- Real owner host/provider adapters, installed-version verification, authorization and native protocol normalization
- Scoped external-agent credentials/object-level permissions, approval policy, real resource budgets and workspace isolation
- Real process-tree containment and side-effect reconciliation beyond the bundled single-process mock
- SQLite/indexed storage, durable outbox/recovery, retention/archival and production scale
- Windows secured named pipe, MCP facade, installers/signing
- Actual desktop GUI/preload/IPC and authenticated socket acceptance on an unrestricted supported machine

See [VERIFICATION.md](VERIFICATION.md), [architecture](docs/architecture.md), [agent-interface design](docs/agent-interface.md) and [migration inventory](docs/script-migration.md). Design documents describe a broader target, not proof every production feature exists. The public skill is host-independent. Apache-2.0; see LICENSE and NOTICE.
