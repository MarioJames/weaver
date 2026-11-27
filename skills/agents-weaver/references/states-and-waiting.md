# Package states and waiting

Read this when a package fails, stalls or is cancelled, when a wait returns something you do not recognise, or when you resume a mission.

## Package states

`pending` → `launching` → `running` → `awaiting_verdict` → `accepted`

- `pending` carries a `waiting` text that says why: an upstream is not accepted yet, or no candidate is ready.
- `return` on `awaiting_verdict` starts the next attempt of the same package. The note is required: it is the only thing that tells the next attempt what was wrong.
- `failed` can be retried with `weaver retry --package …`. A failure caused by a vendor limit pauses that account and moves the package to another ready candidate by itself.
- `cancelled` is final. `weaver cancel --package …` or `--mission …` returns once the processes are gone. On a resident engine (opencode) a cancel can only interrupt the session: the reply then has `residual: true` and the workspace to check for leftover commands.
- The mission itself is `settled` (shown as 待收尾) once every package has ended, and becomes `done` only when you run `weaver mission close`. Close it after your own remaining work and the delivery to the user are finished, not as soon as the last package is accepted; while you wait on the user, leave it open.

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
