# Changelog

This file follows [Keep a Changelog](https://keepachangelog.com/). Development notes, cost models, and version-by-version experiment logs are in [docs/history.md](docs/history.md).

## [Unreleased]

Speculation is a cheaper follower continuing the lead's work in the same pi session. One transcript is stored and filtered per model. After the follower stops, the lead sees one speculative automation alert in place of that tool work.

### Removed

- Advisor mode (`baton_plan`, `baton_review`, `baton_help`, `baton_step`, `baton_recall`, `/baton`, review gating, loop detector, compaction), the pack library, and the `baton-pack` / `baton-review` CLIs, skill and prompt.
- Phased switch mode (helper reading, implement/debug/review phases, `baton_read`, `baton_edit`, `baton_delegate`, `baton_optimize`, edit intents, the file-system guard). Its lead-cache keepalive is replaced; see Added.
- Jev and every speculation heuristic: step gate, step estimate, adaptive ceiling, phase rule, out-of-plan edit stop, stop on tool error, cooldown, repeat detector (`BATON_JEV*`, `BATON_SPEC_GATE`, `BATON_SPEC_STOPS`, `BATON_SPEC_EST`, `BATON_SPEC_PHASE`, `BATON_SPEC_ADAPT`, `BATON_SPEC_V2`).
- The process-wide USD budget (`BATON_BUDGET_USD`). Costs per model are still in the journal.
- The unreleased advisor and switch-mode changes made after 0.13.1 are gone with those modes. The `dist/` build, `bun run smoke`, and CI on Node.js 22 and 24 stay.
- The `Helper:` handoff, `.pi/baton/scratch/`, `baton_undo`, the write boundary on files the lead had already changed, and the git diff / git status note (including diff clipping and "review the diff"). `noteChars` is gone with that note.

### Added

- After a lead turn that contains tool calls, the follower continues with the full context, including the lead's thinking and the tool results. It uses the normal tools and is not limited to a named request.
- The follower hands back when its turn has no tool calls, or at a safety cap of 10 turns (5 on the first run; `maxHelperTurns`, `BATON_MAX_TURNS`). The handback does not start another follower turn. A failed request, an interrupt, or a new prompt also returns the lead. A user message during the run stays in the transcript and does not end it.
- The handback is one alert. It lists every follower tool call's name, input, and output. Follower thinking is omitted. The lead does not also see the raw follower tool transcripts.
- One transcript, filtered per model. The lead sees the alert at a stable position. The follower sees lead thinking, the real tool calls and results, and user messages, and does not see alerts, including on a later switch.
- Short system sections. The follower is told to continue the work already in context. The lead is told that a cheaper model may continue after its tool calls, and that a speculative automation alert means that work is already in the transcript. With speculation off, Baton leaves the system prompt and the model as they are.
- `helperThinking` (`low` by default; `BATON_HELPER_THINKING`; `inherit` keeps the lead's level): the follower's thinking level during a run. The lead's level comes back when it takes over.
- Lead cache keepalive during a run (`cacheKeepaliveMs`, 290 s; `BATON_CACHE_KEEPALIVE_MS`; `0` = off): every 290 s, counted from the lead's last request, Baton re-sends that request's payload byte for byte through pi's provider with the same session id, and aborts it at the first model event, so the lead's 5-minute prompt cache outlives long runs. It runs only while a run is active and the lead's request used the prompt cache. Journal event `cache_keepalive`; the usage the provider reports counts in `summary.json`. It replaces the switch-mode keepalive, which sent its replay through a separate OpenRouter client.

### Changed

- Speculation is on by default (`BATON_SPEC=0` turns it off). A run starts after a lead turn that contains tool calls. A lead turn with no tool calls does not switch.
- One entry point: `pi -e ./dist/index.js`. Seven configuration keys: `lead`, `helper`, `helperThinking`, `speculate`, `maxHelperTurns`, `cacheKeepaliveMs`, `journalDir`.
- The journal is per session: `<journalDir>/sessions/<id>/events.jsonl` and `summary.json`, with per-request usage including cache writes.

### Fixed

- Switching between the lead and the follower no longer changes the lead's thinking level. pi's `setModel` resets the level to the settings default, so after the first handoff earlier versions ran the lead (and the follower) at that default, `high` in the eval runs, instead of the level the session started with.

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
