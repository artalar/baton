# Baton — an efficient review agent

Baton makes running an **expensive reviewer** (e.g. Claude Opus) over a cheap executor's work (e.g. GLM)
much more effective than a plain "review subagent". The difference is context preparation: instead of
letting the reviewer spend tokens (and turns) exploring the repo with tools, Baton hands it **one
prepared, tool-less pack** with exactly what a review needs, ordered for long-context accuracy and
prompt caching:

```
system (stable, cacheable)   ROLE: "below is a junior's work… you have no tools, everything is below"
                             PROJECT SKILLS (relevant SKILL.md, selected by score within a budget)
                             PROJECT RULES (AGENTS.md / CLAUDE.md)
user (per call)              PINNED PLAN (the contract the work is checked against)
                             TASK + USER PROMPTS (verbatim)
                             ARTEFACTS: diff --stat, changed files, git diff, last test run (verbatim),
                                        timeline / last calls (help), repo map (plan), deferred loop items
                             EXECUTOR CLAIMS (unverified)
                             INSTRUCTIONS + JSON reply schema (last)
```

Why it is cheaper and better than a review subagent:

- **One call, no tool loop.** The reviewer cannot read files, so it does not burn turns; the pack is built
  deterministically from git and the journal (no LLM in the preparation path).
- **Third-person, evidence-only framing.** The executor's narrative is not shown; its claims are labelled
  unverified and must be confirmed by quoting the diff/test output.
- **Project skills as review rules.** The relevant `SKILL.md` files become the checklist; non-idiomatic code
  is flagged against them.
- **Prompt caching.** Role + skills + AGENTS.md are a byte-identical prefix across calls of the same kind,
  marked with Anthropic `cache_control` when the advisor is `anthropic/*` on OpenRouter.
- **Budgeted.** A conservative token estimate (chars/2.4, non-ASCII ×2) clips the most cuttable sections first
  (repo map → changed files → skills/plan/timeline → diff → test output); task, claims and instructions are never cut.
- **Structured reply.** Validated JSON (`verdict`, `facts_corrected`, `plan` with `done_when` and
  `verify: self|review`, `do_not_retry`, …), one retry on invalid/cut-off JSON.

Baton ships as a **pi-independent core** (library + CLI) and a **thin pi extension**.

## Architecture

```
src/core/                 no pi imports (only node + typebox)
  pack/sections.ts        PackInput → ordered sections, budget fitting (fitSections)
  pack/index.ts           buildReviewPack(input) → { messages, sections, tokens, stableTokens }; buildPack (single text)
  pack/collect.ts         collectPackInput({kind, cwd, task, plan, claims, journal?, …}): git diff, changed files,
                          last test, skills selection, AGENTS.md, repo map, help context from a journal
  advisor.ts              runAdvisor(model, messages, complete): validation + one retry, transport-agnostic
  openrouter.ts           OpenRouter transport (OPENROUTER_API_KEY), cache_control on the stable prefix
  journal.ts repo.ts skills.ts schema.ts util.ts
src/cli/                  baton-pack, baton-review
src/pi/                   the pi extension (thin layer)
  index.ts                tools baton_review / baton_plan / baton_help / baton_step / baton_recall, /baton command
  advisor.ts              pi transport: modelRegistry.complete with systemPrompt = cacheable prefix
  gate.ts triggers.ts     review gating, finalize mode, plan/commit gates, nudges
  loop.ts                 deterministic stuck-loop detector
  mask.ts reset.ts        OPTIONAL handoff compaction (compact.enabled)
  config.ts
```

## Library API

```ts
import { collectPackInput, buildReviewPack, runAdvisor, openRouterComplete } from "pi-baton";

const input = await collectPackInput({
  kind: "review",                 // "review" | "help" | "plan"
  cwd: "/path/to/repo",
  task: "Add a pause button to the game",
  plan: pinnedPlanText,           // optional: the contract to review against
  claims: ["all tests pass"],     // shown as unverified
});
const pack = buildReviewPack(input, { budgetTokens: 40_000 });
// pack.messages = [{ role: "system", content, cache: true }, { role: "user", content }]

const res = await runAdvisor("anthropic/claude-opus-5.5", pack.messages,
  openRouterComplete({ model: "anthropic/claude-opus-5.5", maxTokens: 8192 }));
if (res.ok) console.log(res.reply.verdict, res.reply.plan);
```

You can also fill `PackInput` yourself (diff, files, test output from your own tooling) and call
`buildReviewPack` directly; `runAdvisor` accepts any `complete(messages)` transport.

## CLI

Node ≥ 22.6 (runs the TypeScript sources directly).

```sh
# print the pack for the working tree of a repo — no LLM call
baton-pack --cwd ./my-repo "Add a pause button"            # human-readable, token estimate on stderr
baton-pack --kind plan --json --task-file TASK.md
baton-pack --plan PLAN.md --claim "tests pass" "Add a pause button"

# call the advisor via OpenRouter (key from env OPENROUTER_API_KEY only; never put it in config)
baton-review --model anthropic/claude-opus-5.5 --cwd ./my-repo "Add a pause button"
baton-review --json --no-cache --max-tokens 4096 "…"
```

Options: `--cwd DIR`, `--kind review|help|plan` (default review), `--plan FILE`, `--claim TEXT` (repeatable),
`--task-file FILE`, `--budget N` (pack tokens, default 40000), `--json`; `baton-review` adds `--model`,
`--max-tokens`, `--no-cache`.

## pi extension

```sh
pi install npm:pi-baton      # or: pi -e ./src/pi/index.ts
```

Tools for the executor:

| Tool | What it does |
|---|---|
| `baton_plan` | Pack with skills, AGENTS.md, repo map and exploration findings → plan with invariants, skill rules, checkpoints. Pinned into every request. |
| `baton_review` | Review pack (diff, changed files, last test, pinned plan, unverified note) → verdict + fixes. Required before `git commit`. |
| `baton_help` | Last N tool calls verbatim, same-error calls, hypothesis/attempts (unverified) → root cause + plan. |
| `baton_step` | Mark a pinned-plan step done / in_progress / blocked / deferred with evidence (no advisor call). |
| `baton_recall` | Full output of a journal event (`evt#`). |

Kept from 0.5: **review gating** (review refused until the previous review's review-verified steps are closed
or ~15 calls / ~80 changed lines accumulated; `verify: self` steps need no re-review), **finalize mode** after
`done`, plan-before-write and review-before-commit soft gates, nudges, the **loop detector** (default: forces
an automatic `baton_help` with the loop as reason; the looping item is deferred and its test file edits are
blocked until the reviewer or the user unblocks it — `/baton unblock D1 [guidance]`, `/baton drop D1`).

**Compaction is optional and off by default.** With `compact.enabled: false` the advisor reply is appended to
the conversation normally and nothing is masked, stubbed or cut; pi's own auto-compaction is untouched. With
`compact.enabled: true` you get the 0.4 behaviour: at each handoff the executor context is reset to task +
pinned plan + advisor reply + last calls (older outputs become `evt#` stubs), context pressure forces a review
handoff, loop items are cut from the context, and pi's auto-compaction is routed through a review.

## Configuration

`~/.pi/agent/baton.json`, then `.pi/baton.json` in the project (deep-merged; keys that look like secrets are
ignored). Full defaults: [`baton.example.json`](baton.example.json).

| Group | Keys (defaults) |
|---|---|
| `advisor` | `model` (`openrouter/anthropic/claude-opus-5.5`, from pi's model registry), `maxTokens` 8192, `cache` `"short"` \| `"long"` \| `"none"` |
| `pack` | `budgetTokens` 40000, `excludePaths` (lockfiles, dist, node_modules, journal), `skills` {`enabled`, `budgetRatio` 0.35, `maxSkills` 4, `dirs`}, `pinPlan` true, `helpLastCalls` 8 |
| `review` | gating: `enabled`, `minDiffLines` 80, `minCalls` 15, `helpMinCalls` 5, `finalizeAfterDone` |
| `triggers` | nudges and soft gates: `contextRatio`, `sameErrorCount`, `reviewBeforeCommit`, `remindEvery`, `minGapCalls`, `milestoneReview`, `autoPlanAfterReads`, `planBeforeWrite`, `driftCalls` |
| `loop` | `enabled`, `windowCalls` 30, `maxHops` 6, `hopGapCalls` 30, `readRepeatThreshold` 8, `action` `"help"` \| `"nudge"`, `blockDeferredEdits`, `ignoreReadPaths` |
| `compact` | **`enabled` false**, `keepTurns` 2, `keepCalls` 2, `exemptTools`, `neverMaskPaths`, `replaceAutoCompact` |
| — | `journalDir` `.pi/baton` |

Prompt caching: in pi the stable prefix is sent as the system prompt and pi-ai marks it with
`cache_control` for `openrouter/anthropic/*` models (`advisor.cache` maps to pi's `cacheRetention`). The core
OpenRouter client does the same itself (`--no-cache` to disable).

## Development

```sh
npm install
npm run check      # tsc --noEmit + vitest
```

No test calls a paid model: transports are faked and the request shape is asserted.

## License

MIT

## Mode `switch` (in-session model switching)

`pi --model openrouter/z-ai/glm-5.3-flash -e src/pi/switch.ts "<task>"` (or `BATON_MODE=switch` with `src/pi/index.ts`).
One session, the lead model (default `openrouter/anthropic/claude-opus-5.5`) plans and writes code; the helper (default `openrouter/z-ai/glm-5.3-flash`) reads, runs verify/fix loops and the final review. Configure in `.pi/baton.json` under `"switch"` (see `DEFAULT_SWITCH` in `src/pi/switch-core.ts`). Journal: `.pi/baton/switch.jsonl`, `switch-summary.json`.

0.8: verify detection only on executed commands; the lead writes tests with the code (debug only once tests exist/ran); helper guardrails (no `--passWithNoTests`, `as unknown as`, version downgrades, skipped/deleted tests); **honest handoff** — the lead never sees the helper's raw turns, it gets a `[Baton harness]` report (diff stat, final check outputs, one-line edit intents, SUSPICIOUS EDITS); harness tools `baton_delegate` / `baton_optimize` (described, never prescribed); reasoning + `max_tokens` cap outside planning; cache anchor with ≤4-breakpoint guard; budget stop `BATON_BUDGET_USD` (lead exact + helper ×2.3 + $0.5 reserve). 0.8.1: no allowlist while the helper reads — a fs guard (`git status` snapshot, ≈3 ms) reverts any file change it makes (backup in `<journalDir>/fsguard/`), drops the call and hands over to the lead with a harness note; installs / lockfiles / HEAD moves are reported, not reverted. Two consecutive read-only lead turns → helper reads; read-only lead turns are thinking-capped even before the planning write. Resume a stopped run: `BATON_SWITCH_START=lead BATON_BUDGET_USD=<remaining> pi -c --session-dir <dir> -p … -e src/pi/switch.ts "Continue the task"` (the lead continues directly; spend counters restart per process). Bash writes (`cat > f <<'EOF'`, redirects, tee) count as code writes. 0.10: the helper also **implements** the lead's spec (`baton_delegate kind "implement"`, new files allowed, Baton runs typecheck+tests itself afterwards, red → helper fixes); reading outputs reach the lead verbatim, edit stretches come back as a short `[Baton harness] interruption summary` (files, definitions, check status); one read-only lead turn → helper reads; reserve $0.25. 0.9.1: skill files (SKILL.md/REFERENCE.md, `.agents/skills/**`) read by the helper go to the lead verbatim and deduplicated in the harness report; other reads are still clipped. 0.9: **Jev supervisor** — every helper tool call and every lead/debug/review turn boundary is scored by a decision model (`typesafe/jev-1.13` via OpenRouter `/api/alpha/decisions`, fallback `microsoft/microsoft-decision-1`, 800 ms per attempt, then the 0.8.1 rules). Input: policy + code-computed summary (counters, red cycles, tests, guard flags; a ≤300-char note GLM rewrites every 10 turns) + last 5 calls (tails ≤220 chars) + the proposed call. Block if max(weakens_checks, tampers_env) ≥ 0.8; let it run and hand over to the lead if 0.5–0.8, P(handoff) ≥ 0.8 or stuck ≥ 0.9; lead → helper if routine_ahead ≥ 0.6 after ≥2 non-write calls. Hard regex guardrails run first and never depend on Jev. Key: env `OPENROUTER_API_KEY` only. Config `.pi/baton.json` → `switch.jev` (defaults: `DEFAULT_JEV` in `src/pi/jev-config.ts`), `BATON_JEV=0` to disable. Metrics in `switch.jsonl` (`jev`, `jev_fallback`, `jev_summary`) and `switch-summary.json` (`jev`). Journal events: `lead_request`, `cache_anchor`, `lead_after_helper`, `guardrail`, `nudge`, `optimize`, `budget_stop`; `end`/summary carry `metrics` (selfBaton, reverifyRuns/Reads, guardBlocks, lengthStops) and `flags`.
