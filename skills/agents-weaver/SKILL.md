---
name: agents-weaver
description: "Run development work as a swarm through the Weaver scheduling engine (`weaver` CLI): cut a task into work packages that run at the same time on Codex, Claude Code, OpenCode or DeepSeek Harness agents, wait for wake-ups, then accept or return each result. Also runs a design dialogue in which engines propose designs and review each other's. Use when three or more packages can start at once, when one long job (browser acceptance, a long test loop, a build and release, a wide search) can run beside your own work, or when a large design decision needs a second opinion (对谈, 让 codex 和 claude 讨论方案, design review, debate). Do the work yourself when it is a question, a chain of dependent steps, or too narrow to run in parallel."
---

# Weaver

Weaver is a scheduling engine. It keeps the package tree and its dependencies, moves each package through its states, launches agents the fastest way each engine allows, and records wake events when something needs you. How those events reach the parent depends on the host; see [Waiting](#waiting). What to build, whether a result is good, commits, pushes and talking to the user stay with you: you are the owner of the mission, the agents are workers.

Every command prints JSON. Errors go to stderr as `{"error":{"code","message"}}` with a non-zero exit. `weaver help` lists every command.

Read the reference for what you are about to do. When the skill directory is not installed, `weaver skill <name>` prints the same text.

| About to | Read | Or run |
|---|---|---|
| Write a plan: cut the work, write instructions, rate `intelligence` | [references/plan.md](references/plan.md) | `weaver skill plan` |
| Open or conclude a design dialogue | [references/dialogue.md](references/dialogue.md) | `weaver skill dialogue` |
| Handle a failed, stalled or cancelled package, an unfamiliar wake, or a resumed mission | [references/states-and-waiting.md](references/states-and-waiting.md) | `weaver skill states-and-waiting` |

## Choosing how to work

Weaver exists to finish a mission sooner by running work side by side. Every package costs about four minutes before it saves any: you write the instruction, the worker reads its way into the code, you verify the result. Packages handed off one at a time are slower than doing the work yourself.

Decide this before writing a plan, because it changes what the plan looks like:

| The task | Do this |
|---|---|
| A question, or a change smaller than its instruction would be | Do it yourself |
| A chain in which each step depends on what the last one showed: operating a machine, a live incident, narrowing down one bug | Do it yourself |
| Work you can cut so that **three or more packages start at once** | Delegate: read [the plan reference](references/plan.md), then run [the loop](#the-loop) |
| One or two packages that each run long and would fill your context: browser acceptance, a long test loop, a build and release, a wide search | Delegate, and work on something else while they run |
| Work that hangs on a design decision that is hard to undo and has more than one defensible answer | Open a [design dialogue](references/dialogue.md) first, then delegate |

"Do it yourself" is a valid outcome of this skill. A plan of three packages in which one is the prerequisite of the other two is a queue, not a swarm.

## The loop

```sh
# 1. One mission per root task. Run it from the workspace, or pass --workspace.
weaver mission create --title "Add rate limiting to the gateway"        # → {"id":"m_…"}

# 2. Submit the whole wave at once. You decided the limiter's interface yourself, so nothing waits for it.
weaver plan submit --mission m_… --key plan-1 <<'JSON'
{"packages":[
  {"key":"limiter","title":"Token bucket in internal/limit","instruction":"…self-contained instruction, with the interface you decided…","intelligence":6.5},
  {"key":"wiring","title":"Call the limiter from the middleware","instruction":"…written against the same interface…","intelligence":6},
  {"key":"config","title":"Limits in the config schema","instruction":"…","intelligence":6},
  {"key":"docs","title":"Document the limits","instruction":"…","intelligence":6},
  {"key":"e2e","title":"End-to-end check of the limited routes","instruction":"…","intelligence":7,"dependsOn":["limiter","wiring","config"]}
]}
JSON
# The reply reports the shape: {"shape":{"packages":5,"ready":4,"waves":2,"parallel":4,"high":0}}

# 3. Wait in bounded calls so you can respond and report progress between them.
# Returns at once if something already needs you. A timeout is not completion.
weaver wait --mission m_… --timeout 30s

# 4. Read the result, verify it yourself, then decide.
weaver package result m_…/limiter
weaver verdict --package m_…/limiter accept
weaver verdict --package m_…/wiring return --note "The middleware order is wrong: auth must run first."

# 5. Back to step 3 until every package is accepted.
# Before ending your turn, read mission show and apply the completion check below.
# 6. Finish your own part (integrate, run, commit, deliver), then: weaver mission close m_…
```

`mission create` automatically records the parent Agent session (Claude Code or Codex).

When delivering designs, acceptance reports or other artifacts, upload with feature-delivery’s sharing script and `--mission <mission>` to register them automatically. Register documents that are not shared with `weaver artifact add`.

A package reference is its ID or `<mission>/<key>`.

## While a wave runs

- **Give each verdict at once.** Verify a result as soon as it arrives: its dependents, and the mission's clock, wait on you.
- **Do not hand off follow-ups one at a time.** Verification turns up corrections. Make the ones smaller than their instruction yourself, as long as no running package owns the file. Collect the rest and submit them together as the next wave, cut by the same rules. A mission that grows by one single-package plan after another is serial work with overhead on top.
- **Use the time.** While the wave runs, prepare the next one: its spine, its instructions, the acceptance checklist.

## Waiting

`weaver wait --mission <id>` returns on a result, a failure, a stall report, a timer or an external wake. Each wake is delivered once.

- **Verify the notification route for this host.** A recorded owner session or a `wake: true` event does not prove that the parent resumed. Without a verified route that can resume this parent, stay in bounded `weaver wait --mission <id> --timeout 30s` calls, handling results and reporting progress between them. A timeout is not completion.
- **On resuming a mission, read `weaver mission show <id>` before waiting** and give a verdict on every `awaiting_verdict` package: an earlier one-shot notification may already have been consumed.
- `idle: true` means nothing is running and no timer is set, so waiting longer cannot help: read `hint`, then act.
- Stalls, timers, the event stream, Herdr pushes and service restarts are in [the reference](references/states-and-waiting.md).

## Before ending your turn

Read `weaver mission show <id>` again; startup evidence and an earlier snapshot are not a completion check.

- Resolve outstanding `awaiting_verdict` packages first: inspect each result and its evidence, then give a verdict. If a verdict needs a user decision, state that decision and leave it pending. Do not accept merely to clear the queue.
- If work is still running, continue your own useful work or bounded waits. Ending the turn with a background handoff requires a verified notification route that resumes the responsible parent, plus a named owner and terminal conditions. A running monitor alone is not that handoff; an explicit user request to stop or defer takes precedence.
- Handle failed or blocked packages within the authorized scope, or report the precise unresolved condition. Do not describe unfinished work as complete.
- Once delivery and resource cleanup are complete, close the mission and read back `done`. While awaiting a user decision, keep it open and state what remains. Report verified results and material limits without claiming an external deployment or recovery from a monitoring result alone.

## Rules

- A worker's reply is evidence, not proof. Read the changed files and run the checks before `accept`.
- Give each verdict as soon as you have verified that package: its dependents are waiting on it.
- Do not launch engine CLIs yourself, and do not pick models outside `weaver worker list`.
- Do not stop the service or its engines to fix something: they are shared with other missions. Report what you saw instead.
- If `weaver` says the service is not running, tell the user (`weaver service install`) and work without delegation.
