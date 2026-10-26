# Request shapes

Exact flags and limits come from `weaver <command> --help --output json`; policy fields live in [config](config.md). Below are only the request JSON shapes and rules the help does not spell out.

After the first owner attach returns `credentialPath`, prefix every command in this reference with the same instance and credential: `weaver --data-dir <instance> --owner-file <credentialPath> ...`. The examples below omit that prefix for brevity. Do not print, copy or interpolate the token; the credential file is user-only (0600) and is local trusted-user identity, not tenant isolation.

## Task scratch root

Use, in order: the task root the caller provided, else `ACCEPTANCE_TMPDIR`, else `TMPDIR`. Create one unique private subdirectory inside it (`mkdtemp`) and reuse it for CLI JSON requests, logs and all scratch — yours and your workers'; state the exact path in every package scope. Never override a provided root with your own `/tmp/...` path; if the parent is missing or invalid, report that instead of going elsewhere. Deliverables stay in the authorized workspace. Ownership is not shared: the parent/task owner owns that one task root; each worker creates or reuses only its named child subdirectory inside it. Record each directory you create and its users; remove only your own task-owned directory after artifacts and evidence are safe. A worker keeps its evidence in its child until the owner has reviewed and collected it, and never removes the task root, a sibling's files, caches, databases, profiles or logs. Only the owner removes the whole task root, after every dependent worker has finished. A failed task or a pending dependency keeps its directory with an owner, reason and observable release condition. Never delete the provided parent, directories you do not own, or anything that would repurpose this root as Weaver's `--data-dir` or socket path.

## Request JSON examples

`weaver owners attach --input owner.json --command-id owner-20261019-4f2a1b` — once per agent session, before any task. A Herdr-started root or continuation instead claims its existing row with `ownerId`; it must not create a second owner:

```json
{
  "profileId": "codex_owner",
  "name": "Codex · weaver · 14:20",
  "session": "<host session id, or the workspace path when no session id is exposed>"
}
```

For the claim, add `"ownerId": "<the task/root owner row>"`, keep `name` as the actual agent name and `session` as the current host session, and read `profileId` first with `weaver owners get --input owner-get.json` or `weaver policy get`. Do not guess the profile. `name` is `<Host> · <workspace dir name> · <HH:MM session start>`; `session` is `$CODEX_THREAD_ID`, else `$HERDR_PANE_ID`, else the absolute workspace path. The reply `data.id` is this session's owner id, `data.credentialPath` is the only credential location, and `data` also echoes `name`/`profileId`; it never contains the token. From the next command on use `weaver --data-dir <instance> --owner-file <credentialPath>`. Attach is metadata only (`verified: false`) — it never contacts your host. Re-issue with the same `--command-id` and identical input to get the original receipt back; if that comes back `COMMAND_INDETERMINATE`, read `weaver owners list` and take the entry with the same name/session (or claim the known `ownerId`) instead of registering a second owner.

`weaver owners describe --input describe.json --command-id describe-001` — once the session's main task is clear, set its board title (and again whenever the main task changes):

```json
{
  "ownerId": "<id returned by the preflight attach>",
  "title": "Short specific topic of the current main task"
}
```

`title` is 1–120 characters after trimming; an empty or over-long title is rejected as `INVALID_REQUEST`. The reply `data` is the updated instance including `runningTaskCount`. Only `title` changes: name, session, host evidence and state stay as registered. A repeat attach with `title` updates it too; without `title` the stored value is kept. A parent Agent root started from the Weaver page needs no title — the board shows its root task title.

`weaver tasks create --input request.json --command-id create-001`:

```json
{
  "title": "Implement the scoped change",
  "goal": "Edit the specified fixture and report verification evidence",
  "workspace": "/absolute/path/to/authorized/project",
  "ownerId": "<id returned by the preflight attach>",
  "constraints": ["Do not delegate, commit or push", "Write only files in scope", "Keep temporary files under the task scratch root"],
  "acceptanceCriteria": ["The specified file has the requested content and the existing check passes"]
}
```

Use `ownerId`, the owner instance from the attach above. `ownerProfileId` is only a profile: passing it makes Weaver register a fresh throwaway owner (`Task owner`) for that one task, so your session's tasks spread over unrelated owner rows and stop sharing its concurrency and reporting.

`weaver packages create --task-id <id> --input package.json --command-id package-001`:

```json
{
  "taskId": "RETURNED_TASK_UUID",
  "expectedRevision": 2,
  "scope": ["Write only the explicitly authorized files", "Reuse the task scratch root from the constraints"],
  "acceptanceCriteria": ["Independently checkable statements about the result"]
}
```

The package is the **only** source of the sub-Agent's goal and acceptance criteria: the worker instruction and the native `run_subagent` prompt carry just the package instruction, scope, constraints and the package's `acceptanceCriteria`, never the root task's goal or criteria. Put everything the branch needs into the package: context, interface contracts, the areas it must not touch and complete, concrete, checkable criteria; never "see the task". Omitting `acceptanceCriteria` defaults to the child task's own list; an explicit list wins and does not overwrite the task.

The revision above is illustrative; read the actual current value from the earlier response before each mutation.

`weaver workers spawn --input dispatch.json --command-id spawn-001`:

```json
{ "taskId": "RETURNED_TASK_UUID", "packageId": "RETURNED_PACKAGE_UUID" }
```

Omit `"worker"` to use the owner's weights; name one only for a justified choice or a continuation.

## Native execution report

A dispatch marked `execution: "native"` launched nothing. Weaver permits this only when worker/owner/root channel match and the parent root run policyRevision equals the current policy revision; a shared engine alone is insufficient. Follow the returned execution mode rather than choosing native yourself. Run the package with your built-in subagent tool at the frozen model/effort and scope, then report:

```sh
weaver workers complete --task-id <id> --input report.json --command-id complete-001
```

```json
{
  "outcome": "completed",
  "summary": "what was done and verified, <= 8000 chars",
  "artifacts": [{ "name": "result.md", "mediaType": "application/json", "content": "<= 32000 chars" }]
}
```

Only a running native task accepts one report; cancelling ends the task without one.

## Ack and review

When a child's result arrives, read it, verify the real files and necessary tests against that package's own acceptance criteria, then ack and submit the review in the same turn (accepted or rejected). Do not postpone a decided review to wait for other children, the root's integrated check, browser acceptance or an external review. Cross-child integration problems and later findings go into a new corrective child; the root's overall acceptance and `tasks complete` stay last.

- `weaver results ack --task-id <id> --input ack.json`: `{ "expectedRevision": <current>, "manifestDigest": <digest from tasks results> }` — receipt only; ack itself bumps the task revision.
- `weaver reviews submit --task-id <id> --input review.json`: re-read the revision, then `{ "expectedRevision": <fresh>, "manifestDigest": <same digest>, "decision": "accepted" | "rejected", "comment": "what you verified yourself" }`. A revision copied from before the ack is already stale.

## Shell-safe input and result review

Keep JSON requests and literal text files under the task scratch root. Prefer a JSON file or a quoted heredoc to inline JSON when text contains newlines, quotes or shell characters:

```sh
weaver tasks describe --task-id "$task_id" --command-id "$describe_id" --input - <<'JSON'
{
  "expectedRevision": 2,
  "title": "验证中文与引号",
  "acceptanceCriteria": ["保留字面量 \"引号\" 与换行\n第二行"]
}
JSON
```

The revision above is illustrative; replace it with the actual value. `--input -` still requires valid JSON; the quoted heredoc prevents shell expansion. A UTF-8 JSON file passed with `--input request.json` is equivalent. Never forward a captured JSON response using `echo`: zsh can turn its `\n` escapes into real newlines. Use `printf '%s\n' "$response"` if forwarding is necessary.

For receipt and review, no JSON parsing or construction is needed:

```sh
digest=$(weaver tasks results --task-id "$task_id" --field data.manifestDigest) || exit
revision=$(weaver tasks get --task-id "$task_id" --field data.revision) || exit
weaver results ack --task-id "$task_id" --expected-revision "$revision" \
  --manifest-digest "$digest" --command-id "$ack_id" || exit

# Read changed files and independently verify the result before accepting it.
# review.txt contains literal UTF-8 text; quotes, backslashes and newlines need no JSON escaping.
revision=$(weaver tasks get --task-id "$task_id" --field data.revision) || exit
weaver reviews submit --task-id "$task_id" --expected-revision "$revision" \
  --manifest-digest "$digest" --decision accepted --comment-file "$scratch/review.txt" \
  --command-id "$review_id" || exit
```

Use stable IDs supplied by the owner. Preserve the digest of the result actually reviewed; do not silently substitute a newer digest. The server still enforces revision and digest checks. After an uncertain mutation reply, inspect `operations get` using the same command ID before resubmitting. `--comment` accepts literal argv text for short comments; `--comment-file` reads at most 4000 characters and is mutually exclusive with `--comment`. Convenience flags reject different values in `--input` rather than overwriting them.

`--field` accepts a dot-separated path from the full response envelope and prints one scalar (literal strings, JSON numbers/booleans/null) plus a newline. Missing fields, objects and arrays fail; failed server responses remain error envelopes with nonzero exit status. Always check the exit status. Do not combine it with `--output`/`--json`, mutations, wait or watch. For full structured responses, retain the default JSON output and redirect it directly to a file.

When a task listing is too large, ask the server for a smaller view instead of filtering JSON locally: `weaver tasks list --view brief --fields id,status,title,progress --output json`. `--view brief` keeps only `id`, `status`, `reviewState`, `progress`, `workspace`, `title`, `ownerId`, `parentTaskId`, `updatedAt` and a short `dispatch` summary; it drops `instruction`, `summary`, `acceptanceCriteria`, `constraints`, `run`, `events`, `artifacts` and native `next`. `--fields` keeps only the named top-level fields (comma-separated for the CLI, `string[]` in `--input` JSON) and may also name any field the full view has. Both flags work on `tasks get` and `tasks list`, may instead be placed in the `--input` JSON, and a flag that disagrees with the JSON is rejected. Unknown fields, empty lists and invalid views fail with `INVALID_ARGUMENT`; omitting both keeps the full response unchanged.

Filter by status on the server before pagination with `weaver tasks list --status running --view brief` (or `--status running,queued`; comma-separated values are trimmed and deduplicated). `status` accepts `queued`, `running`, `cancelling`, `completed`, `failed`, `cancelled`, intersects with `ownerId`/`parentTaskId`, and computes `nextOffset` over the filtered set; `--input` JSON accepts one string or a non-empty array, and a disagreeing flag is rejected. Unknown values, empty arrays and empty strings fail with `INVALID_ARGUMENT` and the allowed list. Query in two stages: first find the task and project with `tasks list --status running --view brief` (or `--fields`), then read one task only when its detail is needed with `tasks get --task-id <id>` (optionally `--view`/`--fields`), `tasks events --task-id <id>`, or `tasks health --task-id <id>`.

## Continuation pointer

`weaver owners continuation get --task-id <id>` returns the manual context pack and handoff prompt (`acknowledgementId` is `null`, not a host confirmation). `weaver owners continuation configure --task-id <id> --input cfg.json` sets or clears idle rotation (`{"expectedRevision":2,"idleRotationMinutes":90}`, `null` disables, 1–10080); `weaver owners switch` hands ownership over. With `launch:true`, it also starts the new owner in Herdr and delivers the continuation prompt; `weaver owners launch` uses the existing context pack to retry that host launch without switching again. Both return the final launch result; a failed launch does not roll back the switch. See each command's help for current fields.

No credential belongs in a request, prompt, scope, artifact or executable argv: the owner token stays in the private `--owner-file` file and only its path goes on the command line. A host session reference belongs only in the owner attach registration above, where it is stored as an unverified label — never in task input, scope or artifacts. The task workspace is the authorized project, not Weaver's private state directory. `--owner-file` is local trusted-user identity, not a tenant boundary; never pass it to an untrusted agent or a different instance.
