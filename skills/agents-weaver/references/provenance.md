# Provenance and migration

Source: https://github.com/MarioJames/skill-foundry/tree/61989b1/skills/agents-cooperation

Baseline inspected: `61989b1`. Source license: Apache-2.0; a copy is included as LICENSE. The upstream repository remains untouched.

The repository skill is now independently named `agents-weaver` (earlier `weaver`); the upstream `agents-cooperation` name above is provenance, not an instruction to replace or invoke the installed global skill. It is a short, transport-agnostic set of cooperation principles and truthful current interaction guidance. Its model/effort/provider validation, class/tag routing, availability and quota time helpers have been adapted into Weaver app code, along with the upstream schema validator and config schema/defaults. See [the script-by-script inventory](../../../docs/script-migration.md).

The app does not execute upstream scripts. It does not import old hidden-session runs, take over unknown PIDs, read global agent config, inspect provider home files or pass bypass arguments. Config vocabulary does not prove a model call succeeded.

Current interaction is `weaver web`: loopback HTTP and the authenticated Unix CLI share one handler. Real worker launches go through the loaded OpenCode, Pi, Grok, or Codex adapter and the task's absolute workspace. Missing launcher, unsupported engine, and missing directory fail without a mock substitute. `mock-jsonl` is explicit. Engine discovery is PATH plus `--version`. The app does not read `~/.config/weaver-desktop` or old global agent config. An owner record is logical registration, not a live model this process spawned.

Deferred work includes scoped external-agent authorization, SQLite/outbox, Windows pipe ACLs, and MCP. The policy store is an atomic JSON document, not a migration of an old SQLite database.
