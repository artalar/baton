# Baton

A [pi](https://github.com/earendil-works/pi) extension that lets a cheap executor model (default GLM-5.3-Flash) do the work, and calls a strong advisor model (default Claude Opus 5.5) only at the moments that matter: to plan, to get unstuck, and to review before a commit. It keeps the executor's context small with a deterministic tool journal and output masking.

## What it does

- **Journal.** Every tool call is written to `.pi/baton/events.jsonl`. Each record has `evt#`, `ts`, `tool`, an args digest (write/edit bodies are hashed, not stored), the exit code, the head and tail of the output, an error signature, files read and written, a test summary, and a `rawRef` to the full output in `.pi/baton/raw/<evt>.txt`.
- **Masking.** In every request to the model (pi's `context` event; the session file itself stays complete), every tool output the model has already answered is replaced by a stub such as `[baton: output masked. evt#12 bash command=npm test → exit 1, 830 tok …]`. Earlier reads of a file that was read again are dropped as duplicates. Reads of a file that was edited afterwards are dropped as stale. `baton_recall({evt})` returns the full output. Reads of skills and reference docs (`SKILL.md`, `.agents/skills/**`, `.pi/skills/**`, `AGENTS.md`, `README.md`, `REFERENCE.md`, `docs/**/*.md`; configurable via `mask.neverMaskPaths`) are never masked, deduplicated or marked stale.
- **Advisor tools.** Each one builds a pack (≈40k token budget, estimated conservatively as chars/2.4 with non-ASCII counted twice, calibrated on real Opus usage), calls the advisor once with prompt caching disabled, and validates the JSON reply against a schema (`verdict`, `facts_corrected`, `plan[]` steps with `done_when`, `do_not_retry`, `test_cmd`). An invalid reply gets one retry.
  - The advisor has **no tools**. Every pack says so explicitly ("everything you need is below; do not ask for files") and presents the executor's work in the third person, as a junior's work to check, never as the advisor's own turns. Executor statements are labelled unverified.
  - Packs are ordered for long context: role, project skills, `AGENTS.md`, pinned plan, task and prompts, artefacts, executor claims, and the instructions plus reply schema last.
  - **Project skills in packs.** Baton discovers `SKILL.md` files in `.agents/skills`, `.pi/skills`, `.claude/skills` and `skills`, scores them against the task, prompts, diff and changed files (sibling skills of a strongly matching family are included too, review skills are preferred for reviews), and includes up to 4 of them within 35% of the pack budget. The largest one is clipped first.
  - **Pack diff excludes.** The journal dir, `.pi/baton`, `node_modules`, `dist` and lockfiles are always excluded from the diff and changed files, regardless of `.gitignore` (`pack.excludePaths`).
  - `baton_review`: the executor's narrative is excluded. The pack holds the task, the user prompts verbatim, the relevant skills, the pinned plan (the review checks done criteria, invariants and skill rules against it), `git diff`, the changed files and the last test run. A review that returns steps becomes the new pinned plan.
  - `baton_help`: the pack holds the last N (default 8) tool calls verbatim, earlier calls with the same error signature, the executor's hypothesis and attempts, and the evt#s it marked as important.
  - `baton_plan`: the pack holds the task, the relevant skills, `AGENTS.md`, a repo map and the exploration findings from the journal. The reply adds `invariants` (architecture decisions), `rules` (skill rules to follow) and `checkpoints` (steps after which to call review).
  - **Pinned plan.** The latest plan, with progress marks, is appended to the first user message of every request (a stable position, so it never gets masked and the executor's prompt cache only breaks when the plan changes). `baton_step({id, status, evidence})` marks steps; finishing a checkpoint step asks for `baton_review`.
  - After help or plan, the executor's context is **reset** to task + plan + the last 2 turns. Baton does this by appending a `compaction` entry at `turn_end`.
- **Safety triggers.** These are deterministic `Baton:` nudge messages:
  - context ≥60%;
  - the same error signature 3×;
  - exploration done without a plan (8 read-only calls) → call `baton_plan`; the first `write`/`edit` without a plan is blocked **once** (retrying passes);
  - the first milestone after edits (tests green or a build/typecheck exits 0) → early `baton_review`;
  - 20 tool calls without `baton_step` while a plan is pinned (drift);
  - a reminder after 12 tool calls without an advisor call;
  - a cooldown between nudges.
- **Loop detector.** This is deterministic and needs no LLM. It fires after 6 hops on the same failing test or build error, where one hop is edit/write → run (test/build) → the same failure again. It also fires on the same file re-read 8× without a write within 30 calls. The looping calls are then cut out of the request and replaced by one `⚠ Loop detected … DEFERRED` note. The item is added to the deferred list, which is pinned and journaled. Edits of its failing test file are soft-blocked. `baton_review` sees the deferred items and rules on them (`deferred_rulings`: unblock with guidance, drop, or keep). The user can unblock or drop them with `/baton unblock D1 [guidance]` or `/baton drop D1`. The executor can defer a step itself with `baton_step` status `deferred`. Calibration on the C v2 transcript (509 calls): the first fire is at call 324 with 8 hops, 21 calls after the first failure of the lock-delay test. Before that loop the hop count never exceeded 1.
  - `git commit` is **blocked** until `baton_review` returns `on_track` or `done`. New edits revoke the pass.
- **Auto-compaction.** pi's threshold and overflow compaction is replaced by a deterministic, no-LLM Baton summary (task, prompts, last plan, timeline). This is configurable.
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
| `loop.enabled` / `cutContext` / `blockDeferredEdits` | `true` / `true` / `true` |
| `judge.enabled` | `false` |
| `replaceAutoCompact` | `true` |

Model refs are `provider/id`; the id may contain slashes. The OpenRouter ids above were checked against the OpenRouter model list on 2026-10-13. Run `/model` in pi to see what your keys can reach.

Add `.pi/baton/` to your project's `.gitignore`: the journal stores raw tool output, which may contain secrets.

## How it works (pi APIs)

| Feature | pi API |
|---|---|
| Journal | `tool_result` (exit code from bash `structuredContent.exit_code`), `before_agent_start` for user prompts |
| Masking, dedup, stale reads | `context` (request-only) |
| Tools | `pi.registerTool` (TypeBox params), `promptGuidelines` |
| Advisor call | `ctx.modelRegistry.find` + `complete(model, ctx, { cacheRetention: "none" })` |
| Judge | `ctx.modelRegistry.findOfType("classifier", …)` + `classify()` |
| Reset | `turn_end` → `{ entries: [{ type: "compaction", summary, firstKeptEntryId }] }`; `/baton reset` uses `ctx.compact()` + `session_before_compact` |
| Commit gate | `tool_call` → `{ block: true, reason }` |
| Nudges | `turn_end` → `custom_message` entry |
| Context ratio | `ctx.getContextUsage()` |

Development: `npm install && npm run check` runs `tsc --noEmit` against the real pi types and the vitest unit tests (journal, masking, pack, triggers, schema, judge, reset).

## Status / limitations

0.3.0 is an early version. The type-checked code, the unit tests and the extension loading in pi's real loader are verified. End-to-end sessions with GLM-5.3-Flash and Opus 5.5 via OpenRouter were run on a Tetris-on-Reatom task.

- Token counts are conservative estimates (chars/2.4, non-ASCII ×2; calibrated on real Opus input tokens, where chars/3.2 still under-counted by 23–32%); pi has no public tokenizer. Real advisor usage is recorded in the journal (`advisor` events: `usage`, `attempts`, `packTokens`).
- Masking rewrites the prefix of the request, which breaks prompt caching. That is cheap for GLM but would be costly for Anthropic executors. Stubs are stable, so the prefix only changes once per batch.
- Test-summary parsing is regex based (vitest/jest/pytest/cargo/go). Other runners only get exit codes.
- The reset relies on `turn_end` compaction entries. If pi rejects the entry, use `/baton reset`.
- The Jev judge only covers the help-pack timeline. Its question format follows pi's `ClassifierContext` types, but it has not been run against the TypeSafe API.
- `executor` in the config is informational. Baton never switches models.

## License

MIT
