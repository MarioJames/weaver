---
name: agents-weaver
description: "The default way to do development work when the `weaver` CLI is on PATH: you stay the owner and Weaver dispatches the work to worker agents on other engines (OpenCode, Qoder, Pi, Codex, Grok). Use it for implementation, refactors, migrations, tests, docs, research and verification in a repository. Exceptions only: pure questions, a tiny change (a few lines in one file, no new tests or docs), or the user explicitly asking you to do it yourself. You plan, freeze bounded packages, dispatch with `weaver workers spawn`, review the real diff, then accept."
---

# Agents Weaver

Weaver is the scheduling authority for owner-led work on this machine. Its saved policy decides which worker, engine, model and effort run a package; its CLI is the only interface you use. Do not run another scheduler, spawn worker CLIs yourself, or pick models outside the policy. Your host's built-in subagent tool is used only for a dispatch Weaver marks `execution: "native"`.

## Roles

- **You are the owner.** You understand the request, split it, freeze packages, dispatch, review evidence, decide, and report to the user. Commits, pushes and user communication stay with you.
- **A worker** executes one frozen package inside its read/write scope, returns evidence, and never delegates, commits, pushes or talks to the user. If you were started as a worker, follow that contract and ignore the owner steps below.

## Preflight (once per session)

1. `weaver --version`. Missing: tell the user to install it (`curl -fsSL https://raw.githubusercontent.com/MarioJames/weaver/main/install.sh | bash`) and continue without delegation.
2. `weaver capabilities --output json`. `APP_NOT_RUNNING` means no control plane: start `weaver web --no-open` as a persistent background process (a Herdr pane or `systemd-run --user --scope`), never tied to your shell; closing it later stops admitted work. `TRANSPORT_ERROR` inside a Codex `workspace-write` sandbox means the sandbox blocks the local socket: ask the user to set `sandbox_workspace_write.network_access = true` (or run with full access); do not change their config yourself.
3. `weaver policy get --output json` and read, per [config](references/config.md):
   - **Your owner profile**: the enabled owner whose engine is your host (`claude` for Claude Code, `codex` for Codex). Its `workers` and `worker_weights` are your dispatch candidates; `max_parallel` bounds concurrent work.
   - **Weights**: highest weight first, ties by list order, weight `0` never dispatched. A worker on your own engine runs natively.
   - **`herdr.max_wait_minutes`**: the longest you wait for one package before treating it as stalled.
   - **`chatgpt_review`**: whether the [Convorel review gates](references/convorel.md) apply.
   - **Blocks** (`policy get` `blocks`, `weaver quota get`): paused or quota-exhausted engines; dispatch skips them.
4. `weaver policy preview --input '{"owner":"<profile>"}'` shows the worker Weaver would pick now and the skipped ones with reasons. Engine scan proves installation only; a route is usable when a dispatch actually runs.

## Decide what to delegate

Dispatching through Weaver is the default for development work. Do it yourself only for a pure question, a tiny change, or when the user explicitly asks you to; say which exception applies. A tiny change is a few lines in one file that needs no new tests or docs; adding tests, touching several files, writing docs or anything you would verify by running something is not tiny, however short the diff. "Small", "simple" or "quick" is not an exception. Before doing work yourself under the tiny-change exception, state the files you will change and whether tests are needed; if it is more than one file, needs tests, or contains more than one independent problem, dispatch it, one package per problem. If the control plane is not running, start it (preflight step 2) rather than skipping Weaver; only if `weaver` is missing or cannot start, say so and do the work yourself.

Split the work into packages and classify each: **mechanical** (fixed rules, explicit files, checkable result), **routine** (bounded implementation of a frozen plan), **judgment** (design, cross-module or risky). Dispatch mechanical and routine packages; for judgment work, settle the design yourself (with the Convorel gate when it applies), then dispatch the implementation as routine packages. Integration, review and final decisions stay with you. Never let two writers share files; independent packages can run in parallel up to `max_parallel`.

A package states: goal, absolute workspace, exact read/write scope, constraints (no delegation, no commits, no unrelated files, the task scratch root), acceptance criteria you can check, and expected artifacts. Write it so a worker with no conversation context can finish it.

## Dispatch and wait

`--input` takes a JSON file, `-` for stdin, or the JSON object itself (`--input '{"owner":"codex_owner"}'`). Follow [the CLI handoff](references/handoff.md): `tasks create` (with your owner profile and the real workspace) → `packages create` → `workers spawn`. Inspect the returned frozen worker/engine/model/effort. Name a `worker` only for a justified choice or a continuation; otherwise Weaver uses the weights.

- `execution: "real"`: Weaver launched the worker. Wait with bounded `weaver tasks wait --task-id <id> --for 600` (repeat up to `max_wait_minutes`); do independent work meanwhile.
- `execution: "native"`: nothing was launched. Run the package with your built-in subagent tool at the frozen model/effort and scope, then `weaver workers complete` with outcome, summary and artifacts.
- `scheduled: true`: queued for capacity or policy; `queueReason` explains. Do not create duplicate attempts.

A failed real worker never falls back to mock or another engine. Read the failure, then fix the package, adjust the policy with the user, or do the work yourself; record which.

## Review and accept

After a terminal state: `tasks results`, `artifacts read`, then read the actual changed files, inspect the diff and run the package's acceptance checks yourself. A worker's success text is evidence, not proof. `results ack` records receipt; `reviews submit` with `accepted` or `rejected` records your decision after independent review. If `chatgpt_review` is on and the package crosses a review gate, run the Convorel review before accepting.

Mutations use stable `--command-id`s. After an uncertain response, inspect `operations get --command-id <same-id>` before anything else; never blindly retry with a new ID.

## Report

Tell the user, per package: owner, worker, engine, requested vs observed model, class, status, evidence you verified, review result and remaining risk. Unknown vendor facts stay unknown. Do not disclose Weaver's local socket credential or provider credentials. Stop only resources this task started.

See [provenance](references/provenance.md) for origin and current capability boundaries.
