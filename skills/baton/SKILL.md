---
name: baton
description: When and how to use Baton's advisor tools (baton_plan, baton_help, baton_review), baton_step and baton_recall while coding with pi.
---

# Baton: working with the advisor

Baton journals every tool call to `.pi/baton/events.jsonl`. Your context is not rewritten while you work;
only when an advisor call happens (a handoff) is it reset, and older tool outputs become stubs.
A stub such as `[baton: output masked. evt#12 bash command=npm test → exit 1 …]` means the full
output is still available: call `baton_recall({"evt": 12})`.

The advisor is a stronger, expensive model called once per tool call, without your conversation.
Call it at these moments:

| Situation | Tool | What happens next |
|---|---|---|
| After a short exploration (repo, package.json, project skills), before writing code | `baton_plan` | You get a plan with invariants and skill rules; it is pinned into every request; your context resets to task + plan + your last 2 calls |
| You finished a plan step | `baton_step` (`id`, `status`, `evidence`) | Progress is tracked; at a checkpoint you are told to call `baton_review` |
| The same error twice, or a failure you cannot explain | `baton_help` (give `hypothesis`, `attempts`, `importantEvts`) | You get corrected facts and a plan; context resets to task + plan + your last 8 calls |
| First milestone (core works, tests/build green), a plan checkpoint, or the task is done | `baton_review` | The verdict and fixes are appended; follow them |
| Before `git commit` | `baton_review` | Commits are blocked until a review returns `on_track` or `done` (or all its fixes were `verify: self` and are done) |
| Review returned verdict `done` | `git add` + `git commit` | Finalize mode: no edits, no more reviews until you commit |

Rules:
- **Review gating.** `baton_review` is refused until every review-verified step of the last review is closed (`baton_step` done/deferred), unless ~15 tool calls or ~80 changed lines accumulated since. Do ALL the fixes, mark each, then call review once. Never one fix per review.
- **verify: self.** Steps marked `(verify: self — no re-review)` are small fixes: do them, run the check, mark them done. They neither require nor allow a review; if only such steps were left, commit directly.
- **Finalize after done.** After verdict `done`, only commit (final tsc/test/build are fine). The first edit is blocked once; optional reviewer nits wait. `baton_review` is refused until the commit (or a new user message).
- `baton_help` is refused within 5 tool calls of an advisor reply: apply the reply first.
- Do not call an advisor more than once per ~8 tool calls unless you are stuck.
- Be honest in `baton_help`: list what failed, not what you hoped would work.
- After a plan arrives, work step by step; each step has a `done when` criterion. Run the test command it names.
- Skill files and reference docs (SKILL.md, AGENTS.md, README.md) are never masked; read them before planning.
- The first write without a plan is blocked once: call `baton_plan`, or retry the write if the task is trivial.
- **Stuck rule.** If one bug or test still fails after ~3 fix attempts, stop. Mark the step `deferred` with `baton_step` (or call `baton_help` once) and go on to the next plan step. A deferred item is resolved only after the reviewer (`baton_review`) or the user confirms.
- **Loop detector.** If you see `⚠ Loop detected (D1) … DEFERRED`, Baton has forced an advisor handoff and removed the looping calls from your context. Do not continue that item and do not edit its test file (those edits are blocked); proceed with the next plan step. The item stays listed under "Deferred items" in the pinned plan until `baton_review` or the user unblocks it, and an unblock comes with guidance: follow it.
- Baton nudges (messages starting with `Baton:`) are deterministic triggers: exploration done without a plan, first milestone, the same error 3×, 12 calls without a check, 20 calls without `baton_step`. Follow them. At context ≥60% Baton calls the reviewer itself and resets your context; continue with the plan it pins.
