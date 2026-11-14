![Weaver 珊瑚版品牌标识](docs/assets/brand/weaver-lockup.png)

# Weaver

**让父 Agent，把任务编织给不同引擎的子 Agent。**

[品牌素材与使用规范](docs/assets/brand/README.md)

Weaver is a scheduling engine for development work. A parent agent splits a task into work packages with dependencies; Weaver keeps the package tree, launches each package on Codex, Claude Code, OpenCode or DeepSeek Harness the fastest way that engine allows, and wakes the parent when a result, a failure, a stall or a timer needs it. What to build, whether a result is good, and talking to the user stay with the parent.

It ships as one `weaver` executable (CLI and service in one static Go binary, about 12 MB) and one skill, `agents-weaver`, that tells a parent agent how to use it.

Weaver 2 is a rewrite. It covers the task lifecycle: decomposition, dependencies, launch, progress, wake-ups, verdicts. The browser UI, the Feishu bot and scheduled tasks of 0.x are not part of it; see [Upgrading from 0.x](#upgrading-from-0x).

## Install

Linux x64 and arm64, with `systemd --user`. No Go, Node or sudo needed:

```sh
curl -fsSL https://raw.githubusercontent.com/MarioJames/weaver/main/install.sh | bash
weaver service install     # systemd user unit weaver.service
weaver skill install       # ~/.agents/skills/agents-weaver, linked from ~/.claude/skills and ~/.codex/skills
```

`install.sh` takes `weaver-linux-x64` or `weaver-linux-arm64` from the GitHub Release, checks it against `SHA256SUMS` and places it at `~/.local/bin/weaver` (`--bin-dir` to change, `--version v2.0.0` to pin, `--uninstall` to remove only the executable). It refuses to replace a `weaver` that is not a Weaver executable unless you pass `--force`.

Run it again to update. The executable is replaced atomically and a running `weaver.service` is restarted onto it; running packages and resident engines live in their own systemd scopes and are not interrupted, and a `weaver wait` in progress reconnects by itself. An installed skill is updated with the executable.

## Upgrading from 0.x

`install.sh` over a 0.x `weaver` is the upgrade. Then:

```sh
weaver service install           # replaces the 0.x weaver.service
weaver account import-legacy     # optional: bring accounts and routing candidates over
```

- **State.** 0.x state in `~/.local/share/weaver` is neither read nor changed. Weaver 2 keeps its own in `~/.local/share/weaver/v2` and starts with no tasks. Imported subscription accounts keep using their credential directories inside the 0.x directory, so do not delete it.
- **Not carried over.** The browser UI (port 4737), the Feishu bot, scheduled tasks, owner profiles and the `tasks`/`owners`/`policy` commands are gone. The commands are different; agents must use the new `agents-weaver` skill, which `install.sh` updates when one is installed.
- **Engines.** Claude Code, Codex, OpenCode and DeepSeek Harness. Pi, Grok and Qoder are no longer supported; their candidates are skipped by the import.
- **Going back.** Reinstall with `install.sh --version v0.7.19` from the 0.x line and run its `weaver server install --force`; the 0.x state is still where it was.

## The loop

```sh
weaver mission create --title "Add rate limiting to the gateway"        # → {"id":"m_…"}
weaver plan submit --mission m_… <<'JSON'
{"packages":[
  {"key":"limiter","title":"Token bucket","instruction":"…self-contained instruction…"},
  {"key":"wiring","title":"Wire into middleware","instruction":"…","dependsOn":["limiter"]}
]}
JSON
weaver wait --mission m_…                       # blocks until something needs the parent
weaver package result m_…/limiter
weaver verdict --package m_…/limiter accept     # or: return --note "what was wrong"
```

A dependent package starts when its upstream is accepted, and receives the accepted results. `weaver help` lists every command; every command prints JSON. The full guidance for parent agents, including how to write a plan and when not to delegate, is the skill: [skills/agents-weaver/SKILL.md](skills/agents-weaver/SKILL.md), also printed by `weaver skill`.

## Design dialogue

For a decision that is hard to undo and has more than one defensible answer, let two engines design before anything is built:

```sh
weaver dialogue start --mission m_… --name cache-design --brief-file brief.md
weaver wait --mission m_…
weaver dialogue show --mission m_… --name cache-design
```

Codex and Claude each write a proposal from the brief without seeing the other's, then review each other's and state a final position. Rounds in between are accepted as they arrive; the parent is woken by the two final positions, or by a failure. The skill says when to open one and how to turn the transcript into a decided design.

## Accounts, candidates, engines

```sh
weaver account add --engine codex --kind subscription --id codex_sub --auth-dir ~/.codex
weaver account add --engine dsh --kind api --id dsh_openai --provider openai --api-key-env OPENAI_API_KEY
weaver worker set codex_medium --engine codex --model <model> --effort medium --weight 5 --accounts codex_sub
weaver worker list
weaver config list            # max_parallel (32), stall_seconds (300), resident (on), standby (on)
```

A candidate ("worker") is an engine, a model and an effort on one or more accounts. Packages are balanced over candidates by weight; a weight of 0 keeps a candidate out of automatic routing, to be used only when a package names it. A vendor limit pauses the account and moves the package to another ready candidate.

How a package is launched depends on the engine: OpenCode runs as a resident server per account (`weaver engine list|start|stop`), Claude Code is kept warm for packages about to start, Codex and DeepSeek Harness are started per attempt.

## Data and process boundary

- State is one SQLite database, `~/.local/share/weaver/v2/weaver.db` (`WEAVER_HOME` selects another directory), written only by the service. Schema changes are forward-only migrations applied at start. `weaver backup` writes a consistent copy to `backups/`.
- The CLI talks to the service over a Unix socket in that directory. There is no network listener.
- Every attempt runs in its own `systemd --user` scope (`weaver-<attempt>`), a resident OpenCode server in `weaver-oc-<account>`. Stopping or upgrading the service leaves them running; it re-adopts them at start.
- An API key is read from the environment variable named by `--api-key-env` when the account is added, and stored in the database. It reaches an engine through its environment, never on a command line, and no command prints it.

## Build from source

Go 1.27.4 or newer. SQLite is pure Go, so there is no cgo and no system toolchain.

```sh
make test       # go vet and race-tested unit tests
make dist       # dist/release/weaver-linux-{x64,arm64} and SHA256SUMS
make install    # build, then install ~/.local/bin/weaver and restart a running weaver.service
```

Releases are built by `.github/workflows/release.yml`: every push and pull request is tested and built, and a `v*` tag publishes the GitHub Release (a tag with a suffix, such as `v2.1.0-rc.1`, as a prerelease).

The 0.x TypeScript sources (`src/`, `tests/`, `package.json`) and its documents under `docs/` are still in the tree for reference. They are no longer built or released.

Apache-2.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE).
