# Changelog

## 0.7.0
- New mode **switch** (`-e src/pi/switch.ts` or `BATON_MODE=switch`): in-session model switching in one pi session, the lead (Opus) leads. Helper (GLM) does adaptive reading (read-only tool gate; non-read tool / long text / cap / 4.5 min → back to lead), up to 2 delegated follow-up read rounds (`delegate_reads` or "lead issued only reads"), verify/debug loops (escalates after 6 same-failure red cycles, 12 total, or a new file), and the final review; lead does an optional short final check.
- Lead context: helper turns are reduced to tool calls + results (no text/thinking, blocked calls dropped), helper instructions hidden, empty replies dropped; lead messages untouched (signed reasoning kept). Compaction frozen only at helper→lead handoffs (dedup reads, clip huge reads, stub old verify outputs).
- Lead reasoning capped at 1024 tokens outside planning turns; lead max_tokens capped (16k); empty 200 responses retried (3×).
- Journal `.pi/baton/switch.jsonl` (every switch, blocked call, usage per message) + `switch-summary.json` (cost per model).

## 0.6.0 — 2026-10-13

Repositioned as an **efficient review agent**: the core value is context preparation for an expensive, tool-less reviewer.

- **pi-independent core** (`src/core`): `pack/sections.ts` (ordering + budget), `pack/index.ts` (`buildReviewPack(input) → {messages, sections, tokens, stableTokens}`), `pack/collect.ts` (`collectPackInput`: git diff/stat, changed files, last test, skills selection, AGENTS.md, repo map, help context from a journal; injectable `exec`), `advisor.ts` (`runAdvisor`, transport-agnostic validation + one retry), `openrouter.ts` (standalone client, `OPENROUTER_API_KEY` only). Journal/repo/skills/schema/util moved under `src/core`. A test asserts nothing under `src/core`/`src/cli` imports pi.
- **Pack order**: role → skills → AGENTS.md (stable system prefix, cacheable) → pinned plan → task + prompts → artefacts → executor claims (unverified) → instructions + schema. Role text: "below is a junior's work… no tools, everything you need is below". New `claims` input; a review note is rendered as an unverified claim.
- **Prompt caching**: the pack is two messages; the system prefix carries Anthropic `cache_control` (OpenRouter client) / is passed as pi's `systemPrompt` with `cacheRetention` (`advisor.cache`, default `short`; pi-ai adds `cache_control` for `openrouter/anthropic/*`). Previously caching was disabled (`cacheRetention: "none"`).
- **CLI**: `baton-pack` (print the pack, no LLM call) and `baton-review` (call the advisor via OpenRouter).
- **pi extension is a thin layer** (`src/pi`): tools call the core; pinned plan, review gating, finalize mode, triggers unchanged.
- **Compaction optional, default OFF** (`compact.enabled: false`): the advisor reply is appended normally, nothing is masked or cut, pi's auto-compaction is untouched. `true` restores the 0.4/0.5 handoff compaction.
- **Loop detector** defaults to forcing `baton_help` (`loop.action: "help"`, or `"nudge"`); looping calls are cut only when compaction is on. Removed `loop.cutContext`, `loop.forceHandoff`.
- **Removed the Jev judge** (`judge.ts`, `judge-jev.ts`, config `judge`): it only re-ranked medium-importance timeline events of `baton_help` packs, was off by default, needed a separate classifier provider and added an LLM call to a path that should be deterministic; the timeline now uses the importance ≥2 rule (`timelineEvents`).
- **Removed** legacy per-request masking mode (`mask.mode: "continuous"`, dedup/stale reads in the extension; `maskMessages` stays as a library function).
- **Config regrouped**: `advisor {model, maxTokens, cache}`, `pack {budgetTokens, excludePaths, skills, pinPlan, helpLastCalls}`, `review`, `triggers`, `loop`, `compact`, `journalDir`. Removed `executor`, `advisorMaxTokens`, `packBudgetTokens`, `judge`, `mask`, `help`, `reset`, `replaceAutoCompact` (moved into the groups above). `baton.example.json` equals the defaults (tested).

## 0.5.0 — 2026-10-13

- **Review gating** (`src/gate.ts`, config `review`). Experiment C4 showed review ping-pong: Opus returned `course_correct` with 3-4 tiny steps, GLM did one in 7-13 s and called `baton_review` again (8 handoffs at ~$0.2, ~3 useful). A self-invoked `baton_review` is now refused unless all review-verified steps of the previous review are closed (`baton_step` done/deferred) or enough change accumulated: `review.minCalls` = 15 executor tool calls or `review.minDiffLines` = 80 changed lines since the review (numstat between `git stash create` snapshots). Forced handoffs (loop, context pressure, pi auto-compaction) bypass it. `baton_help` stays available, rate-limited to `review.helpMinCalls` = 5 calls after any advisor reply.
- **`verify: "self" | "review"`** on advisor steps (default `review`). The review prompt asks to prefer `self` for small/mechanical fixes and to batch all fixes into one reply instead of drip-feeding. `self` steps neither require nor permit a review; a review whose steps are all `self` permits `git commit` once they are closed.
- **Finalize mode** after verdict `done` (`review.finalizeAfterDone`): the first edit/write or non-verification bash is blocked once with a "commit now" message; tsc/test/build, inspection and git add/commit pass; `baton_review` is refused until a successful commit or a new user prompt; the commit gate (`reviewBeforeCommit`) does not block in finalize mode even after edits.
- C4 replay test: reviews #5, #6, #8 would be refused (5 of 8 handoffs remain).
- System prompt, SKILL.md, tool descriptions, `/baton` status updated.

## 0.4.0 — 2026-10-13

- **Compaction only at handoffs** (`mask.mode: "handoff"`, the new default). The executor's context is no longer masked on every request: between advisor calls nothing is rewritten (no masking, no duplicate/stale read removal, no loop cuts). In experiment C v3 the per-turn masking made GLM re-read `pieces.ts` 8 times and call `baton_recall` (evt 59–76).
- A handoff is any `baton_review`/`baton_help`/`baton_plan` call or an automatic one. After the advisor answers, Baton takes a snapshot (journaled, restored after restart) and resets the context: system + task + pinned plan + deferred items + advisor reply + the last N tool calls verbatim (help: `help.lastCalls` = 8; review/plan: new `reset.keepCalls` = 2); older outputs become `evt#` stubs (`baton_recall`). The snapshot is applied unchanged until the next handoff. `baton_review` now resets the context too.
- **Loop detector** keeps detection, deferred items and blocked edits, but no longer cuts on the fly: it forces a handoff (automatic `baton_help` at the end of the turn, the loop as reason; `loop.forceHandoff`), and that handoff's compaction cuts the looping calls.
- **Context pressure** (`triggers.contextRatio`) forces a handoff (automatic `baton_review`) instead of a nudge; pi's auto-compaction (`session_before_compact`) also runs a `baton_review` handoff, with the deterministic summary as fallback.
- Legacy per-request masking is kept as `mask.mode: "continuous"`.

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
