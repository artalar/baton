# Changelog

This file follows [Keep a Changelog](https://keepachangelog.com/). Development notes, cost models, and version-by-version experiment logs are in [docs/history.md](docs/history.md).

## [Unreleased]

### Added

- The package compiles to `dist/` (`bun run build`). `baton-pack` and `baton-review` are Node launchers for that output. Package exports, type declarations, and the pi extension entry all point at `dist`. Node.js 22 or newer is required.
- `bun run smoke` packs the tarball, installs it, and runs the binaries. `bun run coverage` collects test coverage. Continuous integration runs check, build, and smoke on Node.js 22 and 24.
- Advisor cache keepalive (`advisor.keepalive`, default every 240000 ms, at most 5 pings) refreshes the shared system prefix while a pinned plan is still open. It runs only when `advisor.cache` is `"short"` and stops after a `done` verdict.
- Switch caps: `maxImplementCalls` (60), `maxEditTool` (12), `maxLengthContinuations` (3), `cacheKeepaliveMax` (5), `fsGuardMaxRevert` (50).

### Changed

- Load the extension from the build (`pi -e ./dist/pi/index.js`, or `pi install <path>` after `bun run build`). The npm name is not published yet.
- Advisor calls share one system message (role, project skills, `AGENTS.md`), frozen after the first advisor call of the session. Plan, review, and help instructions are the `CALL ROLE` section of the user message. Skills chosen on that first call stay for the session.
- The pi journal is per session: `<journalDir>/sessions/<session id>/events.jsonl` and `raw/`. Resuming with `pi -c` restores that session. A new session starts clean. The journal directory gets a `.gitignore` of `*` when it does not already have one.
- `runAdvisor` returns `usages` for every attempt besides `usage` for the last one. `openRouterComplete` accepts `timeoutMs` (default 300000).
- The decisions client is not exported from the public package entry.
- Verdict `need_user` means the task is ambiguous or needs a user decision. Questions go in `questions_for_user`.
- Switch settings for models, keepalive, budget, reserve, helper cost factor, endgame, the revert cap, the Jev model and its fallback, and `journalDir` are accepted only from the user config (`~/.pi/agent/baton.json` or `PI_CODING_AGENT_DIR`) or the environment. A project `.pi/baton.json` cannot set them; Baton warns and ignores those keys. `journalDir` must stay inside the working directory.
- Lead-cache keepalive runs only during an active agent run, only for an OpenRouter lead, at most `cacheKeepaliveMax` times per helper stretch, and the estimate counts toward the budget.
- Checks after an implement stretch run in their own process group and are killed on timeout. Typecheck uses the `typecheck` script, or `npx --no-install tsc --noEmit` when a `tsconfig.json` exists and that script does not.
- `BATON_BUDGET_USD` accumulates for the pi process. After a stop, later prompts in that process are aborted and a notice is shown. A non-numeric value is ignored, with a warning.

### Fixed

- `baton-pack` and `baton-review` support `--help` / `-h` and `--version` / `-V`. Unknown flags fail. `--budget` and `--max-tokens` must be positive integers.

### Security

- Packs escape XML attributes and neutralise `</file>`, `</skill>`, and `</baton_pack>` inside included file, skill, and diff text.
- The file-system guard reverts helper edits from a reading stretch only when both git snapshots succeed and `HEAD` is unchanged. It uses literal pathspecs and git-root-relative paths, restores clean tracked files from `HEAD` (index and worktree), puts already-dirty files back to the pre-call snapshot, and deletes only files created after the snapshot. Directory paths are left in place, and symlinks are skipped. It hands the turn to the lead without reverting when a snapshot fails, when the path count exceeds `fsGuardMaxRevert`, when that cap is 0, or when a gitignore or index change would expose ignored files. Backups are under `<journalDir>/fsguard/`.
- API keys are taken from the environment or from pi's auth. Advisor config drops keys whose names look like secrets.

## [0.13.1] - 2026-10-13

User-visible capabilities of this pre-release. Detail is in [docs/history.md](docs/history.md).

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
