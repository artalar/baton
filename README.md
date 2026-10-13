# Baton

A [pi](https://github.com/earendil-works/pi) extension that lets a cheap executor model (default GLM-5.3-Flash) do the work, and calls a strong advisor model (default Claude Opus 5.5) only at the moments that matter: to plan, to get unstuck, and to review before a commit. It keeps the executor's context small with a deterministic tool journal and output masking.

## What it does

- **Journal.** Every tool call is written to `.pi/baton/events.jsonl`. Each record has `evt#`, `ts`, `tool`, an args digest (write/edit bodies are hashed, not stored), the exit code, the head and tail of the output, an error signature, files read and written, a test summary, and a `rawRef` to the full output in `.pi/baton/raw/<evt>.txt`.
- **Compaction only at handoffs** (`mask.mode: "handoff"`, default). Between advisor calls the executor's context is **never rewritten**: no masking, no duplicate/stale read removal, no loop cuts. Compaction happens only at a handoff, i.e. a `baton_review`/`baton_help`/`baton_plan` call or an automatic one (loop detector, context pressure, pi auto-compaction). After the advisor answers, Baton freezes a snapshot: the context becomes system prompt + task + pinned plan (with deferred items) + advisor reply + the last N tool calls verbatim (`help.lastCalls` = 8 for help, `reset.keepCalls` = 2 for review/plan); older tool outputs become stubs such as `[baton: output masked. evt#12 bash command=npm test → exit 1, 830 tok …]`, recallable with `baton_recall({evt})`. That view is applied unchanged to every request until the next handoff, so everything since the handoff stays verbatim and the request prefix is stable. Reads of skills and reference docs (`mask.neverMaskPaths`) are never stubbed. The session file itself stays complete. The legacy per-request masking of v0.3 (dedup, stale reads, answered outputs) is still available as `mask.mode: "continuous"`.
- **Advisor tools.** Each one builds a pack (≈40k token budget, estimated conservatively as chars/2.4 with non-ASCII counted twice, calibrated on real Opus usage), calls the advisor once with prompt caching disabled, and validates the JSON reply against a schema (`verdict`, `facts_corrected`, `plan[]` steps with `done_when`, `do_not_retry`, `test_cmd`). An invalid reply gets one retry.
  - The advisor has **no tools**. Every pack says so explicitly ("everything you need is below; do not ask for files") and presents the executor's work in the third person, as a junior's work to check, never as the advisor's own turns. Executor statements are labelled unverified.
  - Packs are ordered for long context: role, project skills, `AGENTS.md`, pinned plan, task and prompts, artefacts, executor claims, and the instructions plus reply schema last.
  - **Project skills in packs.** Baton discovers `SKILL.md` files in `.agents/skills`, `.pi/skills`, `.claude/skills` and `skills`, scores them against the task, prompts, diff and changed files (sibling skills of a strongly matching family are included too, review skills are preferred for reviews), and includes up to 4 of them within 35% of the pack budget. The largest one is clipped first.
  - **Pack diff excludes.** The journal dir, `.pi/baton`, `node_modules`, `dist` and lockfiles are always excluded from the diff and changed files, regardless of `.gitignore` (`pack.excludePaths`).
  - `baton_review`: the executor's narrative is excluded. The pack holds the task, the user prompts verbatim, the relevant skills, the pinned plan (the review checks done criteria, invariants and skill rules against it), `git diff`, the changed files and the last test run. A review that returns steps becomes the new pinned plan.
  - `baton_help`: the pack holds the last N (default 8) tool calls verbatim, earlier calls with the same error signature, the executor's hypothesis and attempts, and the evt#s it marked as important.
  - `baton_plan`: the pack holds the task, the relevant skills, `AGENTS.md`, a repo map and the exploration findings from the journal. The reply adds `invariants` (architecture decisions), `rules` (skill rules to follow) and `checkpoints` (steps after which to call review).
  - **Pinned plan.** The latest plan, with progress marks, is appended to the first user message of every request (a stable position, so it never gets masked and the executor's prompt cache only breaks when the plan changes). `baton_step({id, status, evidence})` marks steps; finishing a checkpoint step asks for `baton_review`.
  - After every advisor call (handoff mode; in continuous mode only help and plan), the executor's context is **reset** to task + plan + deferred items + the last turns and kept calls. Baton does this by appending a `compaction` entry at `turn_end` and applying the handoff snapshot in the `context` event.
- **Safety triggers.** These are deterministic `Baton:` nudge messages:
  - context ≥60% → a forced handoff: automatic `baton_review` + reset (handoff mode; a nudge in continuous mode);
  - the same error signature 3×;
  - exploration done without a plan (8 read-only calls) → call `baton_plan`; the first `write`/`edit` without a plan is blocked **once** (retrying passes);
  - the first milestone after edits (tests green or a build/typecheck exits 0) → early `baton_review`;
  - 20 tool calls without `baton_step` while a plan is pinned (drift);
  - a reminder after 12 tool calls without an advisor call;
  - a cooldown between nudges.
- **Loop detector.** This is deterministic and needs no LLM. It fires after 6 hops on the same failing test or build error, where one hop is edit/write → run (test/build) → the same failure again. It also fires on the same file re-read 8× without a write within 30 calls. It does not cut the context on the fly: it forces a handoff (an automatic `baton_help` at the end of the turn, with the loop as the reason, `loop.forceHandoff`), and that handoff's compaction cuts the looping calls and replaces them with one `⚠ Loop detected … DEFERRED` note. The advisor reply arrives as a `baton-handoff` message. The item is added to the deferred list, which is pinned and journaled. Edits of its failing test file are soft-blocked. `baton_review` sees the deferred items and rules on them (`deferred_rulings`: unblock with guidance, drop, or keep). The user can unblock or drop them with `/baton unblock D1 [guidance]` or `/baton drop D1`. The executor can defer a step itself with `baton_step` status `deferred`. Calibration on the C v2 transcript (509 calls): the first fire is at call 324 with 8 hops, 21 calls after the first failure of the lock-delay test. Before that loop the hop count never exceeded 1.
  - `git commit` is **blocked** until `baton_review` returns `on_track` or `done`. New edits revoke the pass.
- **Auto-compaction.** pi's threshold and overflow compaction is routed through a handoff: Baton runs an automatic `baton_review` and compacts to task + prompts + the new plan (falling back to a deterministic summary with the last plan and timeline if the advisor fails). In continuous mode the deterministic, no-LLM summary is used. `replaceAutoCompact: false` leaves pi's own compaction.
- **Optional judge** (off by default). A Jev-format classifier (`typesafe/jev-latest` via pi's `modelRegistry.classify`) decides include/drop only for medium-importance events in the help pack. Heuristics are the fallback.
- **Skill** `baton` and prompt `/baton-plan` tell the executor when to call which tool. The same guidance goes into the system prompt as tool guidelines. Commands: `/baton` (status), `/baton reset`, `/baton unblock <D1|all> [guidance]` and `/baton drop <D1|all>`.

## Install

Requires pi ≥ 1.2 (`@earendil-works/pi-coding-agent`) and Node ≥ 22.

```bash
pi install git:github.com/artalar/baton          # from GitHub
pi install git:github.com/artalar/baton@v0.1.0   # pinned
pi -e ./src/index.ts                             # one-off local run from a clone
pi install ./baton                               # local path install
```

## Config

Baton reads `~/.pi/agent/baton.json` (honours `PI_CODING_AGENT_DIR`) and then the project `.pi/baton.json`; later files override earlier ones. Both files hold **model ids only**. Keys come from pi itself (`/login`, `~/.pi/agent/auth.json`, or env such as `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `TYPESAFE_API_KEY`). Keys that look like secrets (`apiKey`, `token`, …) are ignored. Do not use a `.env` file.

See [`baton.example.json`](baton.example.json) for all options with their defaults. The most important ones:

| Option | Default |
|---|---|
| `executor` | `openrouter/z-ai/glm-5.3-flash` (informational; choose the model with `/model`) |
| `advisor` | `openrouter/anthropic/claude-opus-5.5` |
| `packBudgetTokens` | `40000` |
| `triggers.contextRatio` / `sameErrorCount` / `remindEvery` / `minGapCalls` | `0.6` / `3` / `12` / `5` |
| `triggers.milestoneReview` / `autoPlanAfterReads` / `planBeforeWrite` / `driftCalls` | `true` / `8` / `true` / `20` |
| `pack.skills` | `{ enabled: true, budgetRatio: 0.35, maxSkills: 4 }` |
| `pack.excludePaths` | journal dir, `node_modules`, `dist`, lockfiles |
| `pack.pinPlan` | `true` |
| `mask.neverMaskPaths` | skills and reference docs |
| `triggers.reviewBeforeCommit` | `true` |
| `loop.maxHops` / `hopGapCalls` | `6` / `30` |
| `loop.windowCalls` / `readRepeatThreshold` | `30` / `8` |
| `loop.enabled` / `cutContext` / `forceHandoff` / `blockDeferredEdits` | `true` / `true` / `true` / `true` |
| `mask.mode` | `"handoff"` (or legacy `"continuous"`) |
| `reset.keepTurns` / `reset.keepCalls` / `help.lastCalls` | `2` / `2` / `8` |
| `judge.enabled` | `false` |
| `replaceAutoCompact` | `true` |

Model refs are `provider/id`; the id may contain slashes. The OpenRouter ids above were checked against the OpenRouter model list on 2026-10-13. Run `/model` in pi to see what your keys can reach.

Add `.pi/baton/` to your project's `.gitignore`: the journal stores raw tool output, which may contain secrets.

## How it works (pi APIs)

| Feature | pi API |
|---|---|
| Journal | `tool_result` (exit code from bash `structuredContent.exit_code`), `before_agent_start` for user prompts |
| Handoff snapshot (stubs, loop cuts), pinned plan; legacy continuous masking | `context` (request-only) |
| Tools | `pi.registerTool` (TypeBox params), `promptGuidelines` |
| Advisor call | `ctx.modelRegistry.find` + `complete(model, ctx, { cacheRetention: "none" })` |
| Judge | `ctx.modelRegistry.findOfType("classifier", …)` + `classify()` |
| Reset | `turn_end` → `{ entries: [{ type: "compaction", summary, firstKeptEntryId }] }`; `/baton reset` uses `ctx.compact()` + `session_before_compact` |
| Commit gate | `tool_call` → `{ block: true, reason }` |
| Nudges | `turn_end` → `custom_message` entry |
| Context ratio | `ctx.getContextUsage()` |

Development: `npm install && npm run check` runs `tsc --noEmit` against the real pi types and the vitest unit tests (journal, masking, pack, triggers, schema, judge, reset).

## Status / limitations

0.4.0 is an early version. The handoff-only compaction is covered by unit tests; it has not yet been run end-to-end with GLM and Opus. The type-checked code, the unit tests and the extension loading in pi's real loader are verified. End-to-end sessions with GLM-5.3-Flash and Opus 5.5 via OpenRouter were run on a Tetris-on-Reatom task.

- Token counts are conservative estimates (chars/2.4, non-ASCII ×2; calibrated on real Opus input tokens, where chars/3.2 still under-counted by 23–32%); pi has no public tokenizer. Real advisor usage is recorded in the journal (`advisor` events: `usage`, `attempts`, `packTokens`).
- A handoff rewrites the prefix of the request once (prompt cache breaks once per advisor call); between handoffs the prefix is stable except for the pinned plan's progress marks. An automatic handoff costs one advisor call.
- Test-summary parsing is regex based (vitest/jest/pytest/cargo/go). Other runners only get exit codes.
- The reset relies on `turn_end` compaction entries. If pi rejects the entry, use `/baton reset`.
- The Jev judge only covers the help-pack timeline. Its question format follows pi's `ClassifierContext` types, but it has not been run against the TypeSafe API.
- `executor` in the config is informational. Baton never switches models.

## License

MIT
