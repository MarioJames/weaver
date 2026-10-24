# Provenance and migration

Source: https://github.com/MarioJames/skill-foundry/tree/61989b1/skills/agents-cooperation

Baseline inspected: `61989b1`. Source license: Apache-2.0; a copy is included as LICENSE. The upstream repository remains untouched.

The repository skill is now independently named `agents-weaver` (earlier `weaver`); the upstream `agents-cooperation` name above is provenance, not an instruction to replace or invoke the installed global skill. It is a short, transport-agnostic set of cooperation principles and truthful current interaction guidance. Its model/effort/provider validation, class/tag routing, availability and quota time helpers have been adapted into Weaver app code, along with the upstream schema validator and config schema/defaults. See [the script-by-script inventory](../../../docs/script-migration.md).

The app does not execute upstream scripts. It does not import old hidden-session runs, take over unknown PIDs, take account identity from an unrelated global agent config. Explicit native-channel import reads the selected provider configuration and copies authentication to private roots; fixed launchers use their documented permission modes. Config vocabulary does not prove a model call succeeded.

Current interaction is the Weaver service — `weaver server start` for the background instance shared on this machine, `weaver web` for the foreground dev/debug mode — and its loopback HTTP and the authenticated Unix CLI share one handler. Real worker launches go through the loaded Claude Code, OpenCode, Pi, Grok, Codex, Qoder or DeepSeek Harness adapter and the task's absolute workspace. Missing launcher, unsupported engine, and missing directory fail without a mock substitute. `mock-jsonl` is explicit. Engine discovery is PATH plus `--version`. The app does not read `~/.config/weaver-desktop` or old global agent config. An owner record is logical registration, not a live model this process spawned.

Policy and channel metadata/history use SQLite with ordered schema migrations; private channel secrets use separate tables on the same connection. Scoped external-agent authorization, Windows pipe ACLs and MCP are outside this account/channel change. See [current contract](../../../docs/account-channels-design.md) for native inheritance, migration and verification limits.
