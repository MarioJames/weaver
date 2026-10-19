# Request shapes

Exact flags and limits come from `weaver <command> --help --output json`; policy fields live in [config](config.md). Below are only the request JSON shapes and rules the help does not spell out.

## Task scratch root

Use, in order: the task root the caller provided, else `ACCEPTANCE_TMPDIR`, else `TMPDIR`. Create one unique private subdirectory inside it (`mkdtemp`) and reuse it for CLI JSON requests, logs and all scratch — yours and your workers'; state the exact path in every package scope. Never override a provided root with your own `/tmp/...` path; if the parent is missing or invalid, report that instead of going elsewhere. Deliverables stay in the authorized workspace. Record each directory you create and its users; remove only your own task-owned directory after artifacts and evidence are safe. A failed task or a pending dependency keeps its directory with an owner, reason and observable release condition. Never delete the provided parent, directories you do not own, or anything that would repurpose this root as Weaver's `--data-dir` or socket path.

## Request JSON examples

`weaver owners attach --input owner.json --command-id owner-20261019-4f2a1b` — once per agent session, before any task:

```json
{
  "profileId": "codex_owner",
  "name": "Codex · weaver · 14:20",
  "session": "<host session id, or the workspace path when no session id is exposed>"
}
```

`name` is `<Host> · <workspace dir name> · <HH:MM session start>`; `session` is `$CODEX_THREAD_ID`, else `$HERDR_PANE_ID`, else the absolute workspace path. The reply `data.id` is this session's owner id, and `data` also echoes `name`/`profileId`. Attach is metadata only (`verified: false`) — it never contacts your host. Re-issue with the same `--command-id` and identical input to get the original receipt back; if that comes back `COMMAND_INDETERMINATE`, read `weaver owners list` and take the entry with the same name/session instead of registering a second owner.

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

The revision above is illustrative; read the actual current value from the earlier response before each mutation.

`weaver workers spawn --input dispatch.json --command-id spawn-001`:

```json
{ "taskId": "RETURNED_TASK_UUID", "packageId": "RETURNED_PACKAGE_UUID" }
```

Omit `"worker"` to use the owner's weights; name one only for a justified choice or a continuation.

## Native execution report

A dispatch marked `execution: "native"` launched nothing. Run the package with your built-in subagent tool at the frozen model/effort and scope, then report:

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

- `weaver results ack --task-id <id> --input ack.json`: `{ "expectedRevision": <current>, "manifestDigest": <digest from tasks results> }` — receipt only; ack itself bumps the task revision.
- `weaver reviews submit --task-id <id> --input review.json`: re-read the revision, then `{ "expectedRevision": <fresh>, "manifestDigest": <same digest>, "decision": "accepted" | "rejected", "comment": "what you verified yourself" }`. A revision copied from before the ack is already stale.

## Continuation pointer

`weaver owners continuation get --task-id <id>` returns the manual context pack and handoff prompt (`acknowledgementId` is `null`, not a host confirmation). `weaver owners continuation configure --task-id <id> --input cfg.json` sets or clears idle rotation (`{"expectedRevision":2,"idleRotationMinutes":90}`, `null` disables, 1–10080); `weaver owners switch` hands ownership over. With `launch:true`, it also starts the new owner in Herdr and delivers the continuation prompt; `weaver owners launch` uses the existing context pack to retry that host launch without switching again. Both return the final launch result; a failed launch does not roll back the switch. See each command's help for current fields.

No credential or executable argv belongs in any request. A host session reference belongs only in the owner attach registration above, where it is stored as an unverified label — never in task input, scope or artifacts. The task workspace is the authorized project, not Weaver's private state directory.
