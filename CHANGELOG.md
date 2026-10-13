# Changelog

## 0.3.0 — 2026-10-13

- **Loop detector** (`src/loop.ts`, config `loop`). Deterministic. It counts **hops** per failure signature: one hop is an edit/write (including bash `cat >`, `sed -i`, `rm` and similar), then a run (a test or build command), then the **same** failing test or the same set of build errors again. It fires after `loop.maxHops` (6) hops; a chain breaks when two failures of the signature are more than `hopGapCalls` (30) calls apart, and a changed failure starts a new chain. A second rule fires on the same source file re-read `readRepeatThreshold` (8) times without a write within `windowCalls` (30). Grep-filtered test runs that fail without naming the test are attributed to the test the command greps for. Reference docs and `node_modules` reads do not count. Calibrated on experiment C v2: it fires at call 324 with 8 confirmed hops (the 6th hop happened between the failures at calls 315 and 324), 21 calls after the first failure at call 303. In the 302 calls before that loop, the largest hop count on any signature was 1, so there are no false positives.
- When it fires, the looping calls and results are **cut from the request** (the session and journal stay complete) and replaced by one note: `⚠ Loop detected (D1): N calls on test "…", error …. … DEFERRED until the reviewer or user confirms …`. The item goes to a **deferred list**, which is shown in the pinned block and recorded in the journal (restored after restart).
- Deferred items go into the `baton_review` pack (`DEFERRED ITEMS` section with the last failing call). The reply schema adds `deferred_rulings: [{id, ruling: unblock|drop|keep, guidance}]`. The user can rule too: `/baton unblock <D1|all> [guidance]` and `/baton drop <D1|all>`.
- Edits of the failing test file of an open deferred item are soft-blocked (`loop.blockDeferredEdits`).
- Stuck rule in the system-prompt guidelines and the skill: after ~3 failed fix attempts on one bug or test, stop, mark it deferred (`baton_step` status `deferred`) and move on to the next step.

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
