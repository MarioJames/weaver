# ChatGPT Pro review through Convorel

Applies only when `weaver policy get` shows `chatgpt_review: true`. When it is `false`, skip this file: no remote review, local review and tests unchanged. An explicit user instruction (review now, or local only) overrides the setting either way.

## What is needed

- The `chatgpt-review` skill (installed by `convorel skills install --agent codex,claude-code`) and the `convorel` CLI on PATH. Load that skill and follow its rules for the conversation itself: direction confirmation, prompt contents, model, task reuse, waiting and naming.
- If either is missing or Convorel reports it cannot reach ChatGPT, say the review is pending/blocked, continue the work that does not depend on it, and do not present the gate as passed.

## Gates in Weaver work

Review decisions, not routine packages:

1. **Before freezing a judgment package or a risky plan** (architecture, data migration, auth, concurrency, irreversible effects): review the plan you are about to dispatch, with the package scope and acceptance criteria.
2. **Before accepting a worker result that itself crosses such a gate** (the package's own change is architecture, data migration, auth, concurrency or irreversible): after your own diff review and checks, ask for a result review of the actual change against the goal; then `reviews submit`. Only such a child may wait for the external result review; routine children are reviewed as soon as their result is verified and never wait for it.
3. **Before final delivery** of multi-package work with real architecture constraints: one result review comparing the delivered outcome with the goal.

Mechanical and routine packages, copy/style edits and small changes in an established pattern do not trigger a review.

## Handing Weaver evidence to the reviewer

Give the reviewer what lets it judge without reading the whole conversation: the goal and confirmed constraints, the workspace path and revision, which packages went to which worker (`tasks get` dispatch: worker, engine, model, effort), what you verified locally and its limits, and `path:start-end` references for the decisive code. Convorel binds the workspace read-only, so do not paste diffs or logs unless the skill's rules call for it. Do not send Weaver's socket token, provider credentials or `.weaver` state.

## After the review

You decide. Record accepted and rejected findings with reasons, fix blockers (or send a corrective package through Weaver), and follow the chatgpt-review rule that a fixed implementation finding is re-reviewed in the same conversation before the gate closes. A reviewer's approval does not replace your own checks or the user's decision.
