# CLI handoff: weaver.v1

The external CLI Owner uses this `weaver` skill and the Weaver CLI. The app's default Owner mode is manual registration. No second scheduler or hidden Owner AI is started. For an exact command catalog, run `weaver --help --output json`; `weaver results ack --help --output json` shows required fields, mutation status and usage. Output is `json` (default), `jsonl`, or `text`; `--json` aliases json and cannot be combined with `--output`.

## Task scratch root

Choose the existing scratch parent in this order: the caller's explicitly provided task root, `ACCEPTANCE_TMPDIR`, then `TMPDIR`. Create one unique private task subdirectory inside that parent with `mkdtemp` and reuse it throughout the work. Only when none is provided may you create one task root under the system temporary directory. Never override a provided root with an absolute `/tmp/...` template; if the selected parent is missing or invalid, report that problem instead of silently creating scratch elsewhere.

Keep CLI JSON requests, baseline copies, logs and all Worker temporary files under this task root. Actual project deliverables stay in the authorized workspace. State the exact inherited task-root path in each WorkPackage scope/constraints; Workers must reuse it, placing any private Worker scratch beneath it. Make child-tool temporary files inherit this same task root instead of defaulting to a separate directory. Do not change `HOME`, provider authentication or global configuration to redirect scratch.

This root is for CLI JSON and task scratch. It does not set Weaver's `--data-dir` or Unix-socket path; do not repurpose it as application data or change socket-path limits.

Portable example using the existing Node runtime: `provided_task_root` below represents the caller's supplied path, when present; otherwise leave it unset. Record and reuse the printed directory.

```sh
node --input-type=module - "${provided_task_root:-}" <<'JS'
import { mkdtempSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const provided = process.argv[2] || process.env.ACCEPTANCE_TMPDIR || process.env.TMPDIR;
const parent = provided ? realpathSync(provided) : tmpdir();
if (!statSync(parent).isDirectory()) throw new Error('Scratch parent must be an existing directory');
console.log(mkdtempSync(join(parent, 'weaver-')));
JS
```

Record each temporary directory you create and its users/dependencies. Remove only your recorded task-owned directory after required artifacts/evidence are saved and every user/Worker has exited. A failed task or pending revalidation with an actual dependency retains its directory with an owner, reason and observable release condition. Never delete the entire provided parent or a directory you do not own.

## Task and frozen package

Save a UTF-8 JSON request under the task's scratch directory:

```json
{
  "title": "Implement the scoped change",
  "goal": "Edit the specified fixture and report verification evidence",
  "workspace": "/absolute/path/to/authorized/project",
  "ownerProfileId": "AVAILABLE_PROFILE_FROM_POLICY",
  "constraints": ["Do not delegate, commit or push", "Do not modify unrelated files"],
  "acceptanceCriteria": ["The specified file has the requested content and the existing check passes"]
}
```

```sh
weaver tasks create --input request.json --command-id create-work-001 --output json
```

Use the returned task ID and revision to freeze a package file containing:

```json
{
  "taskId": "RETURNED_TASK_UUID",
  "expectedRevision": 2,
  "scope": ["Read existing project conventions", "Write only the explicitly authorized fixture file"],
  "acceptanceCriteria": ["Independently check the requested file content"]
}
```

The revision above is illustrative; always read the actual current value. `packages create --input package.json --command-id package-work-001` returns the frozen package. Then create dispatch args with `taskId`, latest `expectedRevision`, `packageId`, and `class` (mechanical/routine/judgment), optional judgment `tag` or explicit `worker`. Inspect `policy preview` for the same routing input first.

```sh
weaver workers spawn --input dispatch.json --command-id dispatch-work-001 --output json
weaver tasks watch --task-id RETURNED_TASK_UUID --for 30 --output jsonl
weaver tasks get --task-id RETURNED_TASK_UUID --output json
weaver tasks results --task-id RETURNED_TASK_UUID --output json
```

The server requires an existing absolute workspace for real execution and freezes its realpath and directory identity. `tasks create` supplies the CLI caller cwd only if workspace is omitted; explicit empty/non-string values fail, and explicit relative paths resolve against that caller cwd. The server never assumes its own repository. The trusted launcher receives the full frozen goal/scope/criteria/constraints and Worker role contract. Total instructions over 16000 characters fail before admission rather than silently dropping scope.

The queued route keeps its worker/engine/kind/model/effort. Current capacity, pin, weights, quota and workspace are rechecked before start; policy changes do not silently reroute. `queueReason` is visible in task details and observability. Correct the blocking policy or cancel/recreate with an intentionally revised package. `provider: "mock-jsonl"` explicitly requests the fixture Worker; `ownerProvider: "mock"` explicitly requests the fixture Owner. Neither is a fallback for a real provider error.

## Pull, verify, acknowledge, accept

Read every relevant artifact with `artifacts read` args `{taskId,artifactId}`. Also inspect actual filesystem changes and run acceptance checks yourself. Get the result digest from `tasks results` and the latest task revision from `tasks get`.

- `results ack`: `{taskId,expectedRevision,manifestDigest}` records receipt only.
- Read the new revision before `reviews submit`: `{taskId,expectedRevision,manifestDigest,decision:"accepted"|"rejected",comment?}`. Only completed execution can be reviewed.
- Manual Owners pull results; `results deliver` has no external transport and reports `CAPABILITY_UNAVAILABLE`. This does not prevent pull/ack/review.

Reuse each mutation's stable command ID only for identical arguments. An uncertain response may mean work was admitted: inspect `operations get --command-id <id>` and current task/Owner state before acting. `COMMAND_INDETERMINATE` forbids automatic replay. `tasks wait/watch` have bounded deadlines (1–600 seconds) and reject `--input`; watch drains all retained event pages before returning a terminal snapshot. `CURSOR_EXPIRED` requires a fresh snapshot. Tasks retain at most 500 events. `tasks retry` creates a linked task after terminal execution; it does not overwrite the prior attempt.

## Manual continuation

`owners continuation get --task-id <id>` returns policy, due status, epoch, history and current pack. `owners continuation configure` uses `{taskId,expectedRevision,idleRotationMinutes:1..10080|null}`. For a quiescent task, `owners switch` uses `{taskId,expectedRevision,expectedEpoch?,profileId?,reason?:"manual"|"idle"}`. Running/cancelling/scheduled workers block rotation.

The default manual branch atomically changes the logical binding and stores a bounded context pack. Its replacement is an unverified external-cli registration (`ownsHost:false`), and its history has `acknowledgementId:null`. Read the pack yourself and arrange any real context switch in your CLI host. Weaver neither sends it to that host nor obtains host confirmation. Idle due does not automatically replace real Owner context. Explicit mock mode retains its mock-memory handshake; that acknowledgement is fixture evidence only.

No credential, executable argv or private host session locator belongs in task input. The task workspace is the authorized project, not Weaver's private state directory.
