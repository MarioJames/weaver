---
name: agents-weaver
description: "The default way to do development work when the `weaver` CLI is on PATH: you stay the owner and Weaver dispatches the work to worker agents on other engines (OpenCode, Pi, Grok, Codex, Qoder). Use it for implementation, refactors, migrations, tests, docs, research and verification; the size of a change is never a reason to skip. The only exceptions are a pure question, and doing the work yourself when the user explicitly asks."
---

# Agents Weaver

Weaver is the scheduling authority for owner-led work on this machine: its saved policy picks the worker, engine, model and effort for a package; your host stays the owner. Do not run another scheduler, spawn worker CLIs yourself, or pick models outside the policy. Your host's built-in subagent tool runs only a dispatch marked `execution: "native"`.

## Roles

- **You are the owner.** Understand the request, split it, freeze packages, dispatch, verify evidence, decide, and report to the user. Commits, pushes and user communication stay with you.
- **A worker** runs one frozen package inside its read/write scope and never delegates, commits, pushes or talks to the user. If you were started as a worker, follow that contract and ignore the owner steps below.

Dispatch every task through Weaver except a pure question — a small edit, test or doc is not a reason to skip. Do the work yourself only when the user explicitly asks; if `weaver` is missing or the service cannot start, say so, then work without delegation.

## Learn the current CLI

The installed binary is the authority for syntax and exact fields; this skill keeps only the common commands:

```bash
weaver --help                            # the command catalog
weaver tasks wait --help --output json   # fields and required input of one command
weaver --skill                           # prints this skill
```

Read IDs, revisions and digests from the JSON responses instead of predicting them.

## Preflight (once per session)

1. `weaver --version`. Missing: tell the user the install one-liner (`curl -fsSL https://raw.githubusercontent.com/MarioJames/weaver/main/install.sh | bash`) and work without delegation.
2. `APP_NOT_RUNNING` from any command: run `weaver server start` (idempotent; it waits until the service answers). The service is shared by every session: never stop it and never kill its process, even if you started it — only the user stops it. Inside a Codex `workspace-write` sandbox, `TRANSPORT_ERROR` means the sandbox blocks the local socket: ask the user to allow `network_access` (`sandbox_workspace_write.network_access = true`); do not change their config yourself.
3. `weaver policy get --output json`: dispatch through the owner profile enabled on your host engine (`claude` for Claude Code, `codex` for Codex); Weaver picks the worker by balancing weights and current load, so you never choose one; `chatgpt_review` decides whether the [Convorel review](references/convorel.md) gates apply. Weight, block and wait rules: [config](references/config.md).
4. Register **this session** as an owner, once, right after reading the policy:

   ```sh
   weaver owners attach --input '{"profileId":"<profile>","name":"Claude · weaver · 14:20","session":"<reference>"}' --command-id owner-<date>-<short hash of session>
   ```

   `name` = `<Host> · <workspace dir name> · <HH:MM session start>`; `session` = `$CODEX_THREAD_ID` when set, else `$HERDR_PANE_ID` when set, else the absolute workspace path; the `--command-id` stays the same for the whole session, so a lost reply re-issued with it returns the same owner. Keep the returned `id` and use it as `ownerId` in every task below; if you lost it, `weaver owners list` and take the entry with the same name/session — never fall back to `ownerProfileId`, which registers a new throwaway owner for that one task.
5. `weaver policy preview --input '{"owner":"<profile>"}'` shows the route Weaver would pick right now, without launching anything.

## Flow

1. `weaver tasks create --input task.json --command-id <stable-id>` — `ownerId` from preflight, goal, absolute workspace, constraints, acceptance criteria ([shapes](references/handoff.md)).
2. `weaver packages create --task-id <id> --input package.json --command-id <stable-id>` — freezes the exact read/write scope.
3. `weaver workers spawn --input dispatch.json --command-id <stable-id>` — inspect the returned frozen worker/engine/model/effort before trusting it.
4. `weaver tasks wait --task-id <id>` — the only way to wait; see the next section.
5. `weaver tasks results --task-id <id>` and `weaver artifacts read --task-id <id> --input read.json` — then read the real changed files and run the checks yourself; a worker's success text is evidence, not proof.
6. `weaver results ack --task-id <id> --input ack.json --command-id <stable-id>` — records receipt only.
7. `weaver reviews submit --task-id <id> --input review.json --command-id <stable-id>` — your `accepted`/`rejected` decision after independent review.

In the spawn response: `execution: "real"` means Weaver launched the worker process; `execution: "native"` means nothing was launched — run the package with your built-in subagent tool at the frozen model/effort, then report with `weaver workers complete`; `scheduled: true` means queued for capacity or policy (`queueReason` explains) — never create duplicate attempts.

A package must be finishable by a worker with no conversation context: goal, absolute workspace, exact read/write scope, constraints (no delegation, no commits, the task scratch root), acceptance checks you can verify, and expected artifacts. Split independent problems into separate packages; never give two writers the same file.

## Waiting rule

`herdr.max_wait_minutes` is the longest interval between two checks on a worker. Wait only with `weaver tasks wait --task-id <id>`: it returns as soon as the task ends, and without `--for` one call waits min(600 s, max_wait_minutes) before returning the current snapshot. Claude Code may run it in the background and act on the notification. Never sleep or set a longer timer instead.

After each return, look at the task status and `weaver tasks events`. Weaver never stops a worker by time; if it is stuck or off track, you decide: run `weaver tasks cancel`, then continue from partial output or re-dispatch, and say why.

## Failures and retries

A failed real worker never falls back to another engine; read the failure, fix the package, or do the work yourself — and record which. Mutations carry stable `--command-id`s; after an uncertain response, inspect `weaver operations get --command-id <same-id>` before anything else. Never retry blindly with a new ID.

## Report

Per package, tell the user: which owner instance you are (its name and id), worker, engine, model, status, the evidence you verified, review result and remaining risk. No credentials, no Weaver socket token. Clean up only the scratch and resources this task started; the shared Weaver service is never one of them.

Origin and current capability boundary: [provenance](references/provenance.md).
