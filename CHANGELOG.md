# Changelog

## 0.2.0 — 2026-10-13

- Advisor packs include relevant project skills (`SKILL.md` from `.agents/skills`, `.pi/skills`, `.claude/skills`, `skills`), selected by relevance within a sub-budget (`pack.skills`).
- Third-person framing ("a junior executor, a different model, produced this; its claims are unverified"), an explicit no-tools notice, and long-context ordering (rules first, artefacts, executor claims, instructions and schema last).
- Pack diff and changed files always exclude the journal dir, `.pi/baton`, `node_modules`, `dist` and lockfiles, regardless of `.gitignore` (`pack.excludePaths`).
- Reads of skills and reference docs are never masked (`mask.neverMaskPaths`), including simple `cat`/`sed`/`head` reads in bash.
- Conservative token estimate: chars/2.4 with non-ASCII counted twice, calibrated on real Opus usage; pack fitting runs several passes.
- Planning: auto-plan nudge after 8 exploration calls, a one-time soft gate on the first write without a plan, plan reply fields `invariants`, `rules`, `checkpoints`, a pinned plan in every request, `baton_step` progress tracking, drift nudge after 20 calls without a step.
- Review checks against the pinned plan; a review that returns steps becomes the new pinned plan.
- Earlier review: a nudge at the first milestone (tests green or build/typecheck exit 0 after edits); default reminder lowered from 25 to 12 calls.
- Advisor replies cut off by the output limit are salvaged (complete steps kept, tail fields defaulted); the retry after a cut-off asks for a much shorter reply; packs ask for concise English replies; `advisorMaxTokens` default 4096 → 8192 (reasoning shares the limit).
- Advisor usage, attempts and pack size are recorded in the journal (`advisor` events) and tool details.

## 0.1.0 — 2026-10-13

Initial version.

- `events.jsonl` tool journal in `.pi/baton/` with raw outputs in `.pi/baton/raw/<evt>.txt`.
- Request-time masking of all answered tool outputs (`context` event), duplicate and stale read removal.
- `baton_recall`, `baton_review`, `baton_help`, `baton_plan` tools; JSON advisor reply validated with TypeBox.
- Context reset after help/plan via a `compaction` entry at `turn_end` (task + plan + last 2 turns).
- Safety triggers: context ≥60%, same error 3×, git commit gate, reminder after 25 calls, cooldown.
- Deterministic replacement for pi's automatic compaction.
- Optional Jev judge (off by default) behind a provider interface.
- Skill `baton`, prompt `/baton-plan`, command `/baton [status|reset]`.
