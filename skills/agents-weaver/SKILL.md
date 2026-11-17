---
name: agents-weaver
description: "Run development work as a swarm through the Weaver scheduling engine (`weaver` CLI): cut a task into work packages that run at the same time, let Weaver launch them on Codex, Claude Code, OpenCode or DeepSeek Harness agents, wait for wake-ups, then accept or return each result. Also runs a design dialogue, in which Codex and Claude each propose a design and review the other's before anything is built. Use it when the work can be cut so that three or more packages start at once, when one long job that would fill your context (browser acceptance, a long test loop, a build and release, a wide search) can run beside your own work, and whenever a large architecture or feature-design decision needs a second opinion (对谈, 让 codex 和 claude 讨论方案, design review, debate). Do the work yourself when it is a question, a chain of dependent steps, or too narrow to run in parallel."
---

# Weaver

Weaver is a scheduling engine. It keeps the package tree and its dependencies, moves each package through its states, launches agents the fastest way each engine allows, and records wake events when something needs you. How those events reach the parent depends on the host; see [Waiting](#waiting). What to build, whether a result is good, commits, pushes and talking to the user stay with you: you are the owner of the mission, the agents are workers.

Every command prints JSON. Errors go to stderr as `{"error":{"code","message"}}` with a non-zero exit. `weaver help` lists every command.

## Choosing how to work

Weaver exists to finish a mission sooner by running work side by side. Every package costs about four minutes before it saves any: you write the instruction, the worker reads its way into the code, you verify the result. Packages handed off one at a time are slower than doing the work yourself.

Decide this before writing a plan, because it changes what the plan looks like:

| The task | Do this |
|---|---|
| A question, or a change smaller than its instruction would be | Do it yourself |
| A chain in which each step depends on what the last one showed: operating a machine, a live incident, narrowing down one bug | Do it yourself |
| Work you can cut so that **three or more packages start at once** | Delegate ([cut it](#cutting-the-work), then [the loop](#the-loop)) |
| One or two packages that each run long and would fill your context: browser acceptance, a long test loop, a build and release, a wide search | Delegate, and work on something else while they run |
| Work that hangs on a design decision that is hard to undo and has more than one defensible answer | Open a [design dialogue](#design-dialogue) first, then delegate |

"Do it yourself" is a valid outcome of this skill. A plan of three packages in which one is the prerequisite of the other two is a queue, not a swarm.

## Cutting the work

The speed-up is the width of the wave: how many packages are at work at the same moment. Cut for width, in this order.

1. **Do the spine yourself.** Whatever every other package would wait for is yours: the decision, the shared contract (type and function names, the schema, routes, file layout, a sample payload), the scaffold, the located cause of a bug. Do it before you submit and write its outcome into each instruction as fact. A prerequisite package holds the whole wave back for its run time plus your verdict, and leaves to a worker what you should have decided.
2. **When you do not know enough to cut, scout wide.** Send three to six scouts at once, each `advisory` and `autoAccept`, each with one narrow question and a fixed answer format (paths, line numbers, counts, a yes or no with evidence). Cut the work when they report. Do not explore alone for long, and do not send one scout after another.
3. **Cut by ownership, never by phase.** Each package owns files, directories, documents or hosts that no other running package touches, and its instruction names them. Each package carries its own tests and checks. "Implement, then test, then review" as three packages is a pipeline of width one.
4. **Shard batch work.** The same change across many files, documents or hosts is one instruction applied to several slices. Give each package an explicit list of the paths or IDs it owns.
5. **Aim for three to ten minutes of worker time per package.** Merge anything shorter into a neighbour, or do it yourself. Split anything longer than fifteen minutes unless it cannot be split (a build, one long test run).
6. **Add `dependsOn` only when a package needs what you cannot write down in advance:** the actual output of its upstream. What you can decide now goes into the instruction instead. Checking the integrated whole is the one legitimate last wave.

Packages that must edit the same files belong in one package, or in separate worktrees: a package may set its own `"workspace"`.

Check the shape before you submit, and read it back afterwards. The reply to `plan submit` carries `shape` (`ready`: packages of this plan that wait for nothing; `waves`: the longest dependency chain; `parallel`: packages of the mission at work once the plan is in; `high`: packages rated 8 or above) and, when the shape is weak, `advice`:

- Fewer than three packages at work and none of them long: cancel the plan and do the work yourself, or finish the spine and submit the rest as one wave.
- More than a third of the packages rated 8 or above: the spine is not done. See [Intelligence](#intelligence).

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

## Writing a plan

- **Self-contained instructions.** A worker sees only its package: state the goal, the files or areas it may touch, the constraints, and the checks it must run. It also receives the accepted results of the packages it depends on and, on a later attempt, your return note and its previous reply. It does not see this conversation.
- **Dependencies.** `dependsOn` names keys in the same plan or already in the mission. A dependent starts when its upstream is **accepted**, not when it merely has a result, so every edge costs the upstream's run time plus your verdict. Two packages that can run at the same time must not touch the same files.
- **Intelligence.** Every package states `intelligence`, a number from 1 to 10 in steps of 0.5: what its instruction leaves for the worker to work out (see [the scale](#intelligence)). Weaver gives the package to the lowest-rated candidates that qualify, chooses among those from each one's first-attempt acceptance rate, typical duration, remaining quota and current load, and moves up a tier only when they are full or unavailable. The reply and `weaver package show` name the chosen candidate with a one-line `routeNote`. You do not rank candidates and you do not need their names.
- **Pinning.** `worker` pins a package to one candidate regardless of its rating; use it only for a reason you could explain, such as a second opinion from a specific engine. `engine` restricts the choice to one engine. `weaver worker list` shows the candidates, their ratings and their measured results.
- **`"advisory": true`** for a package whose product is a document: research, an audit, a comparison. The agent is told to leave files alone and to cite what it read, and it reads its upstream results in full.
- **Long-running monitors are operational packages, not `advisory`.** State the terminal conditions, permitted actions, evidence and resource owner in the instruction. A verified PID or active scope proves startup only: report it as progress and continue monitoring. Deliver when the terminal condition is observed or an actionable problem needs the parent. Include the authoritative final state, evidence paths, process exit status and any retained resources with their owner and release condition. If the worker cannot call Weaver itself, the parent registers its artifacts and handles the verdict.
- **`"autoAccept": true`** for a result that needs no judgement from you before the next step, such as research feeding an implementation package. It is accepted as it arrives and its dependents start; you are not woken for it. A failure still wakes you. Do not use it on packages that change code: accepting is your statement that you checked the work.
- **All or nothing.** A cycle, an unknown dependency, a duplicate key, a missing `intelligence` or a package no enabled candidate is rated for (`NO_CANDIDATE`) rejects the whole plan. You may submit further plans to the same mission as the work unfolds.
- **`--key`** makes a submission idempotent: repeating the command returns the first result and creates nothing. Use it whenever a reply might have been lost.

## Intelligence

Packages and candidates share one scale. A candidate's rating is set by the user and says up to which level it still gets things right on the first attempt. A package's number says what its instruction leaves for the worker to work out. The number decides who does the work: the lowest-rated candidates that qualify take it, and there are more of them, on more accounts, than of the strong ones.

Work the number out from the instruction you wrote; do not estimate it from the task. An instruction answers three questions:

- **Where**: the files, symbols, documents or hosts.
- **What**: the change to make or the question to answer, and the approach.
- **Check**: the commands to run and the result to expect.

| `intelligence` | The instruction leaves open |
|---|---|
| 6 | Nothing. Where, what and check are written down, and following them is enough. |
| 7 | One kind of decision, inside a boundary you named: the exact place within one module, or the details of a change that follows a pattern or a specification you pointed to. |
| 8 | Where and what together, or one of them across a wide area. You gave the goal, the area and the constraints; the worker reads across modules to locate the work and handles neighbouring cases you did not list, or has to confirm a suspected cause by experiment. |
| 9 | Everything but the goal and the acceptance criteria: the worker makes the design trade-offs or finds an unknown cause, or correctness rests on reasoning no instruction can spell out (concurrency, data migration). |
| 10 | The instruction itself may be wrong. Do this yourself or open a design dialogue. |

Use half steps for an instruction that sits between two rows, and numbers below 6 for work a script could nearly do.

A review, an audit or a classification is rated the same way: where is the set to go through, what is the criteria to judge each item by, check is the form of the answer. With the criteria listed it is a 6.5 or a 7; "find what is wrong in here" is an 8.

These do not raise the number:

- **Stakes.** Production, credentials, customer data, an urgent incident. Write the limits into the instruction (read-only, which account, what must never run), mark an investigation `advisory`, and verify the result. A stronger model is not a substitute for a written limit.
- **Size.** Many files, a long instruction, a long run. Shard it, or accept that it runs long.
- **Wanting it right the first time.** A package that is returned goes to a higher-rated candidate on its next attempt by itself, so a number that turns out too low costs one retry. A number that is too high makes the package queue for the few strong candidates and spends the quota that the hard packages need.
- **A candidate you have in mind.** Do not read `weaver worker list` to pick a number that lands on a particular candidate.

Most packages of a well-cut plan are 6 or 7, because you did the spine: you already know where and what. When a package comes out at 8 or above, first write what you already know into its instruction (the file you located, the cause you found, the pattern to follow) and rate it again. What still sits at 9 is usually yours to do.

| The instruction says | Rate it |
|---|---|
| "Replace URL prefix A with B in these 44 documents (IDs listed). Nothing else may change. Read each one back and compare hashes." | 6. All three are given; the full job of 175 documents is four such packages. |
| "Read-only, through account X with `default_transaction_read_only=on`: find the size, ID and creation time of the file named N. Take the column names from `schemas/file.ts`. Output only these columns." | 6.5. Production does not raise it; the worker only has to map the schema. |
| "`raw += chunk` glues two segments into one line (wire log at P). Reproduce it from that log, fix the merge in `continuation.ts`, run tests T." | 7. The cause and the place are given; the form of the fix is left open. |
| "Add an audit entry to every mutation of the billing module, in the style of `orders/audit.ts`." | 8. The worker has to find the mutations and judge the odd ones. |
| "Uploads time out now and then under load. Find out why and fix it." | 9. Unknown cause: scout it or do it yourself. |

- When a plan is rejected with `NO_CANDIDATE`, the message names the highest rating available. Either write that package's instruction in more detail so that it honestly fits a lower level, or do the package yourself. Do not lower the number without changing the instruction.
- A `return` or a `retry` sends the next attempt to a candidate rated above the one whose attempt was not accepted, when there is one; the `routeNote` says so. A package pinned with `worker` stays where it is pinned.

## Package states

`pending` → `launching` → `running` → `awaiting_verdict` → `accepted`

- `pending` carries a `waiting` text that says why: an upstream is not accepted yet, or no candidate is ready.
- `return` on `awaiting_verdict` starts the next attempt of the same package. The note is required: it is the only thing that tells the next attempt what was wrong.
- `failed` can be retried with `weaver retry --package …`. A failure caused by a vendor limit pauses that account and moves the package to another ready candidate by itself.
- `cancelled` is final. `weaver cancel --package …` or `--mission …` returns once the processes are gone. On a resident engine (opencode) a cancel can only interrupt the session: the reply then has `residual: true` and the workspace to check for leftover commands.
- The mission itself is `settled` (shown as 待收尾) once every package has ended, and becomes `done` only when you run `weaver mission close`. Close it after your own remaining work and the delivery to the user are finished, not as soon as the last package is accepted; while you wait on the user, leave it open.

## While a wave runs

- **Give each verdict at once.** Verify a result as soon as it arrives: its dependents, and the mission's clock, wait on you.
- **Do not hand off follow-ups one at a time.** Verification turns up corrections. Make the ones smaller than their instruction yourself, as long as no running package owns the file. Collect the rest and submit them together as the next wave, cut by the same rules. A mission that grows by one single-package plan after another is serial work with overhead on top.
- **Use the time.** While the wave runs, prepare the next one: its spine, its instructions, the acceptance checklist.

## Waiting

`weaver wait --mission <id>` returns on a result, a failure, a stall report, a timer or an external wake. Each wake is delivered once: a plain `wait` continues after the last one, and `--cursor <n>` asks for everything after a sequence number.

- **Verify the notification route for this host.** A recorded owner session or `wake: true` event does not prove delivery or that the parent resumed. Do not infer Herdr push support in a LobeHub/API session or another host. Without a verified route that can resume this parent, stay in bounded `weaver wait --mission <id> --timeout 30s` calls, handling results and reporting progress between calls. A timer or a detached watch does not establish that route.
- **On resuming a mission, read `mission show` before waiting.** Handle every `awaiting_verdict` package by reading its result, checking evidence and giving `accept` or `return`; an earlier one-shot notification may already have been consumed. A timeout or the absence of a new message does not mean there are no results to review.
- `idle: true` means nothing is running and no timer is set, so waiting longer cannot help. Read `hint`, then act: give verdicts, retry, or submit more work.
- `kind: "stalled"` means a package produced no event for five minutes and its processes used almost no CPU. It is still running. Look at `weaver events --mission <id>` before deciding to cancel: a quiet long build is not a stall.
- `weaver timer set --mission <id> --in 20m --note "check the long build"` wakes you later. Timers survive service restarts.
- Inside Herdr, `mission create` records your pane. While you are not waiting, wakes are pushed into your session as a `[Weaver]` message with the same JSON and are not repeated by the next `wait`.
- A service restart or upgrade does not interrupt running packages, and `wait` reconnects by itself for up to 60 seconds.

`weaver mission show <id>` gives the mission state and every package. `weaver events --mission <id> [--follow]` is the full stream: launches, hand-off to the engine, tool activity, results, verdicts.

## Before ending your turn

Read `weaver mission show <id>` again; startup evidence and an earlier snapshot are not a completion check.

- Resolve outstanding `awaiting_verdict` packages first: inspect each result and its evidence, then give a verdict. If a verdict needs a user decision, state that decision and leave it pending. Do not accept merely to clear the queue.
- If work is still running, continue your own useful work or bounded waits. Ending the turn with a background handoff requires a verified notification route that resumes the responsible parent, plus a named owner and terminal conditions. A running monitor alone is not that handoff; an explicit user request to stop or defer takes precedence.
- Handle failed or blocked packages within the authorized scope, or report the precise unresolved condition. Do not describe unfinished work as complete.
- Once delivery and resource cleanup are complete, close the mission and read back `done`. While awaiting a user decision, keep it open and state what remains. Report verified results and material limits without claiming an external deployment or recovery from a monitoring result alone.

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
- One exchange is enough for most questions. Without `--rounds` the count comes from the user's `dialogue_rounds` setting, which starts at one. Use `--rounds 2` when the stakes are high and you expect real disagreement; each extra round adds two runs.
- The two sides are the debater seats the user configured (甲方 and 乙方: engine, model, effort and account each), not routed candidates. If a seat is not ready the command says which one and why: tell the user rather than working around it. `--workers a,b` names two candidates for one dialogue instead.
- `dialogue show` reports `running`, `concluded` or `needs_attention`. If a side failed, `weaver retry --package m_…/cache-design.r1.a` and the dialogue continues from there; do not start a new one.

### From dialogue to work

The dialogue advises. The decision is yours, and the user's where it is theirs.

1. **Read the whole transcript**, not only the closing parts. The reviews are where the facts get checked.
2. **Sort the points** into agreed and disputed. For every disputed point, and for every agreed point the design rests on, check the claim in the code yourself. Two models agreeing is not evidence: they can share a blind spot.
3. **Decide point by point.** Take the better-argued side on each; merge only if the parts actually fit together. A dispute that turns on product priority, cost or risk appetite rather than on a technical fact is the user's to settle, so carry it forward instead of settling it.
4. **Get one outside check**, when the `chatgpt-review` skill is installed: see [Final check by ChatGPT Pro](#final-check-by-chatgpt-pro) below.
5. **Write the final report.** If a `feature-delivery` skill is available, follow it: its design-document format, its acceptance checklist and its delivery rules. Without it, the report still has to contain: the chosen design; what was rejected, one line of reason each; where the two sides disagreed and how you resolved it; the decisions left to the user, each with your recommendation; and a numbered acceptance checklist in which every item is an action with an observable expected result.
6. **Stop or go.** If the report leaves decisions to the user, present it and wait for the answer. If it leaves none, say so and continue.
7. **Hand over.** Accept the two final-position packages (`weaver verdict --package m_…/cache-design.r2.a accept`, then `.b`) to close the dialogue. Then submit the implementation plan. Workers see neither the dialogue nor your report, so each package's instruction must carry the part of the decided design it implements and the checklist items it has to satisfy.
8. **Verify against the checklist** as results come back, as in the loop.

### Final check by ChatGPT Pro

Two models that agree can share a blind spot, so the decided design gets one independent check through the `chatgpt-review` skill (Convorel) before the final report. Pro questions are scarce, about 100 a week, so the check has a fixed budget:

- **One question per dialogue.** Send the decided design once: what both sides agreed on, how you settled each dispute and why, and which claims you verified in the code. Ask for decision-blocking problems only, each with a counter-example, and for an explicit pass or fail. `chatgpt-review` says how to write and send it. Use the Convorel task ID `<mission ID>-<dialogue name>` and write it out literally in the command: that is how the question and the answer show up in the mission's timeline after the dialogue.
- **At most one correction round.** Check each reported problem against the code first. One you can settle yourself needs no dialogue: correct the design. For the rest, run one more exchange limited to them: `weaver dialogue start --name <name>-fix --rounds 1`, with a brief that gives the decided design as a constraint and lists only the confirmed problems. Then send one `followup` in the same Convorel task with the corrected design.
- **Then stop.** Whatever the second answer says, do not ask again and do not open another dialogue. What is still open goes into the final report as a decision for the user, with both positions and your recommendation.
- **This is the design's review.** Do not also run `chatgpt-review`'s own review of the same design before presenting it: that would spend the budget twice. Its check of the finished result against the design is a separate question and still applies, once.

Skip the check when the user asked for local work only or asked to save the budget, and when Convorel is unavailable: say in the report that the design was not checked, and carry on. Work that did not go through a dialogue gets no check from this rule; `chatgpt-review`'s own conditions decide there.

## Rules

- A worker's reply is evidence, not proof. Read the changed files and run the checks before `accept`.
- Give each verdict as soon as you have verified that package: its dependents are waiting on it.
- Do not launch engine CLIs yourself, and do not pick models outside `weaver worker list`.
- Do not stop the service or its engines to fix something: they are shared with other missions. Report what you saw instead.
- If `weaver` says the service is not running, tell the user (`weaver service install`) and work without delegation.
