# Provenance and migration

Source: https://github.com/MarioJames/skill-foundry/tree/61989b1/skills/agents-cooperation

Baseline inspected: `61989b1`. Source license: Apache-2.0; a copy is included as LICENSE. The upstream repository remains untouched.

The skill is now a short, transport-agnostic set of cooperation principles and truthful current interaction guidance. Its model/effort/provider validation, class/tag routing, availability and quota time helpers have been adapted into Weaver app code, along with the upstream schema validator and config schema/defaults. See [the script-by-script inventory](../../../docs/script-migration.md).

The app does not execute upstream scripts. It does not import old hidden-session runs, take over PIDs, read global agent config, inspect provider home files or pass bypass arguments. Config vocabulary does not prove installed provider compatibility. All real adapters remain disabled.

Current supported interaction remains manual JSON import and mock execution. A future logical owner/worker API should hide transport implementation from the skill; current owner metadata is compatibility data, not an active bridge.

Deferred work includes real execution, authenticated logical-agent transport, owner creation/registration, automatic quota detection, real concurrency enforcement, review records, workspaces, process containment and transactional lifecycle storage. The app-owned policy store is a new atomic JSON document, not an automatic migration of the old SQLite database.
