---
name: agents-cooperation
description: Guide owner-led cooperation through Weaver: classify and scope work, delegate bounded packages, review evidence, and report accepted results. Keep execution and transport policy in the app.
---

# Agents Cooperation

## Roles and dispatch principles

- The user-facing owner understands the request, freezes the plan, assigns bounded packages, reviews evidence, resolves disagreements, and reports results. Project edits belong to workers; the owner integrates accepted work under user authorization.
- A collaborating owner owns its assigned package, its worker delegation and review, and reports to the requesting owner. Owners collaborate through logical Weaver identities; no terminal or provider knowledge belongs in this skill.
- A worker executes one scoped package, returns evidence and artifacts, and never recursively delegates, commits, or communicates with the user.
- Before delegation, state the objective, exact read/write scope, dependencies, constraints, expected artifacts and acceptance checks. Avoid overlapping writers; inspect partial output before replacing or retrying a worker.
- Classify packages as mechanical (fixed rules, explicit files, checkable result, no design choice), routine (frozen plan, bounded implementation), or judgment (design, cross-module decisions or higher risk).
- Weaver owns configuration, model/effort selection, provider capabilities, quotas, concurrency and execution records. Do not embed routing algorithms, launch commands, bypass flags or lifecycle scripts in the skill. Never treat a configured model/provider as verified or available execution.
- Use supported logical operations for owner creation/registration, worker dispatch, status and results when the app actually exposes them. The app chooses transport; do not infer a command, endpoint or tool from a design document.
- Keep user authorization, required reviews and acceptance separate from execution. A successful worker exit is not owner acceptance. Review actual changes and rerun checks; record failures, blockers and partial artifacts honestly.
- Honor quota/capacity blocks; move an unfinished package as a whole after reviewing partial output. Do not evade a block with another identity or invent capabilities.
- Report who owns each package, its class, requested versus verified model, current status, evidence and unresolved risk. Stop superseded work and verify cleanup before granting its write scope elsewhere.

## Current app interaction boundary

This version implements the shared `weaver.v1` command interface and CLI, with deterministic mock owner/worker adapters only. It performs no real project work or AI calls. There is no MCP server or HTTP API. First query capabilities; never treat a policy profile or mock readiness as a real connected agent.

Use [the logical handoff contract](references/handoff.md). One task-creation command can create and bind its mock owner from a profile; dispatch freezes the bounded package and applies app admission policy. Queueing, result delivery, acknowledgment, acceptance, retries, manual context switching and idle continuation are app operations. Do not invent transport commands or inspect host-specific session locations.

Use stable command IDs for mutations and inspect the existing receipt after an uncertain response. Respect current revisions, expired event cursors, policy blocks and unavailable capabilities. Review artifact evidence and the exact result digest before accepting. Successful execution, receipt acknowledgment and acceptance are different states.

The current local client authority is a trusted-user demo, not isolated external-owner authentication. Do not distribute its credential or connect untrusted agent processes. Real integrations require their own approved adapters and scoped authorization.

Install this directory in the skill location supported by the user's agent host. Installation does not connect that host to Weaver or grant permissions. See [provenance](references/provenance.md) for what was migrated and what remains deferred.
