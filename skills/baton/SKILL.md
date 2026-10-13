---
name: baton
description: When and how to use Baton's advisor tools (baton_plan, baton_help, baton_review), baton_step and baton_recall while coding with pi.
---

# Baton: working with the reviewer

Baton gives you a stronger, expensive **reviewer** (the advisor). It never sees your conversation and has no
tools: Baton prepares a pack for it from the artefacts — task, user prompts, pinned plan, git diff, changed
files, last test run, relevant project skills and AGENTS.md. Everything you *say* about your work is shown to it
as an **unverified claim**; only the diff and the test output count. So: run the tests before a review.

Every tool call is journaled to `.pi/baton/events.jsonl`. By default your context is never rewritten; the
advisor's reply is simply appended. (Only when the project enables `compact.enabled` is the context reset at
each advisor call and older outputs become stubs like `[baton: output masked. evt#12 …]` — then call
`baton_recall({"evt": 12})` for the full text.)

| Situation | Tool | What happens next |
|---|---|---|
| After a short exploration (repo, package.json, project skills), before writing code | `baton_plan` | A plan with invariants, skill rules and checkpoints; it is pinned into every request |
| You finished a plan step | `baton_step` (`id`, `status`, `evidence`) | Progress is tracked; at a checkpoint you are told to call `baton_review` |
| The same error twice, or a failure you cannot explain | `baton_help` (`hypothesis`, `attempts`, `importantEvts`) | Corrected facts and a plan; your last 8 calls went to the advisor verbatim |
| First milestone (core works, tests/build green), a plan checkpoint, or the task is done | `baton_review` | Verdict and fixes; follow them |
| Before `git commit` | `baton_review` | Commits are blocked until a review returns `on_track` or `done` (or all its fixes were `verify: self` and are done) |
| Review returned verdict `done` | `git add` + `git commit` | Finalize mode: no edits, no more reviews until you commit |

Rules:
- **Review gating.** `baton_review` is refused until every review-verified step of the last review is closed (`baton_step` done/deferred), unless ~15 tool calls or ~80 changed lines accumulated since. Do ALL the fixes, mark each, then call review once.
- **verify: self.** Steps marked `(verify: self — no re-review)` are small fixes: do them, run the check, mark them done. If only such steps were left, commit directly.
- **Finalize after done.** After verdict `done`, only commit (final tsc/test/build are fine).
- `baton_help` is refused within 5 tool calls of an advisor reply: apply the reply first.
- Be honest in `baton_help`: list what failed, not what you hoped would work.
- The first write without a plan is blocked once: call `baton_plan`, or retry the write if the task is trivial.
- **Stuck rule.** If one bug or test still fails after ~3 fix attempts, stop. Mark the step `deferred` with `baton_step` (or call `baton_help` once) and go on. A deferred item is resolved only after the reviewer or the user confirms.
- **Loop detector.** `⚠ Loop detected (D1) … DEFERRED` means Baton has called `baton_help` for you. Do not continue that item and do not edit its test file (those edits are blocked); follow the reply / go to the next plan step until it is unblocked.
- Baton nudges (messages starting with `Baton:`) are deterministic triggers: exploration done without a plan, first milestone, the same error 3×, 12 calls without a check, 20 calls without `baton_step`. Follow them.
