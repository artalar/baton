# Evals for LLM efficiency (performance and cost)

Research snapshot: 14 Oct 2026. For a coding agent that should **build a module until tests pass** over about **50–100 steps**, and be scored on **accuracy and dollars**, not pass rate alone.

## TL;DR

The closest public eval to “build a module that passes tests” is **FeatureBench** (200 Python feature tasks, 500-step cap, F2P/P2P tests, token I/O published). Pair it with **Web-Bench** (50 web apps × 20 sequential features) or **Commit0** / **NL2Repo-Bench** if you want from-scratch libraries.

**SWE-bench Verified is the wrong primary score.** It is saturated (~77–79%), contaminated, and mostly 1–2 file bugfixes. OpenAI stopped reporting it in February 2026.

The only public boards that already print **$ next to accuracy** are Terminal-Bench, SWE-rebench, Verified bash-only (mini-SWE-agent), TheAgentCompany, OpenHands Index, and Artificial Analysis. CursorBench 4.0 is the most realistic IDE eval and does report $, but it is private.

Report **pass@1, median $ per attempt, $ per resolved, tokens split by cache**, and a Pareto plot. Fix the step and dollar caps before comparing systems.

---

## Shortlist (use these)

Ranked for closeness to 50–100-step module work **and** whether you can measure cost.

### 1. FeatureBench — best match

| | |
| --- | --- |
| What | Implement a callable feature in a real repo (L1) or from scratch (L2). Spec includes interface, imports, and behavior. |
| Org / year | CASIA + Huawei, 2026. [arxiv 2602.10975](https://arxiv.org/abs/2602.10975) · [github.com/LiberCoders/FeatureBench](https://github.com/LiberCoders/FeatureBench) |
| Size | 200 tasks + 3,825 environments from 24 Python repos. Lite set: 30 (they made it because a full run burns ~1M input tokens). |
| Horizon | **500-step cap.** Raising the cap from 50 → 100 helps; beyond 100 the gains flatten. |
| Grader | Hidden F2P + P2P pytest. Resolved = all tests pass. Also report Passed Rate (partial). |
| Scale vs SWE-bench | Gold patch **790 lines / 15.7 files / 29 functions** vs SWE-bench **33 lines / 1.7 files**. Problem text ~4,800 words vs 195. |
| Cost | **Token I/O is a first-class metric.** Claude Code + Opus 4.5: **11.0%** resolved, **7.5M / 34k** tokens. Codex + GPT-5.1-Codex: **12.5%**, **6.3M / 39k**. |
| Open | Yes. |

This is the eval that looks like “write the module, run tests, keep going.”

### 2. Web-Bench — sequential product build

| | |
| --- | --- |
| What | 50 web projects, each split into **20 ordered tasks**. Each task adds the next feature of the same app. |
| Org / year | ByteDance, 2025. [arxiv 2505.07473](https://arxiv.org/abs/2505.07473) · [github.com/bytedance/web-bench](https://github.com/bytedance/web-bench) |
| Horizon | 20 dependent generations per project. Authors estimate **4–8 hours** for a senior engineer per project. |
| Grader | Project tests. Pass@1. Claude 3.7 Sonnet **25.1%** on their Web-Agent (they contrast that with ~65% Verified at the time). |
| Cost | Not the official metric. Log it yourself. |
| Open | Yes. |

Closest public “build the product in sequence” suite.

### 3. Commit0 — rebuild a library

| | |
| --- | --- |
| What | Implementation is deleted. Agent fills a Python library back in from the spec + starter, with interactive test feedback. |
| Org / year | Cornell + Cohere, ICLR 2025. [arxiv 2412.01769](https://arxiv.org/abs/2412.01769) · [commit-0.github.io](https://commit-0.github.io/) |
| Size | 54 libraries (lite 16 / 3,628 tests; all 56 / 140,926 tests on the live board). |
| Horizon | Multi-turn until tests pass. Step counts unpublished. |
| Grader | Unit tests **are visible** (unlike SWE-bench). Metric = fraction of tests passed + repos fully solved. Nobody finished a whole library in the paper. OpenHands lite ~41% of tests, 2/16 repos. |
| Cost | No dollar column on the Commit0 board. **OpenHands Index** reports $ and runtime on this slice. |
| Open | Yes. |

Caveat: visible tests let the agent hill-climb the grader.

### 4. NL2Repo-Bench — empty workspace to a repo

| | |
| --- | --- |
| What | Spec (~19k tokens) → installable Python library. |
| Org / year | 2025. [arxiv 2512.12730](https://arxiv.org/abs/2512.12730) |
| Size | 104 tasks. |
| Horizon | Paper: planning over **hundreds of steps**. GPT-5 is the only model they report with an **average under 100 turns**. |
| Grader | Original upstream pytest. Best agents **<40%** average test-pass; few finish a whole repo. |
| Cost | Not extracted from the paper. Log it. |
| Open | Yes. |

### 5. LoopsBench — module work as a DAG

| | |
| --- | --- |
| What | Each task is a dependency DAG of separately testable development units. Tests unlock along the ready frontier; finished nodes stay as regression obligations. |
| Org / year | Microsoft, 2026. [arxiv 2608.00267](https://arxiv.org/abs/2608.00267) · `microsoft/Loopsbench` |
| Size | 112 tasks, 8 languages, 9 domains, **>5,300 units**. |
| Horizon | Sustained loop, not one PR. Strongest config: **Opus 4.7 + Claude Code + outer continuation, 25%** resolve. |
| Cost | Mean billed tokens per task in the appendix. |
| Open | Yes. |

This is the one that measures whether the agent **keeps a plan** across a module, not just one patch.

### 6. SWE-Lancer Diamond — real freelance features

| | |
| --- | --- |
| What | Real Upwork jobs on Expensify. IC tasks: implement the fix/feature. Manager tasks: pick the winning proposal. |
| Org / year | OpenAI, ICML 2025. [arxiv 2502.12115](https://arxiv.org/abs/2502.12115) |
| Size | Diamond: 502 tasks, **$500,800** of real payouts (237 IC). Public offline IC set later trimmed to 198. |
| Horizon | Human jobs from **15 minutes to weeks**, $50–$32,000. Agent step counts unpublished. |
| Grader | Engineer-written **end-to-end** tests, not just unit tests. |
| Cost | Headline metric is **client payout earned**. Paper also reports API spend for some GPT-4o / o1 runs. Claude 3.5 Sonnet: **26.2%** IC Diamond (**$58k / $236k**). |
| Open | Diamond yes. Full set no. |

One product (Expensify), so treat it as a deep single-app eval, not a language spread.

### 7. Terminal-Bench 2.0 / 2.1 / 4.0 — best public $ leaderboard

| | |
| --- | --- |
| What | Instruction in a Docker terminal. Final filesystem must pass author tests. Mix of SWE, sysadmin, data, security. |
| Org / year | Stanford + Laude. Paper: [arxiv 2601.11868](https://arxiv.org/abs/2601.11868). Live: [tbench.ai](https://www.tbench.ai/). Runner: Harbor. |
| Size | 2.0 = 89 tasks. 4.0 deleted saturated tasks and set an **8-hour** timeout. |
| Horizon | Most 2.0 trials **<25 model calls and <20 minutes**. Tail: **hundreds of calls, ~2 hours, ~100M tokens**. |
| Cost | **Yes.** Full 2.0 run ~$1–$100 by model. 2.1 and 4.0 boards have cost and token columns. Anthropic (Sep 2026): Opus 5.5 + Claude Code **66.4%** on 4.0. |
| Open | Yes. |

Use it for efficiency comparisons. Do not treat it as “build a product”: many tasks are puzzle-like ops.

### 8. Artificial Analysis Coding Agent Index — composite $ board

| | |
| --- | --- |
| What | Equal-weight pass@1 on DeepSWE v1.1 (113 × 3), Terminal-Bench 4.0 (66 × 3), SWE-Atlas-QnA (124 × 3). |
| URL | [artificialanalysis.ai/agents/coding-agents](https://artificialanalysis.ai/agents/coding-agents) |
| Cost | Pooled API $ per task: uncached input, cache read, cache write, output. Also time, turns, tokens, cache hit. |
| Snapshot | Codex + GPT-6.1 Sol (xhigh): index **63**, **$1.04**/task, 15.5 min, 40 turns, 3.2M tokens, 93% cache. Opencode + GLM-5.3: **54**, **$4.24**, 48 min, 107 turns, 14.3M tokens. |

Best place to read **accuracy vs $ vs time** for product agents. Not a from-scratch module suite by itself.

---

## Also worth running (adjacent)

| Eval | Why | Horizon | Cost? | Caveat |
| --- | --- | --- | --- | --- |
| [CursorBench 4.0](https://cursor.com/cursorbench) | Real Cursor sessions. Mean **41–324 steps** (Opus 5.5 Max **185**, **$13.43**, 57.8%). | 50–200+ | Yes | **Private.** You cannot rerun it. |
| [DeepSWE](https://arxiv.org/abs/2607.07946) | 113 original tasks, 91 repos, 5 languages. Hidden behavioral tests. 2.5 h wall cap, no step cap. | Hours | In AA Index | Not a dollar table in the paper. |
| [SWE-bench Pro](https://arxiv.org/abs/2509.16941) | Hours-to-days issues, mean gold **107 lines / 4.1 files**. Public 731. | 250-turn cap | Rarely | OpenAI (Jul 2026) later called ~30% of public tasks broken. |
| [SWE-rebench](https://swe-rebench.com/) | Fresh monthly issues. Live board: ~**60–65%** at **$0.41–$4.40**, 0.6–5.5M tokens. | Unpublished cap | **Yes** | Still issue→patch, not module-from-scratch. |
| [OpenHands Index](https://www.openhands.dev/blog/openhands-index) | Same scaffold on Verified + Multimodal + **Commit0** + SWT-Bench + GAIA. | Per category | **Yes** | SWE-bench slice is the saturated one. |
| [TheAgentCompany](https://the-agent-company.com) | 175 workplace tasks. Gemini 2.5 Pro **30.3% / $4.2 / 27 steps**. | **15–40 steps** | **Yes** | Too short for the 50–100 target. |
| [WebGen-Bench](https://github.com/mnluzimu/WebGen-Bench) | Website from scratch, browser-agent tests (647 cases). Best paper: 27.8%. | Unpublished | No | UI, not a backend module. |
| ProjectEval / [ProjDevBench](https://arxiv.org/abs/2602.01655) | 20 small Python projects / from-scratch repos. | Short / staged | No | Tiny n. |
| [RoadmapBench](https://arxiv.org/abs/2605.15846) | 115 version-upgrade tasks, median **3,700 lines / 51 files**. Opus 4.7 **39.1%**. | Longer than 100 | Unknown | Overshoots “one module.” |
| [SWE-Marathon](https://www.swe-marathon.org/) | 20 Harbor tasks. Median **2,347 steps**, 27M tokens. Frontier **<30%**. | Too long | Tokens | Use if you want multi-hour, not 50–100. |
| [Long-Horizon-Terminal-Bench](https://arxiv.org/abs/2607.08964) | 46 tasks. ~231 episodes, 9.9M tokens, 85 min. Grok 4.5 **28.3%** at R≥0.95. | Hundreds of episodes | Tokens + time | Terminal, dense reward. |
| [SWE-EVO](https://arxiv.org/abs/2512.18470) | Repo evolution. GPT-5.4 **25%** at 100-iteration cap vs ~73% Verified. | 100 iters | Unknown | Long, but still SWE-shaped. |
| [GitTaskBench](https://arxiv.org/abs/2508.18993) | 54 tasks, cost-aware α. | Agent loop | Partial | Small n. |
| [FrontierCode](https://cognition.com/blog/frontier-code) | “Would the maintainer merge?” 150 tasks. | Unpublished | Tokens (qualitative) | Private. |
| [HackerRank Bench](https://www.hackerrank.com/bench) | Commercial long-horizon, hidden verifiers. | Unpublished | Unknown | Not downloadable. |
| [LongCLI-Bench](https://arxiv.org/abs/2602.14337) | 20 CLI tasks: from-scratch / feature / bug / refactor. F2P+P2P. Frontier **<20%**. | Long | Unknown | n=20. |
| Verified **bash-only** (mini-SWE-agent) | Official $ and call counts. Opus 4.5 high **76.8% / $0.75 / 33 calls**. MiniMax M2.5 **75.8% / $0.07 / 61 calls**. | Usually <50 | **Yes** | Same saturated bugfix set. Useful only as a **cheap calibration**. |

---

## Skip as the primary efficiency score

| Eval | Why |
| --- | --- |
| SWE-bench Verified (vendor scaffolds) | Saturated (~79%). OpenAI (Feb 2026): 59% of remaining failures had bad tests; models emit gold patches. |
| SWE-bench Lite / full | Same task, worse contamination story. Official boards do not report $. |
| Aider polyglot | 225 Exercism files, **two tries**. GPT-5 high 88% / $29 per 225. Toy. |
| LiveCodeBench, BigCodeBench, SciCode, FullStackBench, HumanEval | One generation. Contest or function tests. |
| RepoBench, CrossCodeEval | Next-line completion. |
| Design2Code, Web2Code, ArtifactsBench, WebDev Arena | UI preference / screenshots, not hidden tests. |
| GAIA, τ-bench, WebArena, OSWorld, AndroidWorld, MCP benches | Tool-use. Typically <30 actions. Do not answer “did the module pass tests?” |

---

## How labs actually report efficiency

There is no standard scalar “agent efficiency score.” What people publish:

| Metric | Definition | Who |
| --- | --- | --- |
| Resolve / pass@1 | Hidden tests all green, one attempt | Everyone |
| pass@k | ≥1 of k samples passes | SWE-agent, Large Language Monkeys |
| pass^k | **All** k trials pass | τ-bench; use this for unattended merge |
| $ / instance | Total API $ ÷ tasks, **failures included** | SWE-bench bash-only, Terminal-Bench, AA |
| $ / resolved | Total $ ÷ successes | Derive it. SWE-agent paper averaged **only successes** — that understates the bill. |
| Tokens / success | Split uncached / cache-read / cache-write / output | AA, FeatureBench, SWE-rebench |
| Pareto (accuracy vs $) | No other run is both better and cheaper | HAL, Cursor Composer 2, AA |
| Steps / wall clock | `instance_calls`; Harbor splits agent vs verifier time | mini-SWE-agent, Terminal-Bench |

Concrete calibration (Verified bash-only, 500 instances, Feb 2026): MiniMax M2.5 and Gemini 3 Flash both **75.8%**, at **$0.073 vs $0.356** per instance. Same quality, 5× cost. That is the plot you want.

HAL (Princeton, 50-task mini) and Artificial Analysis are the two public Pareto dashboards. HAL warned (5 Oct 2026) that nested spans can **double** some dollar rows.

---

## Recommended metric set for a 50–100 step module eval

Headline, all on the same attempts:

1. **Official pass@1** (hidden tests). Separately log whether the agent’s own tests were green.
2. **Median and mean $ per attempt**, failures included, from a **frozen rate card** (input, output, cache read, cache write 5m/1h, reasoning).
3. **$ per resolved** = Σ$ / N_resolved, plus a bootstrap interval. n≈30 (FeatureBench Lite) is noisy.
4. **Tokens per resolved**, split as above.
5. **Pareto**: pass@1 vs median $ per attempt, one point per scaffold × model × effort. Label the step cap and $ cap on the point.

Log, do not fold into the score:

- Steps and wall clock to first green vs official pass
- Which cap fired (submit / step / $ / context)
- Tool error rate and repeated identical calls
- PCost vs FCost (successes are usually cheaper)
- pass@k and pass^k at a **fixed dollar budget**, not a fixed k
- Human interventions per success, if allowed

A 50-step run and a 100-step run are different products. Reprice old logs when prices move; keep the original invoice beside the repriced one.

Inspect’s convention: `input_tokens` is **uncached**. Braintrust’s `prompt_tokens` **includes** cache. Mixing them double-counts.

---

## Practical recipe

If you are measuring Baton-style (or any two-model) efficiency on realistic module work:

1. **Primary:** FeatureBench Lite (30) for iteration, Full (200) for the paper number. Cap at **100 steps** and a frozen $ cap. Hide F2P/P2P from the agent.
2. **Secondary:** Web-Bench (one or two projects, all 20 steps) if you care about product sequencing; Commit0 lite if you care about library-from-spec.
3. **Cost board:** rerun the same scaffold on Terminal-Bench 2.1 (or SWE-rebench’s current window) so you can compare to public $ rows.
4. **Do not** lead with SWE-bench Verified except as a cheap sanity check against the bash-only table.

Harbor is the practical runner for Terminal-Bench and several SWE-style sets: [harborframework.com](https://www.harborframework.com/docs/tutorials/running-terminal-bench).
