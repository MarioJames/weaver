---
name: weaver2
description: "Run development work through the Weaver 2 scheduling engine (`weaver` CLI): split a task into work packages with dependencies, let Weaver launch them on Codex, Claude Code, OpenCode or DeepSeek Harness agents, wait for wake-ups, then accept or return each result. Also runs a design dialogue, in which Codex and Claude each propose a design and review the other's before anything is built. Use it whenever implementation, refactoring, tests, research or verification can be handed to worker agents, and whenever a large architecture or feature-design decision needs a second opinion (对谈, 让 codex 和 claude 讨论方案, design review, debate). Do the work yourself only for a pure question or when the user asks you to."
---

# Weaver 2

Weaver 2 is a scheduling engine. It keeps the package tree and its dependencies, moves each package through its states, launches agents the fastest way each engine allows, and wakes you when something needs you. What to build, whether a result is good, commits, pushes and talking to the user stay with you: you are the owner of the mission, the agents are workers.

Every command prints JSON. Errors go to stderr as `{"error":{"code","message"}}` with a non-zero exit. `weaver help` lists every command.

## Choosing how to work

Decide this before writing a plan, because it changes what the plan looks like:

| The task | Do this |
|---|---|
| A question, or a change smaller than a package would take to describe | Do it yourself |
| Work whose design is settled or follows an existing pattern | Delegate packages ([the loop](#the-loop)) |
| Work that hangs on a design decision that is hard to undo and has more than one defensible answer | Open a [design dialogue](#design-dialogue) first, then delegate |

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

# 5. Back to step 3 until every package is accepted, then: weaver mission close m_…
```

A package reference is its ID or `<mission>/<key>`.

## Writing a plan

- **Self-contained instructions.** A worker sees only its package: state the goal, the files or areas it may touch, the constraints, and the checks it must run. It also receives the accepted results of the packages it depends on and, on a later attempt, your return note and its previous reply. It does not see this conversation.
- **Dependencies.** `dependsOn` names keys in the same plan or already in the mission. A dependent starts when its upstream is **accepted**, not when it merely has a result, so your verdict is what releases the next step. Two packages that can run at the same time must not touch the same files.
- **Routing.** Leave `worker` and `engine` unset: Weaver balances the weighted candidates. Pin `worker` only for a reason you could explain; a pinned package may use a weight-0 candidate, which is how pay-per-use API models are kept out of automatic routing. `weaver worker list` shows the candidates.
- **`"advisory": true`** for a package whose product is a document: research, an audit, a comparison. The agent is told to leave files alone and to cite what it read, and it reads its upstream results in full.
- **`"autoAccept": true`** for a result that needs no judgement from you before the next step, such as research feeding an implementation package. It is accepted as it arrives and its dependents start; you are not woken for it. A failure still wakes you. Do not use it on packages that change code: accepting is your statement that you checked the work.
- **All or nothing.** A cycle, an unknown dependency or a duplicate key rejects the whole plan. You may submit further plans to the same mission as the work unfolds.
- **`--key`** makes a submission idempotent: repeating the command returns the first result and creates nothing. Use it whenever a reply might have been lost.

## Package states

`pending` → `launching` → `running` → `awaiting_verdict` → `accepted`

- `pending` carries a `waiting` text that says why: an upstream is not accepted yet, or no candidate is ready.
- `return` on `awaiting_verdict` starts the next attempt of the same package. The note is required: it is the only thing that tells the next attempt what was wrong.
- `failed` can be retried with `weaver retry --package …`. A failure caused by a vendor limit pauses that account and moves the package to another ready candidate by itself.
- `cancelled` is final. `weaver cancel --package …` or `--mission …` returns once the processes are gone. On a resident engine (opencode) a cancel can only interrupt the session: the reply then has `residual: true` and the workspace to check for leftover commands.

## Waiting

`weaver wait --mission <id>` returns on a result, a failure, a stall report, a timer or an external wake. Each wake is delivered once: a plain `wait` continues after the last one, and `--cursor <n>` asks for everything after a sequence number.

- `idle: true` means nothing is running and no timer is set, so waiting longer cannot help. Read `hint`, then act: give verdicts, retry, or submit more work.
- `kind: "stalled"` means a package produced no event for five minutes and its processes used almost no CPU. It is still running. Look at `weaver events --mission <id>` before deciding to cancel: a quiet long build is not a stall.
- `weaver timer set --mission <id> --in 20m --note "check the long build"` wakes you later. Timers survive service restarts.
- Inside Herdr, `mission create` records your pane. While you are not waiting, wakes are pushed into your session as a `[Weaver]` message with the same JSON and are not repeated by the next `wait`.
- A service restart or upgrade does not interrupt running packages, and `wait` reconnects by itself for up to 60 seconds.

`weaver mission show <id>` gives the mission state and every package. `weaver events --mission <id> [--follow]` is the full stream: launches, hand-off to the engine, tool activity, results, verdicts.

## Design dialogue

Some decisions are cheap to make and expensive to undo. For those, let two engines design independently and review each other before any package is written. `weaver dialogue start` runs Codex and Claude on one brief: both write a proposal without seeing the other's, then each reviews the other's and revises its own. You are woken once, when both final positions are in.

### When to open one

Open a dialogue when the user asks for one (对谈, 讨论一下方案, "have codex and claude debate this", a second opinion on a design), or when all three of these hold:

1. **The decision is hard to reverse or wide in reach.** A new subsystem or architecture, a data model, schema or migration strategy, a public interface or protocol, a refactor across modules, a technology choice, or a feature large enough that it will take about five or more packages.
2. **More than one answer is defensible.** You can name at least two approaches you could argue for, or you cannot yet name the right one. When the codebase already has a pattern for this kind of thing, follow the pattern; that is not a design question.
3. **You can brief it.** You can state the goal and the constraints, from the request and from reading the code. When the goal itself is unclear ("make it faster"), ask the user for what is missing and open the dialogue once you have it: two engines debating a vague goal return two confident guesses. Details the code or a sensible default can settle are not a reason to ask.

Do not open one for a bug fix, a change that follows an existing pattern, mechanical work (renames, dependency bumps, test backfill), UI polish, a design the user has already decided, or anything urgent. A dialogue costs four strong-model runs and several minutes. Spent on a routine change that is waste; skipped on an architectural one, it is how a mission gets rebuilt halfway through.

When it is a close call, do not open one: make the decision yourself and write the reason into your plan.

When you open one on your own judgement, tell the user in one line what you are putting to the dialogue and why, and carry on. Wait for permission only if the user asked to approve each step.

### Running it

```sh
weaver dialogue start --mission m_… --name cache-design <<'BRIEF'
Goal: …what must be true when this is done…
Constraints: …compatibility, performance, deadlines, what must not change…
Where to look: …paths and existing mechanisms that matter…
Settle these: 1) … 2) …
Out of scope: …
BRIEF
weaver wait --mission m_…                                   # woken by the final positions, or by a failure
weaver dialogue show --mission m_… --name cache-design      # state and the full text of every round
```

- **The brief is all both sides get besides the code**, and every round is a fresh agent that reads it again. Leave your own preferred design out of it: it anchors both sides and you get one design twice. A decision the user has already made goes in as a constraint.
- One exchange is the default and is enough for most questions. Use `--rounds 2` when the stakes are high and you expect real disagreement; each extra round adds two runs.
- The sides default to one Codex and one Claude candidate. `--workers a,b` names two candidates instead.
- `dialogue show` reports `running`, `concluded` or `needs_attention`. If a side failed, `weaver retry --package m_…/cache-design.r1.a` and the dialogue continues from there; do not start a new one.

### From dialogue to work

The dialogue advises. The decision is yours, and the user's where it is theirs.

1. **Read the whole transcript**, not only the closing parts. The reviews are where the facts get checked.
2. **Sort the points** into agreed and disputed. For every disputed point, and for every agreed point the design rests on, check the claim in the code yourself. Two models agreeing is not evidence: they can share a blind spot.
3. **Decide point by point.** Take the better-argued side on each; merge only if the parts actually fit together. A dispute that turns on product priority, cost or risk appetite rather than on a technical fact is the user's to settle, so carry it forward instead of settling it.
4. **Write the final report.** If a `feature-delivery` skill is available, follow it: its design-document format, its acceptance checklist and its delivery rules. Without it, the report still has to contain: the chosen design; what was rejected, one line of reason each; where the two sides disagreed and how you resolved it; the decisions left to the user, each with your recommendation; and a numbered acceptance checklist in which every item is an action with an observable expected result.
5. **Stop or go.** If the report leaves decisions to the user, present it and wait for the answer. If it leaves none, say so and continue.
6. **Hand over.** Accept the two final-position packages (`weaver verdict --package m_…/cache-design.r2.a accept`, then `.b`) to close the dialogue. Then submit the implementation plan. Workers see neither the dialogue nor your report, so each package's instruction must carry the part of the decided design it implements and the checklist items it has to satisfy.
7. **Verify against the checklist** as results come back, as in the loop.

## Rules

- A worker's reply is evidence, not proof. Read the changed files and run the checks before `accept`.
- Give each verdict as soon as you have verified that package: its dependents are waiting on it.
- Do not launch engine CLIs yourself, and do not pick models outside `weaver worker list`.
- Do not stop the service or its engines to fix something: they are shared with other missions. Report what you saw instead.
- If `weaver` says the service is not running, tell the user (`weaver service install`) and work without delegation.
