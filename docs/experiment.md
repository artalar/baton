# The Baton experiment

Baton tested whether a cheap model (GLM 5.3 Flash) can continue work a lead (Claude Opus 5.5) already started, in the same pi session, and save money without losing quality.

On the easy 2048 suite it matched 14/14 at lower cost and less time. On 21 and 30 hidden tests, speculation stayed cheaper, ran several times longer, and every finished run lost one test that bare Opus passed. The lead never undid a speculative run (undos: 0) and almost never wrote an explicit helper assignment. There is no artifact of Opus launching a Flash subagent with a brief. Only bare Opus, and automatic continuation after the lead's turn, were measured.

That is a conclusion from these runs, not a slogan. Automatic speculation — Opus continued by GLM Flash in the same session — was cheaper. Once the hidden suite grew, it was slower and one test short. A measured condition where Opus itself delegates the key work to a Flash subagent was never run.

The code and the test suite changed between these runs. Older runs are history. They are not scores of the current tree. The 30-test runs were against a dirty build, not the commits that have since landed. See [What is not comparable](#what-is-not-comparable).

The version-by-version design log for the advisor, switch, and Jev era is [history.md](history.md). This file is the run chronology. It does not restate that log.

## 13 October — advisor, switch, Jev

Versions 0.1.0–0.13.1 landed in one day, before the speculation rule used in the later runs. There was no hidden grader. The `switch-summary.json` journals are gone. The numbers in this section come only from [history.md](history.md). Some are offline estimates, not paid runs.

Live Tetris-like runs failed in a few repeating ways.

- **Jev almost never blocked continuation.** The 0.13.0 log gives P(next Opus turn still has tool calls) = 0.98 (arm A), 0.97 (J2), and 1.0 (J3). On 14 October the author noted that Jev almost always agrees that more calls are coming.
- **Helper quality.** Architecture review chat `d53765ca` describes Run L: GLM deleted an Opus test and rewrote the model. The Run L report itself is not in the repo.
- **Arm J2.** Reads were cut off because, after "routine ahead", GLM started writing files and the fs-guard reverted them.
- **Arm G.** Green tests mid-work handed the loop to the helper. It tried to create `Tetris.tsx`, hit the new-file ban, and escalated in about 11 seconds to the budget stop. The debug itself cost about $0.035.
- **Opus cache.** Arm I: 270 seconds of GLM work, the cache expired, and the next lead turn rewrote about 80k tokens for $0.41, about 30% of the run. Arm J: keepalive changed thinking parameters and wrote the cache itself ($0.195, cache read = 0).

Offline savings estimates on edits are marked in the log as not yet measured by a paid run. Arms J / J2 / I: about $0.13 / $0.30 / $0.15, that is 15 / 17 / 11% of bases $0.90 / $1.73 / $1.39. The speculation-savings model on arm A (47 turns, $0.057 per Opus turn) is also a calculation, not an A/B.

## Night of 13–14 October — the rule, before a live run

`a69d368` (14 October, 00:17 MSK) removed Jev, phases, forced checks, and git checkpoints. The new rule: after an Opus turn with tool calls, GLM continues the plan in the same session; the lead later keeps, fixes, or reverts. At that commit there was no live run of the new models yet (chat `d53765ca`).

The helper cap was 40 turns, then changed the next morning to 5 for the first run and 10 for the rest. That cap was committed on 15 October as `a27060d`. Lead-cache keepalive is `22c49b2`, 14 October 09:07.

## 14 October — Tetris, no hidden tests

Two directories. Budget $3, cap 20 minutes. Models: Opus 5.5 and GLM 5.3 Flash. Thinking level is not recorded in `status.json`. Reatom came from a sibling checkout, not npm.

Early Baton runs hung. Helper bash started gravity with `sleep`, without `unref` and without a timeout. pi waited, and the 20-minute cap fired. Those directories were deleted. The last pair remains.

| | Opus | Baton (cap 5, then 10) |
| --- | --- | --- |
| Directory | `tmp/opus` | `tmp/baton` |
| Stop | completed, 296s | completed, 705s |
| Cost | $1.32 (36 requests) | $0.86 (Opus 8 / $0.77 + GLM 43 / $0.09) |
| edit/write | 2, all Opus | 21 GLM + 2 Opus |
| Spec runs | — | 7, undo = 0 |
| Explicit "Helper:" | 0 | 1 |

No hidden tests. Code review chat `c103fca1`: as a game and UI, Opus was better; Baton had a cleaner reactive loop and was about 35% cheaper. Both had caveats on Tetris mechanics and Reatom.

## 15 October, night — 2048, 14 tests

Budget $2. The eval was added in `064c683` (00:58 MSK). Runs started the same minute. Thinking in the current runner is medium; chat `a3dcab7b` calls these runs medium. The 14/14 grade is from that chat: the directories have no `grade.json`.

The same code was later regraded on 21 tests. The 14 base tests passed. The 7 new ones failed.

| | `tmp/2048-opus` | `tmp/2048-baton` |
| --- | --- | --- |
| Hidden | 14/14, clean audit | 14/14, clean audit (1 warning `..`) |
| Cost | $0.62 | $0.33 |
| Time | 1105s (18.4 min) | 363s (6.1 min) |
| Requests | 10 Opus | 6 Opus + 20 GLM |
| edit/write | 2 Opus | 6, all GLM |
| Spec | — | 5, undo = 0, "Helper:" = 0 |

On this version speculation matched the hidden suite and cost less money and less time. The helper wrote the product and the lead kept it.

## 15 October, morning — 21 tests

`1a149b3` (01:35 MSK) added undo, best score, and score submit. The committed `e2e.test.ts` has 21 tests. Budget still $2 and 20 minutes. The runner did not yet record `batonBuild`, so the exact dirty diff of the build is unknown. The boundary "the helper may only edit files the lead already touched" did not exist yet. It landed in `src/run.ts` around 12:55, after these runs.

| Run | Tests | Cost | Time | Requests | Who wrote |
| --- | --- | --- | --- | --- | --- |
| 2048-opus-r2 | 21/21, audit ok, 8 warnings | $0.92 | 187s | 22 Opus | 3 writes, Opus. 445 non-empty lines in `src/` |
| 2048-baton-r2 | 20/21 | $0.52 | 735s | 6 + 38 | 8 edits, all GLM. Helper: 0, undo 0 |
| 2048-baton-r3 | 18/21 | $0.52 | cap 1201s | 3 + 17 | GLM via OpenRouter `sort:throughput`. Two huge reasoning traces, then a hang inside a tool call |
| 2048-baton-r4 | 20/21 | $0.44 | 598s | 6 + 34 | bash cut at 60s (`tmp/bash-timeout-extension.js`). 12 GLM edits, Helper: 1, undo 0 |

Failures:

- r2: `failed submissions show retry…`.
- r3: all three failures are submit. `[data-submit]` stayed `pending`. The agent did not finish the path. This run hit the cap. It is not a finished score.
- r4: `right move that merges 1024s sets won`. `won` was set only in `playerMove`, while the test calls bare `move('right')`. Opus called `settleStatus()` inside `move`. That analysis is chat `182460a0`.

Grades for r2 and r4 live in that chat, not in `.run/grade.json`.

On this version Opus passed everything, was 3–4× faster, and about 2× more expensive. Baton was cheaper, slower, and one test worse whenever it finished.

## 15 October, afternoon — 30 tests, dirty build

Then-uncommitted `prompt.txt` and `e2e.test.ts` (prompt mtime 13:04) add redo, resume, and a leaderboard. 30 tests. The oracle on this version, `tmp/oracle-grade.json`, is 30/30. Runs started 13:13–13:19 MSK on a `dist` built from commit `1a149b3` with `dirty: true`. Budget $3, cap 30 minutes.

`src/run.ts` already had the authorship boundary. `src/extension.ts` changed at 13:18, between h1 and h2, so they are not the same build.

| Run | Tests | Audit | Cost | Time | Requests |
| --- | --- | --- | --- | --- | --- |
| 2048-opus-h1 | 30/30 | not ok: `git status` showed paths `evals/reatom-2048/hidden` and `oracle` from the parent repo | $1.21 | 240s | 19 Opus, 22 tool calls, 587 non-empty lines in `src/` |
| 2048-baton-h1 | 0/30 | ok | $0.30 | 45s | 4 + 6. No edits. Stop: Anthropic ToS, "reverse engineering or duplicating model outputs" |
| 2048-baton-h2 | 29/30 | ok (10 warnings, absolute paths to Playwright and caches) | $0.87 | 667s | 13 Opus ($0.81) + 63 GLM ($0.06) |

The only h2 failure is again `right move that merges 1024s sets won`. Spec runs: 12. One was blocked on writing `src/game.ts` ("a file the lead has not changed yet"). Undo = 0. Edits: 18 GLM and 4 Opus. Explicit `Helper:`: 1.

Opus-h1 at 30/30 is a test count, not a passing grade. The audit fails the run. `prepare.mjs`, since committed in `a43b92c6`, gives the workspace its own git so `git status` does not leak into the parent repo. That fix was not protecting h1. h1 is a ToS abort, not a quality score.

These three runs are the closest to the current prompt, and they are still a dirty tree. They are not a score of the commits that landed afterwards on master:

| Commit | What landed after the runs |
| --- | --- |
| `a023830b` | Redo, resume, and a leaderboard in the 2048 eval |
| `a43b92c6` | Each prepared 2048 workspace gets its own git repo, plus a run comparison |
| `da691759` | Helper writes limited to the lead's files; the lead's thinking level restored |
| `f0e4ee53` | Documents the helper write boundary and `helperThinking` |
| `961a63a9` | Bundled Reatom skill notes for timer and `take` corrected |

The afternoon build was `1a149b3` plus dirty `src`. The committed helper-write boundary (`da691759`) is later than the copy of that boundary already present in `src/run.ts` during h1 and h2.

## What is not comparable

The code and the test suite changed. Older runs are history. They are not scores of the current tree.

- **Arms A–K and 0.7–0.13.1.** Advisor, switch phases, Jev, and speculation-length heuristics were removed (`a69d368` and the changelog). A different program. No hidden-test scores. Journals for that era (`switch-summary.json`) are gone. Edit-savings figures and the arm A speculation model in [history.md](history.md) are offline estimates, not paid A/B runs.
- **Tetris** (`tmp/opus`, `tmp/baton`). No grader. Hung attempts were deleted. Reatom was copied from a sibling repo. The 5-then-10 cap was only in the working copy. Thinking level was not recorded.
- **The 14/14 pair.** A different prompt. Regrade of those same directories on 21 tests: the 14 base tests passed, the 7 new ones failed. The costs are the bill for that run, not for the current task. The 14/14 grade lives in chat `a3dcab7b`; the directories have no `grade.json`.
- **r2–r4.** The committed 21-test task (`1a149b3`): undo, best score, score submit. No redo, resume, or leaderboard. The helper could still create product files. r3 used different GLM routing (`sort:throughput`) and hit the 20-minute cap inside a tool call. r4 had a 60-second bash cap that r2 did not. The Baton build commit was not recorded. Grades for r2 and r4 live in chat `182460a0`, not in `.run/grade.json`.
- **h1, h2, opus-h1.** Closest to the current prompt, run on a dirty tree. That prompt, those tests, `prepare.mjs`, and `compare.mjs` have since been committed (`a023830b`, `a43b92c6`), and the helper write boundary too (`da691759`). The runs are not a score of current HEAD. The Baton build was `1a149b3` plus dirty `src`, and h1 vs h2 differ by the `extension.ts` edit at 13:18. h1 is a ToS abort. opus-h1's audit fails on a git leak, not on the game.
- **Undos.** No saved `summary.json` shows an undo. "Lead rejects speculation" did not fire on these runs. The lead kept the helper's work.
- **Sample size.** Every cell is one run. This is not pass@k.

## Not yet measured

The run still missing is three conditions on the same task: bare Opus, Opus calling a Flash subagent for the key work, and Baton's automatic same-session speculation.

Only the first and the third were measured. There is no artifact of a brief from Opus to a Flash subagent. Explicit `Helper:` lines were rare (one on the Tetris Baton run, one on r4, one on h2, zero on the 14-test Baton run and on r2). The lead did not undo the speculative work it received.

## Sources

Figures above are taken from these files and chats. No secret values are copied here. `tmp/` is gitignored; those journals are local run artifacts, not part of the tree.

Files:

- `docs/history.md` — early design log, including offline estimates
- `CHANGELOG.md`
- `README.md`
- `evals/reatom-2048/README.md`
- `evals/reatom-2048/prompt.txt`
- `evals/reatom-2048/hidden/e2e.test.ts`
- `tmp/run.mjs`
- `tmp/oracle-grade.json`
- `tmp/*/.run/status.json`
- `tmp/*/.pi/baton/sessions/*/summary.json`
- `tmp/bash-timeout-extension.js` (the 60-second bash cap on r4)

Chats:

- `d53765ca-9033-478e-a0b4-db80eb0a84d5` — architecture review; Run L; no live run yet at `a69d368`
- `c103fca1-f6c4-429a-9636-479ef79e53a0` — Tetris code review
- `a3dcab7b-55f3-4bcf-9388-9c8cdc46e558` — 14-test grades; calls those runs medium
- `182460a0-2566-4cfd-8e09-82daa60ab3dd` — r2/r4 grades and the `won` / `move('right')` analysis
- `47bb878f-1882-43b0-b25a-05947787bb2b`
- `5a502959-ab3c-44bb-bc26-256233982435`
- `13906edd-fdb9-4c81-b91d-9d3b5bb0d63e`
- `175d0f49-9e0c-41f4-80f6-b24d844f8b70`
- `dad2119b-7506-44ae-b727-11c979519a11`
- `0e3bc537-7f02-4b68-9646-8d33b7e371d5`

Commits named in the text: `a69d368`, `22c49b2`, `a27060d`, `064c683`, `1a149b3`, `a023830b`, `a43b92c6`, `da691759`, `f0e4ee53`, `961a63a9`.
