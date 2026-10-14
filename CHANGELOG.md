# Changelog

This file follows [Keep a Changelog](https://keepachangelog.com/). Development notes, cost models, and version-by-version experiment logs are in [docs/history.md](docs/history.md).

## [Unreleased]

Baton is now one small thing: speculative execution of the lead model's work by a cheap helper in the same pi session. The harness only hands over, records facts and offers an undo; the lead decides whether to keep, fix or undo each run.

### Removed

- Advisor mode (`baton_plan`, `baton_review`, `baton_help`, `baton_step`, `baton_recall`, `/baton`, review gating, loop detector, compaction), the pack library, and the `baton-pack` / `baton-review` CLIs, skill and prompt.
- Phased switch mode (helper reading, implement/debug/review phases, `baton_read`, `baton_edit`, `baton_delegate`, `baton_optimize`, edit intents, the file-system guard). Its lead-cache keepalive is replaced; see Added.
- Jev and every speculation heuristic: step gate, step estimate, adaptive ceiling, phase rule, out-of-plan edit stop, stop on tool error, cooldown, repeat detector (`BATON_JEV*`, `BATON_SPEC_GATE`, `BATON_SPEC_STOPS`, `BATON_SPEC_EST`, `BATON_SPEC_PHASE`, `BATON_SPEC_ADAPT`, `BATON_SPEC_V2`).
- The process-wide USD budget (`BATON_BUDGET_USD`). Costs per model are still in the journal.
- The unreleased advisor and switch-mode changes made after 0.13.1 are gone with those modes. The `dist/` build, `bun run smoke`, and CI on Node.js 22 and 24 stay.

### Added

- The lead's system prompt explains speculative runs, the note, keep / fix / undo, steering the helper with "Helper: …" in a reply, and that verification is the lead's job.
- A run note built from facts only: the helper's calls in order with their status, read outputs verbatim and deduplicated, output tails of other calls, and the diff of files changed with edit/write. The helper's text is never included.
- `baton_undo({run, paths?})`: restores files a run changed with edit/write from originals saved before the helper's first edit, and deletes files it created. Files changed after the run are left alone and listed. No git needed.
- A run ends when the helper stops calling tools, its request fails, the user sends a message, or at a safety cap of 10 turns (5 on the first run; `maxHelperTurns`, `BATON_MAX_TURNS`). An unfinished run is closed and reported when a new prompt arrives.
- Lead cache keepalive during a run (`cacheKeepaliveMs`, 290 s; `BATON_CACHE_KEEPALIVE_MS`; `0` = off): every 290 s, counted from the lead's last request, Baton re-sends that request's payload byte for byte through pi's provider with the same session id, and aborts it at the first model event, so the lead's 5-minute prompt cache outlives long runs. It runs only while a run is active and the lead's request used the prompt cache. Journal event `cache_keepalive`; the usage the provider reports counts in `summary.json`. It replaces the switch-mode keepalive, which sent its replay through a separate OpenRouter client.

### Changed

- Speculation is on by default (`BATON_SPEC=0` turns it off) and starts after every lead turn with tool calls, except one that called `baton_undo`.
- The helper sees the lead's view (with the lead's thinking extracted to text, and restored when switching back to the lead) plus its current run, not earlier runs.
- One entry point: `pi -e ./dist/index.js`. Seven configuration keys: `lead`, `helper`, `speculate`, `maxHelperTurns`, `noteChars`, `cacheKeepaliveMs`, `journalDir`.
- The journal is per session: `<journalDir>/sessions/<id>/events.jsonl` and `summary.json`, with per-request usage including cache writes.

## [0.13.1] - 2026-10-13

User-visible capabilities of this pre-release, the last one with advisor mode and switch mode. Detail is in [docs/history.md](docs/history.md).

- Advisor tools `baton_plan`, `baton_review`, `baton_help`, `baton_step`, and `baton_recall`, plus the `/baton` command (`status`, `reset`, `unblock`, `drop`).
- One tool-less advisor call per plan, review, or help. The pack carries the task, user prompts, pinned plan, diff, changed files, last test, project skills, `AGENTS.md`, and unverified executor claims.
- Validated JSON replies. Verdicts include `on_track`, `course_correct`, `replan`, `done`, and `need_user`. Steps are `verify: self` or `verify: review`.
- Review gating, finalize-after-done, plan-before-write and review-before-commit gates, and nudges for milestones, repeated errors, and plan drift.
- A loop detector that defers a stuck item and can block edits to its test until a review or `/baton unblock` / `/baton drop`.
- Optional handoff compaction (`compact.enabled`, off by default). With it off, the advisor reply is appended and nothing is masked.
- A shared, cached advisor prefix (role, skills, `AGENTS.md`) frozen for the session, with keepalive while a plan is open.
- CLIs `baton-pack` and `baton-review`, and a pi-independent library (`collectPackInput`, `buildReviewPack`, `runAdvisor`, `openRouterComplete`).
- Switch mode: one session, a lead model and a helper. The helper reads, implements, debugs, and reviews; the lead sees harness reports. Tools: `baton_read`, `baton_edit`, `baton_delegate`, `baton_optimize`.
- A Jev supervisor on helper calls and turn boundaries (`BATON_JEV=0` disables it). Deterministic guardrails still apply.
- Speculative execution (`BATON_SPEC`), off by default, with optional step gate, early stops, a step estimate, phase handback, and an adaptive ceiling (`BATON_SPEC_GATE`, `BATON_SPEC_STOPS`, `BATON_SPEC_EST`, `BATON_SPEC_PHASE`, `BATON_SPEC_ADAPT`, `BATON_SPEC_V2`).
- A file-system guard on helper reading stretches, a process-wide USD budget, and lead-cache keepalive during helper stretches.
