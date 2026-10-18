# agents-cooperation script migration inventory

> 实现状态更新（2026-10-18）：下文保留完整目标设计，不能把其中旧的“CLI 未实现 / 只有预览”描述当作当前状态。已实现 weaver.v1 共享 handler、Unix CLI/认证 IPC 代码、mock owner/worker 适配层、策略准入/排队、结果验收、上下文轮换及同步快照。真实 agent 接入、外部 owner scoped auth、SQLite/outbox 和生产级进程树控制仍待实现。CLI 的真实 socket 集成因当前环境 EPERM 未验收；最新事实见 [README](../README.md) 与 [VERIFICATION](../VERIFICATION.md)。

Source: `skill-foundry` revision `61989b1`, `skills/agents-cooperation/`. Target: Weaver app main-process code. This is a **bounded, partial code migration**, not a claim that every old script is migrated. No upstream files were changed and no old executable was run.

## Script-by-script disposition

| Source file | Disposition | App implementation / reason |
|---|---|---|
| `scripts/agents-config.ts`: validation, EFFORTS, class tags, availability, active blocks, release-time parsing, worker selection | Migrated/adapted | `src/main/policy/routing.ts`: same structural and cross-reference rules; mechanical → routine → paid fallback, judgment domain preference, ordered fallback, explicit-worker warning, skipped diagnostics and peer suggestion. Preview returns only identifiers/model/effort and diagnostics, never launch instructions. |
| `scripts/agents-config.ts`: CLI parsing, show/validate/status/block/unblock | Replaced | Typed narrow IPC plus `PolicyStore` and renderer Settings. Config and blocks edit explicitly, validate and atomically save with revision checks. No Bun CLI or global-path discovery. |
| `scripts/agents-config.ts`: interactive argv, native tool parameters, peer launch, opencode remembered-variant reads, web launcher | Intentionally not ported | Provider execution and owner transport require a verified app adapter. No bypass flags, hidden sessions, host-home reads or automatic peer launch. Peer suggestion is advisory. |
| `scripts/agents-runtime.ts` | Retired as worker runtime; production replacement deferred | Existing app `TaskManager`/mock process lifecycle replaces the demo execution path. Old run/lane/session/GC/reconciliation logic is not copied or enabled. Production supervisor and crash reconciliation remain future work. |
| `scripts/lib/json-schema.ts` | Migrated | `src/main/policy/json-schema.ts`, same supported JSON Schema subset and prototype-safe property/ref handling, with upstream attribution. |
| `scripts/lib/state-db.ts` | Replaced only for config/quota persistence; runtime DB migration deferred | `PolicyStore` stores config and blocks separately from mock history in `policy.v1.json`. Timestamp validation, duplicate block rejection, engine/model identity, expiration filtering and manual removal supported. No SQLite import, automatic migration, run/lane tables or historical takeover. |
| `scripts/lib/external-call.ts` | Not migrated | Surviving external Herdr command launcher is incompatible with bounded app-owned workers. No equivalent external-command surface added. |
| `scripts/lib/process-identity.ts` | Deferred | Linux `/proc` owner/runtime identity and operation scanning cannot be presented as cross-platform containment. Existing mock recovery never reconnects to old PIDs. Production identity/containment needs OS-specific verification. |
| `scripts/lib/session-evidence.ts` | Not migrated | Session-directory fingerprints support old hidden-session cleanup. Weaver must not claim ownership of those resources; future artifact ingestion requires its own scoped security design. |
| `scripts/lib/runtime-events.ts` | Not migrated; production event store deferred | SQL triggers reference retired run/lane tables. Mock event history remains app-owned; immutable transactional lifecycle audit remains future work. |

## Related assets, web code and tests

- `assets/config.schema.json` and `config.default.json` are bundled under `src/main/policy/`. The provider/model vocabulary is the upstream baseline, not a current model catalog or installation probe. `herdr.max_wait_minutes` is retained solely to accept compatible config documents; it has no runtime effect. `chatgpt_review` is preserved as a policy preference, not an implemented external review integration. Model strings are nonempty preferences; no catalog lookup or provider capability validation is claimed.
- `assets/availability.schema.json` is replaced by app boundary validation for a bounded block list in `PolicyStore`; no file-path or SQLite availability importer is included. Absolute timezone-bearing `since`/`release_at` are required in saved blocks. The migrated pure helper also supports relative durations, but the current JSON editor requires absolute timestamps.
- `web/server.ts`, `web/launch.ts`, `web/lib/{config-store,availability,read-state,agent-board,errors}.ts` are not bundled. Settings persistence/availability are replaced by main-process IPC. HTTP server, browser opener and old runtime-board reading are unnecessary or deferred.
- `web/src/*` is not copied. `src/renderer/Settings.tsx` supplies config/block JSON edit, validation/save/reload and saved-policy route preview; the existing app board remains mock-only. This is not UI parity with the old web app.
- `tests/agents-config.test.ts` behavior is covered by 19 new Node tests in `tests/policy.test.ts`: structural/semantic validation, effort sets, prototype safety, routing order/classes/tags, explicit selection, advisory peers, blocks/expiry, release parsing, persistence/revision conflicts, invalid input retention and preview capacity. Tests were rewritten for pure app interfaces, not run through old Bun commands.
- `tests/agents-runtime.test.ts`, `tests/state-db.test.ts`, `scripts/lib/runtime-events.test.ts` and web tests are not claimed ported: their session/SQLite/HTTP contracts do not exist in Weaver. Existing app lifecycle/parser/store tests remain in place.

## App boundary and intentionally changed semantics

`getPolicy`, `validatePolicy`, `savePolicy`, `previewRoute` are **renderer preload methods**, not public owner-agent tools. Main validates exact trusted renderer origin and payloads. Settings live in Electron userData, never the old global config/state paths. JSON saves replace the whole validated document; stale revision writes fail and invalid input preserves disk/memory. Store size is bounded at 256 KiB and blocks at 500. It uses atomic rename plus file fsync, not a multi-writer DB or complete power-loss guarantee.

Every route response has `dispatch: "preview"` and `execution: "disabled"`. It includes owner max-parallel and a capacity calculation from a **hypothetical caller-supplied count**; this is not a live scheduler or admission guarantee. Existing mock tasks still use two fixed slots and do not consume this policy. Block edits affect policy previews only; no automatic quota detection or retries are wired to a real provider.

The skill contains principles and current capability guidance. Transport-aware owner/session details are legacy app compatibility fields. Future logical owner creation/registration and worker dispatch belong in the app API, not in skill scripts.

## Verification

`npm run check` passed: strict typecheck, 37/37 Node tests, production renderer/main/preload build. No real agent, API call, Herdr process, upstream edit or publish. Interactive settings rendering and actual Electron IPC remain unverified under the documented container startup restriction; see `VERIFICATION.md`.
