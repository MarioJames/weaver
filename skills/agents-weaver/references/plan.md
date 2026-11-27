# Cutting the work, writing the plan, rating intelligence

Read this before you write a plan. It decides how wide the wave is and which candidates take each package.

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
- More than a third of the packages rated 8 or above: the spine is not done. See [Intelligence](#intelligence) below.

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
