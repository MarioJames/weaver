---
name: weaver2
description: "Dispatch development work through the Weaver 2 scheduling engine (`weaver` CLI, Go rewrite). You stay the owner of a mission: split it into work packages with dependencies, submit the plan in one command, wait for wake-ups, then accept or return each result. Weaver picks the engine, account and launch mode. Use it whenever work can be delegated to worker agents; do the work yourself only for a pure question or when the user asks."
---

# Weaver 2

Weaver 2 is a scheduling engine, not an application. It owns four things for you: the package tree and its dependencies, the package state machine, the progress stream, and waking you up. It decides which candidate (engine, model, effort, account) runs each package and launches it the fastest way that engine allows. Everything else — what to build, whether a result is good, commits, pushes, talking to the user — stays with you.

Run `weaver help` for the full command list. Every command prints JSON; errors go to stderr as `{"error":{"code","message"}}` with a non-zero exit.

## The loop

```sh
# 1. One mission per root task. Run it from the workspace, or pass --workspace.
weaver mission create --title "Add rate limiting to the gateway"        # → {"id":"m_…"}

# 2. Submit the whole decomposition at once. Independent packages start immediately.
weaver plan submit --mission m_… --key plan-1 <<'JSON'
{"packages":[
  {"key":"limiter","title":"Token bucket","instruction":"…self-contained instruction…"},
  {"key":"wiring","title":"Wire into middleware","instruction":"…","dependsOn":["limiter"]},
  {"key":"docs","title":"Document the limits","instruction":"…","worker":"claude_sonnet_high"}
]}
JSON

# 3. Block until something needs you. Returns at once if it already happened.
weaver wait --mission m_…

# 4. Read the result, verify it yourself, then decide.
weaver package result m_…/limiter
weaver verdict --package m_…/limiter accept
weaver verdict --package m_…/wiring return --note "The middleware order is wrong: auth must run first."

# 5. Go back to step 3 until the mission is done.
```

A package reference is its ID or `<mission>/<key>`.

## Writing a plan

- A package must be finishable by an agent that sees nothing but the package: goal, exact files or areas it may touch, constraints, and checks it must run. The agent also receives the accepted results of the packages it depends on, and on a second attempt your return note plus its previous reply.
- `dependsOn` names keys in the same plan or keys already in the mission. A dependent is released when its upstream is **accepted**, not when it merely has a result. Never give two packages that can run at the same time the same files.
- A plan with a dependency cycle, an unknown dependency or a duplicate key is rejected whole; nothing is created.
- You may submit more plans to the same mission later as the work unfolds.
- Leave `worker` and `engine` unset so routing balances load across the weighted candidates. Pin `worker` only for a justified choice; a pinned package may use a weight-0 candidate. See `weaver worker list`.
- `--key` makes a submission idempotent: repeating the command with the same key returns the first result and creates nothing. Use one whenever a reply might have been lost.

## Package states

`pending` → `launching` → `running` → `awaiting_verdict` → `accepted`

- `pending` carries a `waiting` text that says why: upstream not accepted yet, or no ready candidate.
- `awaiting_verdict` + `return` starts the next attempt of the same package (back to `launching`); the note is mandatory.
- `failed` can be retried with `weaver retry --package …`. A failure caused by a vendor limit pauses that account and moves the package to another candidate automatically when one is ready.
- `cancelled` is final. `weaver cancel --package …` or `--mission …` returns once the processes are gone. On a resident engine (opencode) a cancel can only interrupt the session; the reply then has `residual: true` and the workspace to check for leftover commands.

## Waiting

`weaver wait --mission <id>` returns when there is a result, a failure, a stall report, a timer or an external wake. Each wake is delivered once: a plain `wait` continues from where the last one (or the last push) stopped; `--cursor <n>` asks for everything after a given sequence number.

- `idle: true` means nothing is running and no timer is set, so waiting longer cannot help: read `hint`, then decide (give verdicts, retry, submit more work).
- `kind: "stalled"` means a package has produced no event for five minutes (and, for a process of its own, used no CPU). It is still running. Look at `weaver events --mission <id>` and decide whether to keep waiting or cancel and retry.
- `weaver timer set --mission <id> --in 20m --note "check the long build"` wakes you later; timers survive service restarts.
- If you run inside Herdr, `mission create` records your pane. While you are **not** waiting, wakes are pushed into your session as a `[Weaver]` message containing the same JSON, and are not repeated by the next `wait`.
- `wait` reconnects by itself for up to 60 seconds if the service restarts. Running packages are not interrupted by a restart.

## Progress

`weaver mission show <id>` gives the mission state, per-state counts and every package. `weaver events --mission <id> [--follow]` is the event stream: launch, hand-off to the engine (with the launch mode: resident session, standby process or cold start), tool activity, results, verdicts.

## Rules

- A worker's reply is evidence, not proof. Read the changed files and run the checks before `accept`.
- Give each verdict as soon as you have verified that package; dependents are waiting on it.
- Do not launch engine CLIs yourself and do not pick models outside `weaver worker list`.
- Never stop the service or its engines to "fix" something; they are shared. Report what you saw instead.
- If `weaver` reports that the service is not running, tell the user (`weaver service install`), then work without delegation.
