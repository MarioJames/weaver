# Design dialogue

Some decisions are cheap to make and expensive to undo. For those, let two engines design independently and review each other before any package is written. `weaver dialogue start` runs Codex and Claude on one brief: both write a proposal without seeing the other's, then each reviews the other's and revises its own. You are woken once, when both final positions are in.

## When to open one

Open a dialogue when the user asks for one (对谈, 讨论一下方案, "have codex and claude debate this", a second opinion on a design), or when all three of these hold:

1. **The decision is hard to reverse or wide in reach.** A new subsystem or architecture, a data model, schema or migration strategy, a public interface or protocol, a refactor across modules, a technology choice, or a feature large enough that it will take about five or more packages.
2. **More than one answer is defensible.** You can name at least two approaches you could argue for, or you cannot yet name the right one. When the codebase already has a pattern for this kind of thing, follow the pattern; that is not a design question.
3. **You can brief it.** You can state the goal and the constraints, from the request and from reading the code. When the goal itself is unclear ("make it faster"), ask the user for what is missing and open the dialogue once you have it: two engines debating a vague goal return two confident guesses. Details the code or a sensible default can settle are not a reason to ask.

Do not open one for a bug fix, a change that follows an existing pattern, mechanical work (renames, dependency bumps, test backfill), UI polish, a design the user has already decided, or anything urgent. A dialogue costs four strong-model runs and several minutes. Spent on a routine change that is waste; skipped on an architectural one, it is how a mission gets rebuilt halfway through.

When it is a close call, do not open one: make the decision yourself and write the reason into your plan.

When you open one on your own judgement, tell the user in one line what you are putting to the dialogue and why, and carry on. Wait for permission only if the user asked to approve each step.

## Running it

```sh
weaver dialogue start --mission m_… --name cache-design <<'BRIEF'
Goal: …what must be true when this is done…
Constraints: …compatibility, performance, deadlines, what must not change…
Where to look: …paths and existing mechanisms that matter…
Settle these: 1) … 2) …
Out of scope: …
BRIEF
weaver wait --mission m_…                                   # woken by the final positions, or by a failure
weaver dialogue show --mission m_… --name cache-design      # state and the full text of every round
```

- **The brief is all both sides get besides the code**, and every round is a fresh agent that reads it again. Leave your own preferred design out of it: it anchors both sides and you get one design twice. A decision the user has already made goes in as a constraint.
- One exchange is enough for most questions. Without `--rounds` the count comes from the user's `dialogue_rounds` setting, which starts at one. Use `--rounds 2` when the stakes are high and you expect real disagreement; each extra round adds two runs.
- The sides are the debater seats the user configured (甲方, 乙方, and optional 丙方 when configured and enabled: engine, model, effort and account each), not routed candidates. If a configured seat is not ready the command says which one and why: tell the user rather than working around it. `--workers a,b` or `--workers a,b,c` names two or three candidates for one dialogue instead.
- `dialogue show` reports `running`, `concluded` or `needs_attention`. If a side failed, `weaver retry --package m_…/cache-design.r1.a` and the dialogue continues from there; do not start a new one.

## From dialogue to work

The dialogue advises. The decision is yours, and the user's where it is theirs.

1. **Read the whole transcript**, not only the closing parts. The reviews are where the facts get checked.
2. **Sort the points** into agreed and disputed. For every disputed point, and for every agreed point the design rests on, check the claim in the code yourself. Two models agreeing is not evidence: they can share a blind spot.
3. **Decide point by point.** Take the better-argued side on each; merge only if the parts actually fit together. A dispute that turns on product priority, cost or risk appetite rather than on a technical fact is the user's to settle, so carry it forward instead of settling it.
4. **Get one outside check**, when the `chatgpt-review` skill is installed: see [Final check by ChatGPT Pro](#final-check-by-chatgpt-pro) below.
5. **Write the final report.** If a `feature-delivery` skill is available, follow it: its design-document format, its acceptance checklist and its delivery rules. Without it, the report still has to contain: the chosen design; what was rejected, one line of reason each; where the two sides disagreed and how you resolved it; the decisions left to the user, each with your recommendation; and a numbered acceptance checklist in which every item is an action with an observable expected result.
6. **Stop or go.** If the report leaves decisions to the user, present it and wait for the answer. If it leaves none, say so and continue.
7. **Hand over.** Accept the two final-position packages (`weaver verdict --package m_…/cache-design.r2.a accept`, then `.b`) to close the dialogue. Then submit the implementation plan. Workers see neither the dialogue nor your report, so each package's instruction must carry the part of the decided design it implements and the checklist items it has to satisfy.
8. **Verify against the checklist** as results come back, as in the loop of `SKILL.md`.

## Final check by ChatGPT Pro

Two models that agree can share a blind spot, so the decided design gets one independent check through the `chatgpt-review` skill (Convorel) before the final report. Pro questions are scarce, about 100 a week, so the check has a fixed budget:

- **One question per dialogue.** Send the decided design once: what both sides agreed on, how you settled each dispute and why, and which claims you verified in the code. Ask for decision-blocking problems only, each with a counter-example, and for an explicit pass or fail. `chatgpt-review` says how to write and send it. Use the Convorel task ID `<mission ID>-<dialogue name>` and write it out literally in the command: that is how the question and the answer show up in the mission's timeline after the dialogue.
- **At most one correction round.** Check each reported problem against the code first. One you can settle yourself needs no dialogue: correct the design. For the rest, run one more exchange limited to them: `weaver dialogue start --name <name>-fix --rounds 1`, with a brief that gives the decided design as a constraint and lists only the confirmed problems. Then send one `followup` in the same Convorel task with the corrected design.
- **Then stop.** Whatever the second answer says, do not ask again and do not open another dialogue. What is still open goes into the final report as a decision for the user, with both positions and your recommendation.
- **This is the design's review.** Do not also run `chatgpt-review`'s own review of the same design before presenting it: that would spend the budget twice. Its check of the finished result against the design is a separate question and still applies, once.

Skip the check when the user asked for local work only or asked to save the budget, and when Convorel is unavailable: say in the report that the design was not checked, and carry on. Work that did not go through a dialogue gets no check from this rule; `chatgpt-review`'s own conditions decide there.
