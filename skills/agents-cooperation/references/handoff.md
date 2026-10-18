# Logical handoff: weaver.v1

Open Weaver first. The CLI is a thin client; it does not start a daemon or execute work when the app is absent. Query `weaver capabilities --json` before using a capability.

Create a UTF-8 JSON argument file:

```json
{
  "title": "Review component",
  "goal": "Inspect the specified component and return evidence. Mock demonstration only.",
  "workspace": "/path/to/project",
  "ownerProfileId": "PROFILE_FROM_APP_SETTINGS",
  "constraints": ["Do not modify files"],
  "acceptanceCriteria": ["Each finding includes a location and rationale"]
}
```

```sh
weaver tasks create --input request.json --command-id create-review-001 --json --no-input
weaver workers spawn --task-id RETURNED_TASK_UUID --command-id dispatch-review-001 --json --no-input
weaver tasks get --task-id RETURNED_TASK_UUID --json
weaver tasks results --task-id RETURNED_TASK_UUID --json
```

Mutations require a stable command ID. Reusing the same ID with the same arguments returns the original receipt; different arguments conflict. An interrupted intent is explicitly indeterminate and must be reconciled, not blindly resubmitted with another ID. `operations.get` accepts `{commandId}` to inspect its receipt.

Inputs can also be a full envelope `{apiVersion:"weaver.v1",commandId,command,args}`. Dotted commands such as `owners.continuation.configure` can be supplied in a full `--input` envelope. `tasks.events` accepts `{taskId,after?,limit?}` (limit 1–100). Expired event IDs require a new snapshot. `artifacts.read` accepts `{taskId,artifactId}`. `results.ack` and `reviews.submit` require `{taskId,manifestDigest,expectedRevision}`; review additionally uses `decision:"accepted"|"rejected"` and optional comment. Only successful execution can be accepted/rejected.

One task currently holds one frozen package and one execution attempt. `tasks.retry` creates a linked new task, preserving the prior result. `owners.switch` uses `{taskId,expectedRevision,expectedEpoch?,profileId?}`; active or scheduled workers block transfer. Idle continuation uses the app's user-configured interval (default 60 minutes), checked on next dispatch; it is unrelated to provider cache lifetime.

All current execution and owner communication use mock adapters. The workspace is context metadata; this demo does not read or edit that project. No credential, provider executable or host session locator belongs in the request. Legacy manual imports remain a compatibility path only.
