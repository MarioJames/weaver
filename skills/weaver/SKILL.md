---
name: weaver
description: "Use Weaver to coordinate owner-led development through its CLI: inspect capabilities and routing, freeze bounded worker packages, dispatch, verify files and artifacts, acknowledge results, and record acceptance or manual context handoff."
---

# Weaver

Weaver is the scheduling authority for this task. Use its saved configuration, route preview and execution records. Do not run the global agents-cooperation/Herdr scheduler, native subagents, or another dispatch loop in place of Weaver. The public skill is named `weaver`; it does not replace any global `agents-cooperation` skill.

## Role and preflight

You are the external Owner in your real CLI host. Weaver registers logical ownership; `owners spawn` does not launch an Owner AI. Only explicit `provider: "mock"` / `ownerProvider: "mock"` uses the fixture Owner. `owners attach` is metadata only: session/pane labels are unverified and no external host is contacted.

A Worker executes one package, modifies only its authorized files, returns actual evidence and risks, and never delegates, invokes a scheduler, commits, pushes, or communicates with the user. If you were launched as a Worker, honor that role and stop before any Owner operations below.

Before dispatch:

1. Read `weaver --help --output json`, `weaver capabilities --output json`, and `weaver policy get --output json`. A missing control plane reports `APP_NOT_RUNNING`; start the existing foreground `weaver web --no-open` when authorized. Closing a browser or client does not stop admitted work.
2. Select the available Owner profile for your host and read its worker order, priority weights, fixed engine and active quota blocks. Engine scan proves only installation/version. `realExecution` means the Worker launcher exists; authentication and model availability are not established until an actual call. Claude Code real execution is deferred. Never substitute mock or another engine after a real failure.
3. Classify the package as `mechanical`, `routine`, or `judgment`; inspect `weaver policy preview --help --output json` and preview the saved route. `tag` is for judgment domain selection; an explicit `worker` is for a justified choice or continuation. Weaver enforces weight 0, fixed engine, current policy, quota and capacity. Greater weights are priorities within the current routing tier, not random probabilities.

## Execute and review

Read [the handoff contract](references/handoff.md) before the first create/dispatch. Use `weaver <command> --help --output json` for required input fields; natural and dotted command names are equivalent. Keep JSON argument files under the [task scratch-root contract](references/handoff.md#task-scratch-root) and use stable command IDs.

Create a task with the real absolute project workspace, bind its manual Owner, freeze an explicit read/write scope and acceptance criteria, then call `workers spawn`. Inspect the returned frozen worker/engine/model/effort and requested versus observed run evidence. A queued dispatch keeps its route; `queueReason` explains capacity, policy, changed frozen route or workspace. Do not overlap writers or create duplicate attempts while a dispatch is queued or running. Scope is a trusted-local cooperation boundary; it is not OS isolation.

Use bounded `tasks wait` or `tasks watch --for 1..600` and inspect task state after timeout. They poll the same control plane and do not replay mutations. An uncertain mutation response requires `operations get --command-id <same-id>` plus task/Owner inspection; never blindly retry with a new ID. An expired event cursor requires a fresh task snapshot.

After terminal execution, pull `tasks results` and `artifacts read`. Independently read the actual changed files, inspect the diff, and run the package acceptance checks. A provider's success text is evidence to review, not proof of correct files. Call `results ack` with the current digest/revision to record receipt, then obtain the new revision and call `reviews submit` only after the independent review. Receipt acknowledgement and acceptance are separate. Manual Owners have no automatic host delivery; `results deliver` can return `CAPABILITY_UNAVAILABLE`. Do not treat mock-memory delivery/ack as real host acceptance.

For manual context continuation, inspect `owners continuation get`; after all workers and queued dispatches are quiescent, use `owners switch` with current revision/epoch. Read the returned bounded `contextPack` yourself. Manual history has `acknowledgementId: null`: no new AI, automatic host delivery, host acknowledgement, context reset or vendor-cache retention is claimed. Idle `due` is a signal for the skill to request this handoff, not automatic replacement of a real Owner context. The real CLI host performs any actual context switch.

Report package ownership, selected route, observed vendor evidence (unknown stays unknown), file verification, receipt/acceptance state and remaining risk. Preserve real development data and native auth/config. Stop only resources owned by this task. Do not disclose Weaver's local socket credential or provider credentials. Current authority is trusted local user scope; it is not isolated authentication for untrusted external agents.

See [provenance](references/provenance.md) for the actual upstream origin and current capability boundaries.
