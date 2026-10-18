The evidence-based run chronology is in [experiment.md](experiment.md).

This file is the development log: the previous changelog, kept verbatim, including experiment notes and cost models.

# Changelog

## 0.13.1

Speculation-length control. Each variant has its own flag (`BATON_SPEC=1` is still required); `BATON_SPEC_V2=1` turns all five on. Hard ceiling `spec.maxSteps` = 10.
1. **Jev step gate** (`BATON_SPEC_GATE`, `spec.gate {free:3, thr:0.7}`): the first 3 helper steps run unchecked. Before every later step Jev answers `cont` ("the next call is still a routine continuation of the lead's plan"); p < 0.7 → back to the lead. Why 0.7: a kept step saves ≈ 1/1.8 of an Opus turn (≈ $0.03), and a drifted step costs about one Opus fix turn plus the summary (≈ $0.07). Continuing pays off when p·0.03 > (1−p)·0.07, that is p > 0.7. With the gate on, a run starts at 10 steps instead of 8/4 (the start thresholds 0.8 / 0.93 stay).
2. **Free stops** (`BATON_SPEC_STOPS`): the first tool error, a repeated call (same name and arguments, including the lead's trigger call; blocked before it runs) or a text-only helper answer → back to the lead.
3. **Step estimate** (`BATON_SPEC_EST`): in the same Jev request as `more_calls`, Jev gives P(≥3/6/10 more calls on the current sub-task). The first threshold reached at p ≥ 0.5 → ceiling 10/6/3, otherwise 2. Rule 1 can still cut a run shorter.
4. **Phase change** (`BATON_SPEC_PHASE`): reads, searches and test/build runs are free. If the run started after a read-only lead turn, the helper's first edit (write/edit/bash redirect) is **blocked before it runs** and the run ends: the lead makes that edit. If the lead's trigger turn edited files, the helper may edit **only those files** (finishing the same plan: fixing the test it just ran, completing the edit). An edit to any other file ends the run the same way.
5. **Adaptive ceiling** (`BATON_SPEC_ADAPT`, `spec.adapt {min:2, max:10, init:6}`): on the lead's first turn after a summary, an edit to a file the helper edited, a git checkout/restore/stash/reset, or a repeat of a helper call counts as **rework** (cap −2). Anything else counts as **continue** (cap +1). The run's starting N = min(base, estimate, cap).
- The journal `switch-summary.json` now has `spec {stats, runs[{n, steps, why, p, est, cap}], adapt[], cap}`. Jev logs gain `est/p3/p6/p10/cap` and `spec_cont` entries. Tests: `test/spec.test.ts` (0.13.1 block).

## 0.13.0

- **Speculative execution mode** (`BATON_SPEC=1` or `switch.spec.enabled`; off by default, other modes unchanged). Opus leads; after each lead turn with tool calls Jev answers `more_calls` ("will the lead make more tool calls after this one?"). If p ≥ `thr` the call runs as usual, then GLM continues in the same session for N steps with no fsguard, guardrails, Jev call gate or phases. After N steps, or when GLM stops, the harness cuts it off and gives control back to Opus with a `[Baton harness] … speculatively continued …` summary: the calls with ok/ERROR and an output line, the files touched, git diff --stat, the last check and the helper's last note. GLM turns are hidden from the lead view. Cooldown: 1 lead turn between runs.
- **N and threshold:** adaptive. p ≥ 0.93 → 8 steps; 0.8 ≤ p < 0.93 → 4 steps; below that, none. Offline data: P(next Opus turn has calls) is 0.98 for A, 0.97 for J2 and 1.0 for J3, so series length does not limit N; drift does. Model on A (47 turns, $0.057/turn; GLM step $0.0026; summary $0.012; ~1.8 GLM steps per Opus turn):
  - Savings: N=4 saves 36–47 %, N=8 saves 44–58 %, N=12 saves 46–62 %.
  - P(drift within a run) at N=8 is 0.34–0.57; past 8 the gain is ≤ 3 p.p. and drift goes above 50 %.
- Config: `spec {enabled, thr, thrHigh, nLow, nHigh, cooldown, summaryChars}`. Tests: `test/spec.test.ts`.

## 0.12.3

- The lead prompt and the `baton_read` / `baton_edit` descriptions now state the key advantage: both run the helper **inside this session with the lead's full context** (task, files read, decisions, history). A short request is therefore enough, unlike a subagent that starts empty and needs a long brief.
- Test: the helper's view of the context contains the task, the lead's turns, its decisions and its read outputs. The lead's view hides the helper's turns.

## 0.12.2

- The lead's system note and the `baton_read` / `baton_edit` tool descriptions now explain why to use them:
  - One call replaces many turns, and every turn resends the whole context.
  - `baton_read` returns the raw outputs verbatim, deduplicated, with skills in full; nothing is lost and the lead can call again.
  - With `baton_edit` the lead stays the author and gets the diff summary plus tsc/test status in one result. The mechanical write → check → fix loop runs without it, and the lead can always fix things itself.
- The edit-intent paragraph moved to `LEAD_INTENT_NOTE`. It is appended only with `BATON_EDIT=intent`, so it no longer competes with `baton_edit`.
- `MSG.lead` now points to `baton_edit` / `baton_read`; `baton_delegate implement` stays for whole multi-file specs.

## 0.12.1

**`baton_read`: the lead studies code through the helper (switch, default on)**
- New lead-only tool `baton_read({request})`. `request` is free text: what to find out or read (files, APIs, where to look).
- The helper reads in the same session (followup phase). Edits are blocked at the gate (0.11) and the fs guard is on.
- On hand-back, the **tool result** contains the helper's tool outputs verbatim:
  - without its reasoning;
  - deduplicated (identical call + output appears once; new in this release);
  - skill files in full (the longest read wins).
  
  The lead gets a one-line "baton_read finished" message. The placeholder result was never sent to the lead, so the lead's prompt cache stays intact.
- Limit: `maxReadTool` (8) calls per session. After that the tool result says "read it yourself". `BATON_READ=off` turns the tool off.
- The lead's system note now says: prefer `baton_read` for studying code and `baton_edit` for edits; plain read/bash/write/edit are the fallback.
- **Offline estimate** (Opus turns made only of read-like calls; consecutive turns collapse into one `baton_read`):

| Arm | Read-only turns | Runs of turns | Opus requests saved | Saving |
|---|---|---|---|---|
| A | 11 | 6 | 5 | ≈ $0.23 (8 % of Opus) |
| J | 1 | — | 0 | — |
| J2 | 5 | 4 | 1 | ≈ $0.02 |

  The real gain is larger when the lead itself reads skills and node_modules (A, early arms). With switch, most reading already went to the helper.

## 0.12.0

**`baton_edit`: the lead changes files through a Baton tool (switch, default on)**
- New lead-only tool `baton_edit({request})`. `request` is free text: what to change and why; it does not have to spell out every change. The lead's system prompt asks it to ALWAYS use `baton_edit` instead of write/edit (`LEAD_EDIT_TOOL_NOTE`). write/edit stay available as the fallback.
- The helper performs the request in the **same session**: it sees the same history as the lead, so this is neither a separate subagent nor a strict structured tool call. The implement path applies: guardrails, Jev's weakens/tampers block, the fs guard, then the Baton auto-check, with the debug loop when red.
- When the helper hands back, the lead sees **the `baton_edit` tool result**, not the helper's calls. It reads either `DONE` plus the interruption summary (files, definitions, compressed diff, checks) or `NOT DONE — … make this edit yourself with write/edit`. The placeholder result was never sent to the lead, so the swap does not break the lead's prompt cache. The lead also gets a one-line "baton_edit finished" message.
- `BATON_EDIT=tool` is the default: the `baton_edit` tool plus edit intents. `BATON_EDIT=intent` keeps only the 0.11.1 `<edit-intent>` protocol; `BATON_EDIT=off` lets the lead edit itself. Config fields: `editTool`, `editIntents`. Journal and metrics: `editTool {calls, ok, failed}`.
- Offline estimate: the same as for edit intents. If all Opus writes in J / J2 / I had gone through `baton_edit`, Opus would have spent ≈ $0.13 / $0.30 / $0.15 less (≈ 15 / 17 / 11 %). Not yet measured in a paid run.

## 0.11.1

**Edit intents (switch): the lead specifies, GLM edits**
- **Lead system note.** Before changing any file, the lead states an `<edit-intent>` (`files:` / `change:` / `why:`) and ends its turn without tool calls.
- **Hand-off.** Baton hands the intent to the helper as an implement spec ("one focused edit: only the listed files"). The usual path applies: guardrails, Jev's weakens/tampers block, the fs guard, then the Baton auto-check. Red goes to the helper's debug loop; on green, the lead gets the `[Baton harness] interruption summary` (files, definitions, compressed diff, checks). The helper's calls are never shown to the lead verbatim.
- **Fallback.** If the helper escalates, or the checks are still red after the debug loop, the lead is told "make that edit yourself". Its next intent is not handed over, and it gets a "make the edit yourself now" nudge. After `maxIntentFailures` (2) failed intents, the lead edits itself for the rest of the session.
- An intent stated together with the lead's own edits in the same turn is not handed over. `editIntents: false` turns the feature off.
- **Offline estimate on the logs.** Opus wrote 3 / 7 / 2 files in J / J2 / I (17 / 30 / 20k characters, ≈5.4 / 9.5 / 6.2k tokens). Handing them over saves Opus output (≈$20/M versus GLM ≈$1.2/M, minus about 15 % for the intent text), the cache write of that code (×1.25) and its re-reads in later turns (only a summary of about 10 % remains). Estimate: **J ≈ $0.13 (≈15 % of $0.90), J2 ≈ $0.30 (≈17 % of $1.73), I ≈ $0.15 (≈11 % of $1.39)**. Not yet measured in a paid run.

## 0.11.0

**Switch fs guard**
- The guard ignores build and test artefacts: `dist`, `build`, `coverage`, `.vite`, `.vitest`, `.cache`, `.turbo`, `*.tsbuildinfo`, vite timestamp files and similar, even when `.gitignore` misses them. Gitignored paths were already excluded through `git status`.
- The node_modules signature now comes from the package managers' install markers (`.package-lock.json`, `.modules.yaml`, …). The directory mtime is no longer used, because vite and vitest create `node_modules/.vite` and `.cache` on every run.
- **Real cause in arm J2.** The followups ended 5 times with "helper changed the working tree during reading". The trigger was not tests: after Jev's "routine ahead", GLM started *implementing* (`write src/game/profiles.ts` …), and the guard reverted it. Reading phases now block `write`/`edit` at the gate with a "report, READ DONE" nudge. A third blocked edit hands control back to the lead. Bash stays allowed, and the guard still reverts source changes made through bash.

**Advisor mode (GLM leads): prompt cache**
- One role text (`SHARED_ROLE`) is shared by plan, review and help, so the system prefix (role + skills + AGENTS.md) is byte-identical across kinds. The kind-specific role becomes the first user section, `CALL ROLE`. Arm K2: 3 of 4 Opus calls missed the cache because plan and review had different system prefixes.
- The system prefix of the session's first advisor call is frozen and reused verbatim. Later skill re-selection or clipping cannot change it, and the user message fits into the remaining budget. `cache_control` stays on the system message, which is the end of the shared prefix.
- Keepalive: `advisor.keepalive {everyMs: 240000, max: 5}`. While a next call is expected (a pinned plan that is not done), Baton pings the same model with the same cache retention and no reasoning, as the real call does: the frozen system prefix, a 1-token reply, recorded as a journal note with usage.
- `advisorKeepaliveWorthIt(pings, p)`: keepalive pays off when pings·0.1 < p·(1.25 − 0.1). At one ping per 4 min that means gaps up to about 46 min when the next call is certain, and about 23 min at p = 0.5.

## 0.10.3

- **Keepalive fixed.** Arm J: the 0.10.1 keepalive stripped `reasoning` and set `max_tokens: 1`. Changing thinking params invalidates Anthropic's message cache, so it *wrote* the cache instead of reading it (cached 0, $0.195). It now replays the lead payload byte-identically (streamed) and aborts after the first model chunk. The budget counts `cacheKeepaliveCostUsd` (0.06) per keepalive.

## 0.10.2

- `maxImplementMs` now defaults to **0 = no time limit** on GLM implement stretches; a cap applies only when set explicitly. The lead cache stays warm via the 0.10.1 keepalive.

## 0.10.1

- **Lead cache keepalive.** Arm I: a 270 s implement stretch let the Opus 5-min prompt cache expire (TTL counts from the lead's request *start*), and the next lead turn rewrote ~80k tokens for $0.41 — ~30 % of the run. During helper phases Baton now replays the last lead payload byte-identically with `max_tokens: 1` once the lead has been idle `cacheKeepaliveMs` (230 s): a cache read (~$0.04) instead of a rewrite. Journal event `cache_keepalive`; its cost counts toward the budget.
- `maxImplementMs` (480 s) caps implement stretches separately from `maxHelperMs`, since the cache no longer forces a short stretch.

## 0.10.0 — 2026-10-13
Goal: the helper (GLM) does a large share of the work early, within a $1.5 budget (G/H: GLM cost $0.023/$0.006).
- **Reading (verbatim)**: the read prompt names the task, requires reading EVERY SKILL.md/REFERENCE.md in full (skills over node_modules) and ≥6 calls (follow-ups ≥3); a READ DONE below the minimum gets one "read more" nudge (G/H: follow-ups ended after 1 turn). Read outputs reach the lead verbatim (tool results only, no helper reasoning); clip threshold 20k → 50k chars, report cap 160k → 250k; skills never clipped (0.9.1).
- **One read-only lead turn** (was 2) → helper follow-up with the lead's exact calls and "skills/REFERENCE.md first"; follow-up rounds 2 → 4.
- **New phase `implement`**: `baton_delegate({kind:"implement", instruction:<spec>})` — the helper writes the files of the lead's spec (new files allowed; guardrails, fs journal and Jev gate on every call; Jev P(allow_handoff) alone does not end the stretch, weakens/tampers still block). When it reports IMPLEMENTED, **Baton runs the checks itself** (`runChecks`: typecheck script or `tsc --noEmit`, then `test`; 120 s each, killed on timeout; journal `auto_check`): red → helper debug loop with the failure output, green → lead.
- **Edits come back as a short "[Baton harness] interruption summary"** (user decision): what was done, files changed (new/modified, +/− lines) with the definitions touched (`diffDigest`: functions, consts, classes, types), check status, guardrail flags, the helper's last note, `git diff --stat`; no edit calls, no helper reasoning, no raw diff (`reviewDiffChars` = 0; details on request — the lead reads files / runs git diff). Applies to implement, debug and review hand-backs.
- **Lead prompt prescribes the split**: the lead writes plan, module boundaries, key types/interfaces and tricky core logic; routine files (UI, wiring, boilerplate, tests from its list) go to `implement`.
- `reserveUsd` 0.5 → 0.25 (largest single lead turn seen in D–H: $0.197).

## 0.9.3 — 2026-10-13
- **Only a red verify hands the lead's work to the helper**: lead → debug after writing now requires a failing verify in the turn. Arm G: Opus ran green tests mid-work (logic + model done, no UI yet) → GLM took the verify loop, found nothing to fix, tried to create `Tetris.tsx`, was blocked by the "new files are the lead's job" rule and escalated 11 s before the budget stop (~1 min of wall time lost; the debug stretch itself cost ≈$0.035, so the block rule was not the money sink).
- **Endgame**: when budget left (`budgetUsd − reserveUsd − estimate − Jev`) < `endgameUsd` (0.3), the lead keeps working: no lead → debug / follow-up / Jev routine hand-offs (each hand-back costs a cache write and wall time the lead needs to finish files).

## 0.9.2 — 2026-10-13
- Jev lead → helper switch (`routine_ahead`) now requires ≥ `minNonWrite` consecutive non-write calls **of the lead** (`track.leadNonWrite`); helper read calls no longer count. Arm G: the switch fired right after the lead's first turn ("after 9 non-write calls" = GLM's reads), twice, each time GLM returned READ DONE in seconds.

## 0.9.1 — 2026-10-13
- **Skills reach the lead verbatim**: in the honest reading handoff, outputs of skill documents (`SKILL.md` / `REFERENCE.md` anywhere, any file under `.agents/skills`, `.pi/skills`, `.claude/skills`, `skills/*.md`; via `read` or a single-file `cat`) are passed to the lead unchanged — never clipped, never omitted by the report size cap — and deduplicated per file (longest read wins, so a later partial read does not replace a full one). Other read outputs are clipped/capped as before. `skillKey`, `SKILL_PATH` exported.

## 0.9.0 — 2026-10-13
Switch mode gets a **Jev supervisor** (decision model via OpenRouter `/api/alpha/decisions`), per `baton-jev-research.md` §5:
- **`src/core/jev.ts`** (no pi dependency): `decide(state, questions, {model, fallbackModel, timeoutMs})` — fetch client, key only from `OPENROUTER_API_KEY` (never logged/returned), strict validation of every answer's `type` (missing / wrong type / choice outside criteria / noul outside [0,1] = error), LRU cache (256), per-attempt timeout, fallback decision model (`microsoft/microsoft-decision-1`, id verified against the live API).
- **`src/pi/jev-policy.ts`** (pure): state = `policy` + code-computed `session_summary` (calls, writes, files written, last check, tests, red cycles same/total, guard flags, node_modules changed, consecutive non-write calls, plus a ≤300-char `open_issues` note the helper (GLM) rewrites every 10 turns, overwritten) + last 5 calls with result tails ≤220 chars + proposed call; 6 questions (`phase`, `gate`, `weakens_checks`, `tampers_env`, `stuck`, `routine_ahead`). Thresholds (`switch.jev.thr`): block if max(weakens, tampers) ≥ 0.8; allow + hand off to the lead if 0.5–0.8, P(allow_handoff) ≥ 0.8 or stuck ≥ 0.9; lead → helper if routine_ahead ≥ 0.6 after ≥ 2 consecutive non-write calls (max 3 Jev rounds).
- **Gating points**: every helper tool call (`tool_call` is now async; deterministic rules first, then Jev), every lead / debug / review turn boundary (routine_ahead, stuck). Timeout 800 ms per attempt; error / timeout / invalid type on both models → 0.8.1 rules unchanged (`jev_fallback` event). Red-cycle escalation stays as fallback and ceiling.
- **Hard guardrails independent of Jev**: `guardCheck` (`as unknown as`, `--passWithNoTests`, test deletion/skip, version pins/downgrades) always runs first and blocks regardless of Jev's answer. A Jev block escalates to the lead immediately; "review" (0.5–0.8) adds a SUSPICIOUS EDITS flag.
- **Metrics**: journal `jev` per decision `{point, phase, action, probs, lat, cost, model, cached, fallback}`, `jev_fallback`, `jev_summary`; `switch-summary.json`/`end` carry `jev: {jevCalls, jevGateCalls, jevTurnCalls, jevFallbacks, jevFallbackModel, jevCached, jevBlocks, jevHandoffs, jevSwitches, jevCost, jevAvgLatMs, jevMaxLatMs, summaryCalls, summaryCost}`; Jev + summary spend counts toward the budget stop. `BATON_JEV=0` disables, `BATON_JEV_MODEL` overrides.
- Config `switch.jev` in `.pi/baton.json` (defaults `DEFAULT_JEV`, `src/pi/jev-config.ts`; `baton.example.json` stays the pi-layer defaults).
- Fixes from arm F (live run): the GLM summary note request uses `reasoning: {effort: "low"}` (without it GLM spent all 600 output tokens on reasoning and returned an empty note — both refreshes in F were empty); Jev routine hand-offs give the helper the lead's last calls and ask for ≥3 reads (in F GLM answered READ DONE after one call, twice). `openRouterComplete` accepts `extra` request fields.
- Tests: `test/jev-policy.test.ts` (client validation/cache/fallback/timeout/key hygiene, thresholds, state, switch integration, gold set of 1395 labelled calls with recorded Jev answers — gate accuracy 0.93, replay of D1/E1 with mocked Jev incl. Jev-down = 0.8.1).

## 0.8.1 — 2026-10-13
- **No allowlist in reading phases**: the helper may run any bash/tool while reading. A **file-system guard** (`src/pi/fsguard.ts`) snapshots the working tree before and after every helper call that can write (and every lead bash): HEAD + `git status --porcelain=v2 -z -uall` (node_modules/.git excluded) + size/mtime of dirty/untracked paths + node_modules mtime; in reading phases also the contents of dirty/untracked files. Overhead ≈2.6–3 ms per snapshot (≈5–6 ms per call) on the tetris repos. Journal `fs_guard` per call, `fs_guard_stats` at the end.
- **Changes during reading are reverted**: clean tracked files from the index, dirty/untracked files from the saved contents (mtime restored), files created by the call removed (with emptied dirs); a backup (copies + `changes.patch`) goes to `<journalDir>/fsguard/<ts>-<id>/`. The call is dropped from history (both views) and the lead takes over with an honest `[Baton harness] File-system guard` note in its report.
- **Not reverted**: package installs (`npm/pnpm/yarn/bun i|add|ci`, `npx`) are recorded only (no handover by themselves); package.json/lockfiles/node_modules changes, HEAD moves (`git commit/reset/checkout …`), downloads, `rm/mv/cp` with absolute paths are reported as NOT reverted and the lead decides.
- **"The lead only reads" = two consecutive lead turns** whose calls are all read-like (read tools, read-only bash, or bash the guard saw change nothing) → helper follow-up reads. Replaces the "≥2 read calls in one turn" rule (arm E: 12 single-read Opus turns).
- **Thinking cap on read-only lead turns while planning is pending**: full thinking only on the first lead turn after a handoff and on turns following a non-read turn; after a read-only lead turn the next request gets the reasoning cap and the non-write `max_tokens`.

## 0.8.0 — 2026-10-13
Switch mode, after the arm-D independent review (section 5):
- **Verify detection on executed commands only**: heredoc bodies and quoted strings (`node -e '…'`) are stripped, only command starts / segments after `&&` `||` `;` `|` newlines count (`executedSegments`, `verifyKinds`). The arm-D T18 scaffolding command (fixture) is no longer a verify run.
- **Tests come from the lead**: lead prompt "write the tests together with the code and run them once"; lead → debug only after the lead itself ran tests or test files exist; a lead finishing without tests gets one nudge.
- **Thinking cap enforced**: reasoning cap (`reasoning.max_tokens`) outside planning plus `max_tokens = nonWriteMaxTokens` (6000) on lead turns that are neither planning nor after a writing turn; a `length` stop is continued and uncapped. Journal `lead_request` logs `reasoning`, `max_tokens`, payload `cache_control` count.
- **Planning** full thinking stays pending until the first lead turn that writes (edit/write); re-armed after `delegate_reads`/escalation.
- **Cache anchor**: ≤4 breakpoints guard, anchor on the last non-thinking part of any type, journal `cache_anchor {anchored, at, partType, before, after, skipped}` and `lead_after_helper {cacheRead, cacheWrite}`.
- **Helper guardrails** (blocked + flagged, 2nd hit in a stretch escalates): `--passWithNoTests`, new `as unknown as`, package version downgrades / pinned installs, `.skip/.todo/x*/.only`, removed test cases, deleting test files. Green tsc/build + tests followed by exploratory scripts → straight to review.
- **Honest handoff**: helper turns are no longer shown to the lead (neither raw nor as the lead's tool calls). The lead's next instruction (user-role message) starts with a `[Baton harness] … intercepted and performed by automation (helper model)` report: read outputs (reading stretches) or diff stat, final check outputs, one-line intent per helper edit, SUSPICIOUS EDITS. Lead turns untouched (signed thinking kept).
- **Harness tools**: `baton_delegate({kind: reads|debug})`, `baton_optimize()`, `delegate_reads` alias; a short neutral description in the system prompt, no instruction to use them. Metrics: self-initiated baton calls, lead re-verification (verify reruns / reads of helper-touched files after a handback), guardrail blocks, length stops — in `switch.jsonl` (`switch`, `end`) and `switch-summary.json`.
- Bash file writes (heredoc `cat > f`, redirects, `tee`, `node -e …writeFileSync`) count as code writes (planning consumption, lead→debug, helper edit intents) — found in arm E, where Opus wrote every file through bash. Version probes (`npm --version`, `which`) are read-only. `BATON_SWITCH_START=lead` resumes a session directly with the lead.
- **Budget stop**: `budgetUsd` (or env `BATON_BUDGET_USD`): lead cost exact + helper × `helperCostFactor` (2.3) + `reserveUsd` (0.5) ≥ budget → `budget_stop` event, abort.

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
