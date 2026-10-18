# Verification record

Checked 2026-10-18 in a Linux container with Node.js 24.19.0 and npm 11.9.0. No real agent CLI, AI API, owner host launch, project worker edits, remote publish, or upstream source modification was performed.

## Latest full check

`npm run check` passed: strict TypeScript checks, 84 tests (81 passed, 3 skipped), production Vite renderer, bundled Electron main/preload, executable ESM CLI and copied mock worker. The 3 skips explicitly report sandbox `EPERM` denying Unix socket listen; no security bypass or permission escalation was attempted.

Built CLI smoke: `node dist/cli/main.mjs capabilities --user-data /tmp/weaver-nonexistent-smoke` prints one `weaver.v1` JSON `APP_NOT_RUNNING` error and exits 1.

Coverage includes actual bundled mock subprocess execution/artifacts, command-driven logical owner creation and frozen-package dispatch, policy admission and queue scheduling, cancellation/timeout/exit reconciliation, retries, immutable result hashes, delivery/acknowledgment/review separation, stale revisions, durable receipt retries/conflicts/interruption, atomic rollback, restart recovery, owner/context handoff/ack failure/epoch races, inactivity policy boundaries, bounded context packs/redaction, malformed persisted data, snapshot revision/reconnect/invalidation ordering, CLI parsing/subprocess JSON, renderer component/command tests, escaping and route settings.

Three socket tests are present but not executed here: authenticated round-trip/restart, invalid authentication/oversize rejection, and unsafe token/endpoint cleanup. Non-socket discovery permission/substitution tests pass. A real authenticated CLI→socket→app round trip remains desktop acceptance work.

## GUI and platform limitations

The earlier Electron smoke attempt failed with Chromium `socket() failed: Operation not permitted`, SIGTRAP, and no DISPLAY/xvfb. No sandbox-disabling flags were used. Consequently the actual Electron window, preload/native IPC, native file picker, visual behavior and real socket lifecycle have not been interactively verified. React server-render and backing lifecycle tests are not a substitute for that acceptance.

Windows CLI IPC is explicitly unsupported until secure current-user named-pipe ACLs exist. No real owner/provider adapter, arbitrary process-tree cleanup, scoped external-owner authentication, SQLite/outbox, installer or signing acceptance is claimed.

## Supported-desktop acceptance

Run `npm ci && npm run dev`; create a goal/workspace/profile/acceptance task; dispatch mock workers beyond capacity; inspect automatic queue progress, events and artifact text; acknowledge and review; cancel queued/running tasks; retry; switch owner and verify retained context; change idle policy; restart and verify history. In a separate terminal exercise the built CLI and authenticated error/retry paths. Confirm no real agent or host session launches. Inspect redacted exports before sharing; redaction is best effort.
