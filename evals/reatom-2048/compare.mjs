#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { diffArrays } from 'diff'

const evalRoot = dirname(fileURLToPath(import.meta.url))
const starterDir = join(evalRoot, 'starter')
const gradeScript = join(evalRoot, 'hidden', 'grade.mjs')

const SKIPPED_DIRS = new Set(['node_modules', '.git', '.pi', '.pi-agent', '.run', '.agents', 'dist', 'test-results'])
const EXPECTED_EXTRA_FILES = new Set(['.prepared', 'bun.lock', 'package-lock.json'])
const PRODUCT_EXTENSIONS = /\.(ts|tsx|js|jsx|css)$/

const argv = process.argv.slice(2)
const flags = new Set(argv.filter((arg) => arg.startsWith('--')))
const workspaces = argv.filter((arg) => !arg.startsWith('--')).map((path) => resolve(path))
if (flags.has('--help') || workspaces.length === 0) {
  console.log(`usage: bun evals/reatom-2048/compare.mjs <workspace>... [--regrade] [--no-grade] [--json]

Compares agent workspaces of this eval: hidden tests and audit, cost (with Baton
cache keepalives), wall time, requests and tool calls per model, Baton runs,
blocked writes and undos, who wrote the final product code, and leftover files.

The grade is cached in <workspace>/.run/grade.json; --regrade grades again,
--no-grade only reads the cache. "Lead share" counts non-blank lines of src/
written with edit/write by the lead, out of the lines written by either model.`)
  process.exit(workspaces.length === 0 && !flags.has('--help') ? 2 : 0)
}

const reports = workspaces.map(compareWorkspace)
if (flags.has('--json')) console.log(JSON.stringify(reports, null, 2))
else printReports(reports)

function compareWorkspace(workspace) {
  const status = readJson(join(workspace, '.run', 'status.json'))
  const batonJournals = readBatonJournals(workspace)
  const helperModel = withoutRouter(batonJournals.find((journal) => journal.summary?.helper)?.summary.helper)
  const roleOf = (model) => (helperModel && withoutRouter(model) === helperModel ? 'helper' : 'lead')
  const entries = readSessionEntries(workspace)
  return {
    name: relative(process.cwd(), workspace) || workspace,
    grade: gradeOf(workspace),
    stopReason: status?.stopReason ?? null,
    wallSec: status?.elapsedSec ?? null,
    cost: costOf(status, batonJournals, roleOf),
    activity: activityOf(entries, roleOf),
    baton: batonStatsOf(batonJournals),
    authorship: authorshipOf(workspace, entries, roleOf),
    leftovers: leftoversOf(workspace),
  }
}

function gradeOf(workspace) {
  const cachePath = join(workspace, '.run', 'grade.json')
  const cached = readJson(cachePath)
  if (cached && !flags.has('--regrade')) return cached
  if (flags.has('--no-grade')) return null
  const graded = spawnSync('bun', [gradeScript, '--cwd', workspace], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const output = graded.stdout.slice(graded.stdout.indexOf('{'))
  try {
    const result = JSON.parse(output)
    writeFileSync(cachePath, `${JSON.stringify(result, null, 2)}\n`)
    return result
  } catch {
    return { error: (graded.stderr || graded.stdout).trim().split('\n').slice(-5).join('\n') }
  }
}

function costOf(status, batonJournals, roleOf) {
  const byRole = { lead: 0, helper: 0 }
  for (const [model, row] of Object.entries(status?.costs ?? {})) byRole[roleOf(model)] += row.usd ?? 0
  const keepaliveUsd = batonJournals.flatMap((journal) => journal.events).filter((event) => event.kind === 'cache_keepalive').reduce((sum, event) => sum + (event.cost ?? 0), 0)
  return { totalUsd: (status?.totalUsd ?? 0) + keepaliveUsd, leadUsd: byRole.lead + keepaliveUsd, helperUsd: byRole.helper, keepaliveUsd }
}

function activityOf(entries, roleOf) {
  const activity = { lead: { requests: 0, toolCalls: 0, outputTokens: 0 }, helper: { requests: 0, toolCalls: 0, outputTokens: 0 } }
  for (const message of assistantMessages(entries)) {
    const row = activity[roleOf(message.model)]
    row.requests++
    row.toolCalls += toolCallsOf(message).length
    row.outputTokens += message.usage?.output ?? 0
  }
  return activity
}

function batonStatsOf(batonJournals) {
  const summaries = batonJournals.map((journal) => journal.summary).filter(Boolean)
  if (!summaries.length) return null
  const sum = (key) => summaries.reduce((total, summary) => total + (summary.stats?.[key] ?? 0), 0)
  const stopReasons = {}
  for (const summary of summaries) {
    for (const [reason, count] of Object.entries(summary.stats?.stopReasons ?? {})) stopReasons[reason] = (stopReasons[reason] ?? 0) + count
  }
  return { runs: sum('runs'), helperTurns: sum('helperTurns'), blockedWrites: sum('blockedWrites'), undos: sum('undos'), keepalives: sum('cacheKeepalives'), stopReasons }
}

/** Replays successful edit/write calls over the starter files with an author per line, then aligns the result with the files on disk. */
function authorshipOf(workspace, entries, roleOf) {
  const failedCalls = new Set(entries.filter((entry) => entry.message?.role === 'toolResult' && entry.message.isError).map((entry) => entry.message.toolCallId))
  const replayed = new Map()
  const linesOf = (path) => {
    if (!replayed.has(path)) {
      const starterPath = join(starterDir, path)
      replayed.set(path, existsSync(starterPath) ? readFileSync(starterPath, 'utf8').split('\n').map((text) => ({ text, author: 'starter' })) : [])
    }
    return replayed.get(path)
  }
  let missedEdits = 0
  for (const message of assistantMessages(entries)) {
    const author = roleOf(message.model)
    for (const call of toolCallsOf(message)) {
      if (failedCalls.has(call.id) || typeof call.arguments?.path !== 'string') continue
      const path = insideWorkspace(workspace, call.arguments.path)
      if (!path) continue
      if (call.name === 'write' && typeof call.arguments.content === 'string') {
        replayed.set(path, call.arguments.content.split('\n').map((text) => ({ text, author })))
      }
      if (call.name === 'edit') {
        for (const edit of editsOf(call.arguments)) {
          if (!applyEdit(linesOf(path), edit, author)) missedEdits++
        }
      }
    }
  }

  const lines = { lead: 0, helper: 0, starter: 0, unknown: 0 }
  for (const path of productFiles(workspace)) {
    const actual = readFileSync(join(workspace, path), 'utf8').split('\n')
    const replay = linesOf(path)
    let replayIndex = 0
    let actualIndex = 0
    for (const part of diffArrays(replay.map((line) => line.text), actual)) {
      if (part.removed) {
        replayIndex += part.count
        continue
      }
      for (let offset = 0; offset < part.count; offset++) {
        const author = part.added ? 'unknown' : replay[replayIndex + offset].author
        if (actual[actualIndex + offset].trim()) lines[author]++
      }
      actualIndex += part.count
      if (!part.added) replayIndex += part.count
    }
  }
  const written = lines.lead + lines.helper
  return { lines, leadShare: written ? lines.lead / written : null, missedEdits }
}

function applyEdit(lines, { oldText, newText }, author) {
  const current = lines.map((line) => line.text).join('\n')
  const start = current.indexOf(oldText)
  if (start === -1 || !oldText) return false
  const end = start + oldText.length
  const startLine = current.slice(0, start).split('\n').length - 1
  const endLine = current.slice(0, end).split('\n').length - 1
  const lineStartOffset = current.lastIndexOf('\n', start - 1) + 1
  const lineEndOffset = current.indexOf('\n', end) === -1 ? current.length : current.indexOf('\n', end)
  const replacedLines = lines.slice(startLine, endLine + 1)
  const newLines = (current.slice(lineStartOffset, start) + newText + current.slice(end, lineEndOffset)).split('\n')
  const attributed = []
  let oldIndex = 0
  for (const part of diffArrays(replacedLines.map((line) => line.text), newLines)) {
    if (part.removed) {
      oldIndex += part.count
      continue
    }
    for (const [offset, text] of part.value.entries()) attributed.push({ text, author: part.added ? author : replacedLines[oldIndex + offset].author })
    if (!part.added) oldIndex += part.count
  }
  lines.splice(startLine, endLine - startLine + 1, ...attributed)
  return true
}

function editsOf(args) {
  if (Array.isArray(args.edits)) return args.edits.filter((edit) => typeof edit?.oldText === 'string' && typeof edit?.newText === 'string')
  if (typeof args.oldText === 'string' && typeof args.newText === 'string') return [{ oldText: args.oldText, newText: args.newText }]
  return []
}

function productFiles(workspace) {
  return walk(workspace, 'src').filter((path) => PRODUCT_EXTENSIONS.test(path))
}

function leftoversOf(workspace) {
  const starterFiles = new Set(walk(starterDir, ''))
  return walk(workspace, '').filter((path) => !path.startsWith(`src${sep}`) && !starterFiles.has(path) && !EXPECTED_EXTRA_FILES.has(path))
}

function walk(root, dir) {
  const absoluteDir = join(root, dir)
  if (!existsSync(absoluteDir)) return []
  return readdirSync(absoluteDir).flatMap((name) => {
    const path = dir ? join(dir, name) : name
    if (statSync(join(root, path)).isDirectory()) return SKIPPED_DIRS.has(name) ? [] : walk(root, path)
    return [path]
  })
}

function insideWorkspace(workspace, rawPath) {
  const path = relative(workspace, resolve(workspace, rawPath.replace(/^@/, '')))
  return path && !path.startsWith('..') && !isAbsolute(path) ? path : undefined
}

function readSessionEntries(workspace) {
  const dir = join(workspace, '.pi', 'sessions')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .sort()
    .flatMap((name) => readJsonLines(join(dir, name)))
}

function readBatonJournals(workspace) {
  const dir = join(workspace, '.pi', 'baton', 'sessions')
  if (!existsSync(dir)) return []
  return readdirSync(dir).map((id) => ({ summary: readJson(join(dir, id, 'summary.json')), events: readJsonLines(join(dir, id, 'events.jsonl')) }))
}

function assistantMessages(entries) {
  return entries.filter((entry) => entry.type === 'message' && entry.message?.role === 'assistant').map((entry) => entry.message)
}

function toolCallsOf(message) {
  return Array.isArray(message.content) ? message.content.filter((block) => block.type === 'toolCall') : []
}

function withoutRouter(model) {
  return typeof model === 'string' && model.startsWith('openrouter/') ? model.slice('openrouter/'.length) : model
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function readJsonLines(path) {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
}

function printReports(reports) {
  const percent = (value) => (value === null ? '—' : `${Math.round(value * 100)}%`)
  const usd = (value) => `$${value.toFixed(2)}`
  const testsOf = (grade) => (!grade ? 'not graded' : grade.error ? 'grade error' : `${grade.passed}/${grade.passed + grade.failed}`)
  const auditOf = (grade) => (!grade?.audit ? '—' : grade.audit.ok ? `ok (${grade.audit.warnings?.length ?? 0} warn)` : `FAIL (${grade.audit.violations.length})`)
  const rows = reports.map((report) => [
    report.name,
    testsOf(report.grade),
    auditOf(report.grade),
    `${usd(report.cost.totalUsd)} (lead ${usd(report.cost.leadUsd)}, helper ${usd(report.cost.helperUsd)})`,
    report.wallSec === null ? '—' : `${report.wallSec}s`,
    `${report.activity.lead.requests} / ${report.activity.helper.requests}`,
    `${report.activity.lead.toolCalls} / ${report.activity.helper.toolCalls}`,
    report.baton ? `${report.baton.runs} runs, ${report.baton.blockedWrites} blocked, ${report.baton.undos} undos` : '—',
    `${percent(report.authorship.leadShare)} (lead ${report.authorship.lines.lead}, helper ${report.authorship.lines.helper}, unknown ${report.authorship.lines.unknown})`,
    report.leftovers.length ? report.leftovers.join(', ') : 'none',
  ])
  const header = ['run', 'tests', 'audit', 'cost', 'wall', 'requests lead / helper', 'tool calls lead / helper', 'baton', 'lead share of src lines', 'leftover files']
  console.log(`| ${header.join(' | ')} |`)
  console.log(`|${header.map(() => '---').join('|')}|`)
  for (const row of rows) console.log(`| ${row.join(' | ')} |`)
  for (const report of reports) {
    const failedTitles = (report.grade?.tests ?? []).filter((test) => !test.ok).map((test) => test.name)
    const details = [
      `stop: ${report.stopReason ?? '—'}`,
      report.authorship.missedEdits ? `replay missed ${report.authorship.missedEdits} edit(s)` : '',
      report.baton && Object.keys(report.baton.stopReasons).length ? `run stops: ${Object.entries(report.baton.stopReasons).map(([reason, count]) => `${count}× ${reason}`).join('; ')}` : '',
      failedTitles.length ? `failed: ${failedTitles.join('; ')}` : '',
    ].filter(Boolean)
    console.log(`\n${report.name}\n  ${details.join('\n  ')}`)
  }
}
