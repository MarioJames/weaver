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

Read IDs, revisions and digests from responses instead of predicting them. For a scalar, use `--field data.id`, `--field data.revision`, or `--field data.manifestDigest`; this reads a response field without shell JSON parsing. Check every command's exit status before using its output. `--field` is for non-streaming read commands only and cannot be combined with `--output`/`--json`.

Use JSON files or `--input -` with a quoted heredoc for request bodies containing Chinese text, newlines or quotes. Do not use `echo "$response" | ...` to parse JSON: zsh echo expands backslash escapes. If forwarding existing JSON is unavoidable, use `printf '%s\n' "$response"`. The [handoff reference](references/handoff.md#shell-safe-input-and-result-review) shows file/stdin input and ack/review without constructing JSON.

## Preflight (once per session)

1. `weaver --version`. Missing: tell the user the install one-liner (`curl -fsSL https://raw.githubusercontent.com/MarioJames/weaver/main/install.sh | bash`) and work without delegation.
2. `APP_NOT_RUNNING` from any command: run `weaver server start` (idempotent; it waits until the service answers). The service is shared by every session: never stop it and never kill its process, even if you started it — only the user stops it. Inside a Codex `workspace-write` sandbox, `TRANSPORT_ERROR` means the sandbox blocks the local socket: ask the user to allow `network_access` (`sandbox_workspace_write.network_access = true`); do not change their config yourself.
3. `weaver policy get --output json`: dispatch through the owner profile enabled on your host engine (`claude` for Claude Code, `codex` for Codex); Weaver picks the worker by balancing weights and current load, so you never choose one; `chatgpt_review` decides whether the [Convorel review](references/convorel.md) gates apply. Weight, block and wait rules: [config](references/config.md).
4. Register **this session** as an owner, once, right after reading the policy:

   ```sh
   weaver owners attach --input '{"profileId":"<profile>","name":"Claude · weaver · 14:20","session":"<reference>"}' --command-id owner-<date>-<short hash of session>
   ```

   `name` = `<Host> · <workspace dir name> · <HH:MM session start>`; `session` = `$CODEX_THREAD_ID` when set, else `$HERDR_PANE_ID` when set, else the absolute workspace path; the `--command-id` stays the same for the whole session, so a lost reply re-issued with it returns the same owner. Keep the returned `id` and use it as `ownerId` in every task below; if you lost it, `weaver owners list` and take the entry with the same name/session — never fall back to `ownerProfileId`, which registers a new throwaway owner for that one task.

   Once this session's main task is clear, give the instance a readable board title: `weaver owners describe --input '{"ownerId":"<id>","title":"<short specific topic>"}' --command-id <stable-id>`. Match the host session title when one exists, and update the title whenever the main task changes. A parent Agent root started from the Weaver page needs no title — the board shows its root task title.
5. `weaver policy preview --input '{"owner":"<profile>"}'` shows the route Weaver would pick right now, without launching anything.

## UI root tasks

The UI starts a root with `weaver tasks start --task-id <root> --command-id <stable-id>`. This command returns immediately with a running owner root; Herdr starts the configured claude/codex owner in the background. Inspect `tasks get` and `tasks events` for `ownerHost` or a launch failure. A failed launch without an owner host can be retried with `tasks start` and a new stable command ID; `tasks retry` remains for child worker attempts.

If the prompt identifies you as the root owner, reuse its existing `ownerId` instead of attaching a new instance. Read the full task goal, generate a concrete title and verifiable acceptance criteria with `tasks describe` (including `expectedRevision`), then split the work along natural boundaries into at least one child. The parent Agent does not implement itself; an indivisible goal still dispatches to a single sub-Agent rather than being verified hands-on. Create each with `parentTaskId: <root>`; the root supplies the owner instance, workspace and constraints unless the child provides its own workspace/constraints. Freeze and dispatch each child through the normal flow below. Do not freeze or dispatch the root as one worker package. The root does not consume a worker slot.

**The root task is a meta task.** The parent Agent's output is the decomposition, dispatch, review, and the final acceptance of the whole against the root acceptance criteria. Allocate the root criteria across the branches yourself: every work package must be self-contained, because the sub-Agent receives only the package (its goal, write scope, constraints and the package's own acceptance criteria) and never the root goal or the root criteria. Write into each package what that branch needs to finish: the context, interface contracts, the areas it must not touch, and complete, concrete, independently checkable acceptance criteria. Do not write "see the task" or any other reference to the root. If a sub-Agent goes off course, that is a decomposition problem: fix the split or the package and re-dispatch; do not paste global context into the sub-Agent.

`tasks list --input '{"parentTaskId":"<root>"}'` lists children and retry history. Review each child independently with `reviews submit`; receipt acknowledgement alone is insufficient. Retries retain `parentTaskId`; a superseded attempt remains history while its final attempt must pass review. Once the root acceptance criteria are verified and at least one final subtask exists with all final subtasks completed and accepted, call `tasks complete --task-id <root> --input '{"outcome":"completed","summary":"<verified results>","expectedRevision":<current>}' --command-id <stable-id>`. Optional artifacts use the same format as `workers complete`. If the root cannot finish, report `outcome: "failed"` with the actual reason. `workers complete` is only for native child workers. Cancelling a running root cancels its active children and asynchronously closes its parent Agent host; inspect task events for cleanup failures.

## Flow

接到尚未命名的任务后，先读取完整目标，生成简短标题与可验证的验收标准，使用 `weaver tasks describe --task-id <id> --input <json> --command-id <stable-id>` 回填；JSON 含 `title`、`acceptanceCriteria` 和 `tasks get` 返回的 `expectedRevision`。回填后再冻结和派发，验收标准不得用占位内容代替。

1. `weaver tasks create --input task.json --command-id <stable-id>` — `ownerId` from preflight, goal, absolute workspace, constraints, acceptance criteria ([shapes](references/handoff.md)).
2. `weaver packages create --task-id <id> --input package.json --command-id <stable-id>` — freezes the exact read/write scope and this branch's own acceptance criteria (omitted `acceptanceCriteria` defaults to the child task's own; explicit ones win and never overwrite the task).
3. `weaver workers spawn --task-id <id> --input dispatch.json --command-id <stable-id>` — follow the returned `next` action.
4. For a wait action, check first events within 1–2 minutes, then `weaver tasks wait --task-id <id>` at its default interval; see below.
5. `weaver tasks results --task-id <id>` and `weaver artifacts read --task-id <id> --input read.json` — then read the real changed files and run the checks yourself; a worker's success text is evidence, not proof.
6. `weaver results ack --task-id <id> --expected-revision <current> --manifest-digest <digest> --command-id <stable-id>` — records receipt only.
7. `weaver reviews submit --task-id <id> --expected-revision <fresh> --manifest-digest <digest> --decision accepted --comment-file review.txt --command-id <stable-id>` — your `accepted`/`rejected` decision after independent review.

`workers spawn` and `tasks retry` return `next`: real or queued work gives a wait command; native gives `run_subagent` with model, effort, the full prompt and a completion command (`then`). For `run_subagent`, use your built-in subagent tool, then report with `weaver workers complete` using a stable command ID ([report](references/handoff.md#native-execution-report)). Queued routes stay frozen except when a vendor-limit block reroutes queued work; after a wait, `weaver tasks get --task-id <id>` recovers `next` for a now-running native dispatch. Never create duplicate attempts.

A package must be finishable by a worker with no conversation context: goal, absolute workspace, exact read/write scope, constraints (no delegation, no commits, the task scratch root), acceptance checks you can verify, and expected artifacts. Split independent problems into separate packages; never give two writers the same file.

## Waiting rule

For a wait action after spawn, use `weaver tasks wait --task-id <id> --for 60` and check `weaver tasks events --task-id <id>` within 1–2 minutes. No worker output by then is suspect: inspect `weaver tasks health --task-id <id>` before deciding it is stuck. Then keep waiting with `weaver tasks wait --task-id <id>` at its default interval: it returns on completion, stalled health, or after min(600 s, `herdr.max_wait_minutes` × 60), or 30 s if policy is unreadable. This setting is the longest interval between checks; never sleep or set a longer timer instead. Claude Code may run wait in the background and act on its notification.

After each return, inspect status and events. `tasks health` reports `starting` before a real worker’s first output, then `working` / `waiting_model` / `stalled`, silence and CPU activity; finished tasks return `ended` with final `taskStatus`. Unreadable CPU never proves a stall. `tasks wait` returns early with reason `stalled` and a retry/cancel hint; `watch` reports the transition and continues. Real workers fail as `no_output` after 120 s without valid vendor output; this check is separate from the waiting interval. Decide from that evidence whether to keep waiting, cancel, or retry, and say why.

## Failures and retries

`weaver tasks retry --task-id <id> [--cancel] --command-id <stable-id>` is one step: after preflight, optionally cancel an in-flight attempt, clone its frozen package with a continuation note, dispatch and return `next`. Omit `--cancel` for a terminal task. Follow `next`; do not spawn again. The retry chain excludes failed/cancelled/cancelling engines; completed engines remain eligible. An attempt that ended on a vendor rate limit or exhausted quota does not exclude its engine: that worker is blocked on its own, so the retry may take another worker on the same engine. `NO_ALTERNATIVE_ENGINE` leaves the original unchanged when none remain. Real never falls back to mock.

`weaver engines health` summarizes penalties; `weaver engines penalty --engine <id>` includes history. At least two workers on one engine silent **and CPU-idle** for 5 minutes pause it. Penalties do not expire: levels 1/2 require one successful recovery probe; level 3 requires three consecutive successes or the user. Vendor rate limits and exhausted quota block the failing worker first (ladder 10/30/60 minutes per worker, block carries `worker`); only when every enabled worker of an engine is blocked is the engine blocked too, released with the earliest worker block. A disabled or blocked engine simply takes its owners and workers out of scheduling; disabling an engine never requires disabling its roles first. `weaver engines unblock --engine <id> --command-id <stable-id>` clears **all** blocks on that engine (manual, quota, model, worker-level and stall) and resets its penalty; this is the user's call, never yours unless requested.

Mutations carry stable `--command-id`s; after an uncertain response, inspect `weaver operations get --command-id <same-id>` before anything else. Never retry blindly with a new ID.

## Report

Per package, tell the user: which owner instance you are (its name and id), worker, engine, model, status, the evidence you verified, review result and remaining risk. No credentials, no Weaver socket token. Clean up only the scratch and resources this task started; the shared Weaver service is never one of them.

Origin and current capability boundary: [provenance](references/provenance.md).
