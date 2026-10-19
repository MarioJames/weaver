# Policy fields that steer an owner

`weaver policy get --output json` returns `{revision, config, blocks}` plus per-role availability. Read it fresh before each dispatch decision; it can change while you work (a scheduled quota refresh adds or lifts blocks).

| Field | Meaning for you |
|---|---|
| `owners.<id>.engine` | The owner profile for your host is the enabled owner on that engine (`claude`, `codex`, ...); Weaver allows at most one enabled owner per engine. |
| `owners.<id>.workers` / `worker_weights` | Weaver balances dispatch by weight: it picks the available worker with the lowest (running tasks + 1) / weight, so idle work goes to the highest weight and concurrent work spreads in proportion to the weights. Missing weight means 100; weight `0` means never dispatched, and an explicitly named worker cannot bypass it. You do not pick workers; omit `worker` when dispatching. |
| `owners.<id>.max_parallel` | Running packages this owner may hold at once; more are queued with `scheduled: true`. `<id>` is the policy *profile*; each agent session registers its own owner *instance* under it with `owners attach` and dispatches by `ownerId` ([handoff](handoff.md)). |
| `herdr.max_wait_minutes` | (1–1440) The longest interval between two checks on a worker: wait only with `weaver tasks wait`, which returns as soon as the task ends. Weaver never stops a worker on it. |
| `workers.<id>` | `engine`, `model`, `effort`, `enabled`, and a `description` of what the worker is good at. A worker on your own engine runs natively. |
| `blocks` | Active pauses, manual or quota. A blocked engine or worker is skipped; `policy preview` names the reason and release time. |
| `chatgpt_review` | `true`: apply the gates in [convorel](convorel.md). `false`: skip ChatGPT Pro review; local review and tests still apply. |

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
