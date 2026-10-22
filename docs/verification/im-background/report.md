# im-background work package report (1e88028a)

Date: 2026-10-22 (UTC). Scope: host-only writer; service/UI/skills untouched. No delegation, commit, or push. No real models / Feishu.

## Source changes (this package)

- Deleted `src/main/im/parent-herdr.ts` (`git rm -f`). Verified zero remaining
  `parent-herdr` / `createHerdrParentAgent` references in `src`/`tests`/`scripts`
  (only historical `docs/verification/feishu-im` evidence mentions remain, out of scope).
- `src/main/im/parent-host.ts` (only hunks):
  - Entry comment corrected: hidden identity turn now documented as real
    (`No model turn is created` was stale).
  - `process.on('SIGHUP', () => {})` added so the promised SIGHUP-detached
    background lifetime is actually implemented. SIGTERM / socket-close /
    explicit-close paths unchanged.
- `parent-background.ts`, `parent-host-resources.ts`, `parent-identity.ts`:
  no changes needed; prior correct implementation kept (background-only factory,
  `launchMode: 'background'`, exact-unit cleanup, bounded identity shutdown).

## Test fixes (`tests/integration/im-background-host.test.ts` only)

1. `startup-abort`: scenario `default`+500ms abort raced a pre-ready host.
   Now `identity-hang` + gate on real fixture `spawnPid` marker (deterministically
   pending) before abort; unexpected success captures the session and closes it
   in `finally`, so node can never hang on a leaked session.
2. `late-launch`: dropped the exit-code/`exec-condition` stderr contract (a
   skipped ExecCondition may ACK 0). Now proves the real lifecycle: `MainPID=0`,
   `LoadState=not-found` (polled), no surviving cgroup, revoked socket stays
   gone, fixture marker shows no `spawnPid`, journal empty. Fixture on PATH
   added so "no engine spawned" is observable.
3. `legacy`: `mkdtemp` prefix `h-legacy-` -> `h-` (100-byte socket bound);
   `await once(sleeper, 'close')` before manufacturing the dead owner;
   outer `ownedTabs`/`ownedEpochDirs` + `session` tracking with precise
   identity-based teardown in `finally` (exact tab closes / epoch-dir removals,
   never a sweep). Live-foreign refusal also closes an unexpected session.
4. Same unexpected-success close-guard added to `startup-failure`,
   `close-failure` second-launch, and `identity-wrong` branches.

## Private build (isolation constraint)

- Built with the project's esbuild settings (same as `scripts/build-main.mjs`)
  to task-root only: `<taskroot>/build/cli-main.mjs`
  (`<taskroot>` = `/tmp/weaver-bot-lifecycle-thgzzwqn`).
- sha256 `17896955cd73e52804c2a9f2fc6d9b984b8c0317e6a3564c799dd10bd9556018`
  (7643855 bytes). Bundle verified to contain `createBackgroundParentAgent`,
  the SIGHUP ignore, and the hidden-identity marker, and to NOT contain
  `createHerdrParentAgent`.
- Public `dist/cli/main.mjs` never written (mtime still 2026-10-21 21:09,
  `git status` clean for `dist/`). Host command used as `[node, bundle]`.

## Leftover reclamation (prior package)

Verified dead owners (`/proc` absent, recorded `ownerStart` unmatchable, boot
`241222b7-…` equals current) then `cleanupHostRecord` per record:

- `weaver-im-host-31a719fb-…` (background, old main 173102) -> cleaned
- `weaver-im-host-71064734-…` (background, old main 188993) -> cleaned
- `weaver-im-host-d33b6817-…` (legacy lane `wGE:t1`) -> tab now `tab_not_found`
- `weaver-im-host-bb100eb5-…` (legacy lane `wGF:t1`) -> tab now `tab_not_found`

After: all four units `LoadState=not-found`/`MainPID=0`, cgroups absent,
registries empty, the four `real/h-*` temp dirs removed (`real/` now holds only
pre-existing `seed-policy.ts`/`service.mts`, not mine). The still-running
`weaver-im-host-ffe2e78a-…` unit belongs to `~/.local/share/weaver/im-host`
(unknown ownership) and was deliberately left untouched.

## Verification (all with the private bundle, current source)

- `npx tsc --noEmit`: clean, exit 0.
- `tests/integration/im-background-host.test.ts`: **12 pass, 0 fail,
  0 skipped** (`WEAVER_IM_BACKGROUND_HOST_TEST=1`,
  root `<taskroot>/real`, bundle `<taskroot>/build/cli-main.mjs`).
  Full stdout: `docs/verification/im-background/run1-stdout.log`;
  stderr was empty; desensitized proof (21 lines):
  `docs/verification/im-background/proof-run1.jsonl`.
  Raw logs also at `<taskroot>/build/run1-{stdout,stderr}.log`,
  `proof-run1.jsonl`.
- `tests/main/im-parent-host|resources|scope|launch-cancel`: **37/37 pass**.
- `tests/main/im-service.test.ts` (peer-owned, read-only run): **52/52 pass**.
- Post-run: test process exited (no leaked node), `real/` empty of journals,
  no `weaver-im-host-*` units from this run remain.

## Unresolved risks / notes for owner

- Foreign unit `weaver-im-host-ffe2e78a-…` (release `20261021-console`,
  `~/.local/share/weaver`) still active; ownership unknown, not touched.
- Herdr workspaces created by `allocateHerdrLane` probes (`wGE`/`wGF`-style)
  may linger after their tabs were exactly closed; deleting workspaces was
  out of scope (no sweep of unknown resources).
- No codex-fixture gate change was needed (`identity-hang` + marker already
  sufficient); fixture file untouched.
- No `service.ts` write performed (peer package owns it); it already imports
  the background factory and its 52 tests pass unmodified.
