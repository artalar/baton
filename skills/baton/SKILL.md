---
name: baton
description: When and how to use Baton's advisor tools (baton_plan, baton_help, baton_review) and baton_recall while coding with pi.
---

# Baton: working with the advisor

Baton journals every tool call to `.pi/baton/events.jsonl` and masks outputs you have already seen.
A stub such as `[baton: output masked. evt#12 bash command=npm test → exit 1 …]` means the full
output is still available: call `baton_recall({"evt": 12})`.

The advisor is a stronger, expensive model called once per tool call, without your conversation.
Call it at these moments:

| Situation | Tool | What happens next |
|---|---|---|
| Starting a non-trivial task, or unsure how to approach it | `baton_plan` | You get a plan; your context resets to task + plan + last 2 turns |
| The same error twice, or a failure you cannot explain | `baton_help` (give `hypothesis`, `attempts`, `importantEvts`) | You get corrected facts and a plan; context resets |
| You believe a milestone or the whole task is done | `baton_review` | The verdict and fixes are appended; follow them |
| Before `git commit` | `baton_review` | Commits are blocked until a review returns `on_track` or `done` |

Rules:
- Do not call an advisor more than once per ~8 tool calls unless you are stuck.
- Be honest in `baton_help`: list what failed, not what you hoped would work.
- After a plan arrives, work step by step; each step has a `done when` criterion. Run the test command it names.
- Baton nudges (messages starting with `Baton:`) are deterministic safety triggers: context ≥60%, the same error 3×, 25 calls without a check. Follow them.
