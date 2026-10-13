# Changelog

This file follows [Keep a Changelog](https://keepachangelog.com/). Development notes, cost models, and version-by-version experiment logs are in [docs/history.md](docs/history.md).

## [Unreleased]

Baton is now one thing: speculative execution of the lead model's work by a cheap helper in the same pi session, with explicit harness notes for the lead. This release folds in the 0.14.0 experiment changes and fixes the six causes found after run L.

### Removed

- Advisor mode (`baton_plan`, `baton_review`, `baton_help`, `baton_step`, `baton_recall`, `/baton`, review gating, loop detector, compaction), the pack library, and the `baton-pack` / `baton-review` CLIs, skill and prompt.
- Phased switch mode (helper reading, implement/debug/review phases, `baton_read`, `baton_edit`, `baton_delegate`, `baton_optimize`, edit intents, the file-system guard, lead-cache keepalive).
- Speculation controls that cut useful runs or were noisy: the phase rule, the out-of-plan edit stop, the stop on the first tool error, the Jev step gate and step estimate, and the adaptive ceiling (`BATON_SPEC_GATE`, `BATON_SPEC_STOPS`, `BATON_SPEC_EST`, `BATON_SPEC_PHASE`, `BATON_SPEC_ADAPT`, `BATON_SPEC_V2`).
- The unreleased advisor and switch-mode changes made after 0.13.1 (advisor keepalive, switch caps, file-system guard hardening) are gone along with those modes. The `dist/` build, `bun run smoke`, and CI on Node.js 22 and 24 stay.

### Added

- The lead's system prompt explains speculative runs, rollback, and that final verification is the lead's job.
- Every run note is built from facts: each helper call with an honest outcome (`ok`, `ERROR`, or `UNRELIABLE` when a piped check exits 0 but reports errors), read outputs verbatim, the run's diff from a git checkpoint, and typecheck/test/build results the harness ran itself. The helper's prose is never included.
- A git checkpoint before each run (a tree object in a temporary index; the user's index, `HEAD` and refs are untouched) and the lead-only `baton_rollback({run})` tool, which reverts only the files the run changed and keeps files changed after it.
- Final checks: when the lead gives its final answer after files changed, the harness runs typecheck, tests and build, and sends the lead back while they fail (at most 2 rounds).
- Helper guardrails during runs: no overwriting existing files, no removed or skipped tests, no deleted test files, no `--passWithNoTests`, no new `as unknown as`, no dependency downgrades, no history-changing git commands. A block ends the run.
- `transcript: "full"` (`BATON_TRANSCRIPT=full`): every helper output verbatim.
- Jev sees the task and the last 4 turns of both models. Without Jev, a run starts after any lead turn with tool calls.
- An unfinished run is closed and reported when a new prompt arrives.

### Changed

- Speculation is on by default (`BATON_SPEC=0` turns it off).
- The budget counts provider-reported helper cost (`helperCostFactor` default 1, was 2.3). When what is left only covers the lead's wrap-up, runs stop and the lead is told to finish and verify; the abort happens only at the budget itself.
- The helper sees the lead's view plus its current run, not earlier runs.
- One entry point: `pi -e ./dist/index.js`. Configuration keys are flat (`steps`, `transcript`, `checks`, `jev`, `budget`); see the README.
- The journal is per session: `<journalDir>/sessions/<id>/events.jsonl` and `summary.json`.

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
