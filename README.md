# Baton

A [pi](https://github.com/earendil-works/pi) extension that lets a cheap executor model (default GLM-5.3-Flash) do the work, and calls a strong advisor model (default Claude Opus 5.5) only at the moments that matter: to plan, to get unstuck, and to review before a commit. It keeps the executor's context small with a deterministic tool journal and output masking.

## What it does

- **Journal.** Every tool call is written to `.pi/baton/events.jsonl`. Each record has `evt#`, `ts`, `tool`, an args digest (write/edit bodies are hashed, not stored), the exit code, the head and tail of the output, an error signature, files read and written, a test summary, and a `rawRef` to the full output in `.pi/baton/raw/<evt>.txt`.
- **Masking.** In every request to the model (pi's `context` event; the session file itself stays complete), every tool output the model has already answered is replaced by a stub such as `[baton: output masked. evt#12 bash command=npm test → exit 1, 830 tok …]`. Earlier reads of a file that was read again are dropped as duplicates. Reads of a file that was edited afterwards are dropped as stale. `baton_recall({evt})` returns the full output.
- **Advisor tools.** Each one builds a pack (≈40k token budget, estimated as chars/4), calls the advisor once with prompt caching disabled, and validates the JSON reply against a schema (`verdict`, `facts_corrected`, `plan[]` steps with `done_when`, `do_not_retry`, `test_cmd`). An invalid reply gets one retry.
  - `baton_review`: the executor's narrative is excluded. The pack holds the task, the user prompts verbatim, `git diff`, the changed files and the last test run. The resulting plan is appended to the conversation.
  - `baton_help`: the pack holds the last N (default 8) tool calls verbatim, earlier calls with the same error signature, the executor's hypothesis and attempts, and the evt#s it marked as important.
  - `baton_plan`: the pack holds the task, `AGENTS.md` and a repo map.
  - After help or plan, the executor's context is **reset** to task + plan + the last 2 turns. Baton does this by appending a `compaction` entry at `turn_end`.
- **Safety triggers.** These are deterministic `Baton:` nudge messages:
  - context ≥60%;
  - the same error signature 3×;
  - a reminder after 25 tool calls without an advisor call;
  - a cooldown between nudges.
  - `git commit` is **blocked** until `baton_review` returns `on_track` or `done`. New edits revoke the pass.
- **Auto-compaction.** pi's threshold and overflow compaction is replaced by a deterministic, no-LLM Baton summary (task, prompts, last plan, timeline). This is configurable.
- **Optional judge** (off by default). A Jev-format classifier (`typesafe/jev-latest` via pi's `modelRegistry.classify`) decides include/drop only for medium-importance events in the help pack. Heuristics are the fallback.
- **Skill** `baton` and prompt `/baton-plan` tell the executor when to call which tool. The same guidance goes into the system prompt as tool guidelines. Command: `/baton` (status) and `/baton reset`.

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
| `triggers.contextRatio` / `sameErrorCount` / `remindEvery` / `minGapCalls` | `0.6` / `3` / `25` / `5` |
| `triggers.reviewBeforeCommit` | `true` |
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

0.1.0 is an early version. The type-checked code, the unit tests and the extension loading in pi's real loader are verified. Not verified yet: an end-to-end session with real GLM and Opus keys.

- Token counts are estimates (chars/4); pi has no public tokenizer.
- Masking rewrites the prefix of the request, which breaks prompt caching. That is cheap for GLM but would be costly for Anthropic executors. Stubs are stable, so the prefix only changes once per batch.
- Test-summary parsing is regex based (vitest/jest/pytest/cargo/go). Other runners only get exit codes.
- The reset relies on `turn_end` compaction entries. If pi rejects the entry, use `/baton reset`.
- The Jev judge only covers the help-pack timeline. Its question format follows pi's `ClassifierContext` types, but it has not been run against the TypeSafe API.
- `executor` in the config is informational. Baton never switches models.

## По-русски

Baton — расширение для pi. Дешёвая модель-исполнитель (GLM-5.3-Flash) пишет код, а сильный советник (Opus 5.5) вызывается разово и без кэша, только для плана (`baton_plan`), помощи (`baton_help`) и ревью (`baton_review`).

- Все вызовы инструментов пишутся в `.pi/baton/events.jsonl`.
- Уже прочитанные выводы в запросе заменяются заглушками `evt#`; полный вывод возвращает `baton_recall`.
- После help и plan контекст сбрасывается до «задача + план + 2 последних хода».
- Страховки:
  - контекст ≥60%;
  - одна и та же ошибка 3 раза;
  - `git commit` заблокирован до успешного ревью;
  - напоминание после 25 вызовов.
- Установка: `pi install git:github.com/artalar/baton`, а локально — `pi -e ./src/index.ts`.
- Конфиг: `~/.pi/agent/baton.json` и `.pi/baton.json`, в них только id моделей. Ключи берутся из pi (`auth.json` или env).
- Статус: ранняя версия. Типы и юнит-тесты проверены, на реальных ключах end-to-end не проверялось.

## License

MIT
