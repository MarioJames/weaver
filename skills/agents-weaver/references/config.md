# Policy fields that steer an owner

`weaver policy get --output json` returns `{revision, config, blocks}` plus per-role availability. Read it fresh before each dispatch decision; it can change while you work (a scheduled quota refresh adds or lifts blocks).

| Field | Meaning for you |
|---|---|
| `owners.<id>.engine` | The owner profile for your host is the enabled owner on that engine (`claude`, `codex`, ...); Weaver allows at most one enabled owner per engine. |
| `owners.<id>.workers` / `worker_weights` | Weaver balances dispatch by weight: it picks the available worker with the lowest `(running + cancelling + 1) / weight`, counting each worker across all owners; ties go to higher weight, then policy list order. Idle work goes to the highest weight and concurrent work spreads in proportion to the weights. Weights are integers 0-10; missing weight means 5; weight `0` means never dispatched, and an explicitly named worker cannot bypass it. You do not pick workers; omit `worker` when dispatching. |
| `owners.<id>.max_parallel` | Running/cancelling packages each owner **instance** may hold at once; more are queued with `scheduled: true`. `<id>` is the policy *profile*; each agent session registers its own owner *instance* under it with `owners attach` (durable identity: `profileId` + `name` + `session`) and dispatches by `ownerId`; the profile is not a shared capacity cap ([handoff](handoff.md)). |
| `herdr.max_wait_minutes` | (1–1440) The longest interval between two checks on a worker: wait only with `weaver tasks wait`, which returns as soon as the task ends. Weaver never stops a worker on it. |
| `workers.<id>` | `engine`, `model`, `effort`, `enabled`, and a `description` of what the worker is good at. A worker on your own engine runs natively. |
| `blocks` | Active manual, quota, vendor-limit or stall pauses. A matching engine/model block skips the worker; `policy preview` names the reason and any release time. Runtime vendor-limit blocks show a short reason (e.g. `限流：Rate limit exceeded…`). Rate limits within 2 h escalate release times 10 → 30 → 60 min; 2 h quiet resets the ladder, and a later vendor retry time wins. Quota without a retry time stays until manual unblock. Queued tasks on a vendor-blocked engine reroute to another eligible engine; failed attempts still need explicit retry. Stall blocks have no time-based expiry; see below. |
| `chatgpt_review` | `true`: apply the gates in [convorel](convorel.md). `false`: skip ChatGPT Pro review; local review and tests still apply. |

## Stall penalties

`weaver tasks health --task-id <id>` uses silence and owned-scope CPU activity: `stalled` requires both silence and continuous CPU-idle for at least 5 minutes; missing CPU evidence never proves a stall. At least two stalled workers on the same engine trigger its penalty. Level 1 probes after 5 minutes, level 2 after 10; one successful probe lifts either. Level 3 probes every 10 minutes and needs three consecutive successes or the user. These are probe times, not block expiry times; automatic recovery removes only its own stall block.

`weaver engines health` returns summaries without history; `weaver engines penalty --engine <id>` includes retained history. `weaver engines unblock --engine <id> --command-id <stable-id>` manually clears **all** blocks on that exact engine, including manual, quota, model and stall, and resets the penalty while retaining history. This is the user's call; an owner must not do it unless the user asked.

## Preview a route before dispatch

```sh
weaver policy preview --input '{"owner":"codex_owner"}' --output json
weaver policy preview --input '{"owner":"codex_owner","worker":"opencode_worker"}' --output json
```

The result names the selected worker (`selected_by`: `weight` or `worker`), the frozen engine/model/effort, the dispatchable `candidates` with their running counts, and every skipped candidate with its reason. It never launches anything.

## Editing the policy

Routing changes affect every later dispatch — make them with the user's consent, on the web pages, or from the CLI:

1. `weaver policy validate --input <config>` returns an empty issue list when valid.
2. `weaver policy save --input {revision,config,blocks}` with the current revision; `REVISION_CONFLICT` means someone saved first: re-read and reapply, never overwrite.

Enable or disable engines only through `weaver engines set-enabled` (it probes the CLI first), never through `policy save`.
