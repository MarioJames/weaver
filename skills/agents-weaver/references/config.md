# Reading and changing the Weaver policy

`weaver policy get --output json` returns `{revision, config, blocks}` plus per-role availability. The same document is edited on the web pages (open the service URL from `weaver server status`, then 引擎 / 负责人 / 工作代理 / 设置). Read it fresh before each dispatch decision; it can change while you work (a scheduled quota refresh adds or lifts blocks).

## Fields that steer an owner

| Field | Meaning for you |
|---|---|
| `owners.<id>.engine` | The owner profile for your host is the enabled owner on your engine (`claude`, `codex`, ...). Weaver allows at most one enabled owner per engine. |
| `owners.<id>.workers` | Workers this owner may dispatch to, in tie-break order. |
| `owners.<id>.worker_weights` | Priority per worker; missing means 100. Highest available weight wins; `0` means never dispatched. Weights are priorities, not probabilities. |
| `owners.<id>.max_parallel` | Running packages this owner may hold at once; more are queued with `scheduled: true`. |
| `workers.<id>` | `engine`, `model`, `effort`, `enabled`, and a `description` of what the worker is good at. A worker on your own engine is dispatched as `execution: "native"`. |
| `engines.<id>.enabled` | A disabled engine makes its workers unavailable. Enabling goes through `weaver engines set-enabled` (it probes the CLI first), not `policy save`. |
| `engines.<id>.quota_refresh` | Whether Weaver polls that subscription's quota (codex, claude, grok only). An exhausted window adds a block `by: "weaver-quota:<kind>"` that lifts itself at reset. |
| `blocks` | Active pauses, manual or quota. A blocked engine or worker is skipped; `policy preview` names the reason and release time. |
| `herdr.max_wait_minutes` | How long you keep polling `weaver tasks wait` for one package (1–1440); past it, inspect events and decide to keep waiting, cancel, or take the package back. Weaver never stops a worker on it. |
| `chatgpt_review` | `true`: apply the Convorel review gates in [convorel.md](convorel.md). `false`: skip ChatGPT Pro review; local review and tests still apply. |
| `quota.auto_refresh`, `quota.interval_minutes` | The scheduled quota refresh (5–1440 minutes). |

## Checking a route before dispatch

```sh
weaver policy preview --input '{"owner":"codex_owner"}' --output json
weaver policy preview --input '{"owner":"codex_owner","worker":"opencode_worker"}' --output json
```

The result names the selected worker, `selected_by` (`weight` or `worker`), the frozen engine/model/effort, and every skipped candidate with its reason (weight 0, disabled, engine disabled, blocked). It never launches anything.

## Changing the policy

Change routing only when the user asks or agrees, because it affects every later dispatch. Prefer the web pages; from the CLI:

1. `weaver policy get --output json > current.json` (in the task scratch root).
2. Write `save.json` as `{"revision": <current revision>, "config": <edited config>, "blocks": <current blocks>}`.
3. `weaver policy validate --input <config only>` returns an empty issue list when valid.
4. `weaver policy save --input save.json`. A `REVISION_CONFLICT` means someone saved first: re-read and reapply, never overwrite blindly.

Example: send this owner's work only to free OpenCode and Qoder models by giving those workers weights above 0 and setting every other listed worker to 0 (`worker_weights: {"opencode_worker": 100, "qoder_worker": 90, "codex_worker": 0, ...}`), with the `opencode` and `qoder` engines enabled.

To pause an engine temporarily, add a manual block on the 引擎 page (or a `blocks` entry with `engine`, `reason`, optional `release_at`); remove it to resume.
