#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const hiddenDir = dirname(fileURLToPath(import.meta.url))
const evalRoot = resolve(hiddenDir, '..')

const STATIC_MARKERS = [
  'reatom-2048/hidden',
  'reatom-2048/oracle',
  'e2e.test.ts',
  'grade.mjs',
  'audit-session',
  'playwright.config.ts',
  'window.__eval',
  '__grade_',
]

const PATH_TOOLS = new Set(['read', 'edit', 'write', 'ls', 'find', 'grep'])
const SYSTEM_PREFIXES = ['/usr/', '/bin/', '/opt/homebrew/', '/tmp/', '/private/tmp/', '/var/folders/']
const SYSTEM_EXACT = new Set([
  '/usr',
  '/bin',
  '/opt/homebrew',
  '/tmp',
  '/private/tmp',
  '/var/folders',
  '/dev/null',
])
const FILESYSTEM_ROOTS = new Set([
  'Applications',
  'Library',
  'System',
  'Users',
  'Volumes',
  'bin',
  'cores',
  'dev',
  'etc',
  'home',
  'mnt',
  'nix',
  'opt',
  'private',
  'proc',
  'run',
  'tmp',
  'usr',
  'var',
])

const SKIPPED = {
  ok: true,
  skipped: 'no session logs',
  toolCalls: 0,
  violations: [],
  warnings: [],
  sources: [],
}

export function auditSession(workspaceDir) {
  const workspace = resolve(workspaceDir)
  const loaded = loadSources(workspace)
  if (loaded.sources.length === 0) return { ...SKIPPED, violations: [], warnings: [], sources: [] }

  const markers = markerList()
  const roots = workspaceRoots(workspace)
  const violations = []
  const warnings = []
  const seen = new Set()

  for (const call of loaded.calls) {
    const argumentText = []
    collectStrings(call.arguments, argumentText)
    for (const marker of markers) {
      const excerpt = firstExcerpt([...argumentText, ...call.results], marker)
      if (!excerpt) continue
      addFinding(seen, violations, {
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        model: call.model,
        reason: `hidden marker: ${marker}`,
        excerpt,
      })
    }

    if (PATH_TOOLS.has(call.toolName)) {
      for (const pathValue of pathArguments(call.toolName, call.arguments)) {
        const kind = classifyPath(workspace, roots, pathValue)
        if (!kind) continue
        addFinding(seen, kind === 'eval' ? violations : warnings, {
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          model: call.model,
          reason: kind === 'eval' ? 'path inside evals/reatom-2048' : 'path outside workspace',
          excerpt: clip(pathValue),
        })
      }
    }

    if (call.toolName === 'bash') {
      const command = bashCommand(call.arguments)
      if (command) bashFindings(call, command, roots, seen, warnings)
    }
  }

  return {
    ok: violations.length === 0,
    toolCalls: loaded.calls.length,
    violations,
    warnings,
    sources: loaded.sources,
  }
}

function loadSources(workspace) {
  const sources = []
  const calls = new Map()
  let missingId = 0

  const sessionDir = resolve(workspace, '.pi', 'sessions')
  if (existsSync(sessionDir)) {
    const files = readdirSync(sessionDir)
      .filter((name) => name.endsWith('.jsonl'))
      .sort()
    for (const name of files) {
      const abs = resolve(sessionDir, name)
      sources.push(posixRelative(workspace, abs))
      readJsonl(abs, (event) => ingestSession(event, calls, () => `missing:${++missingId}`))
    }
  }

  for (const name of ['events.jsonl', 'events-continue.jsonl']) {
    const abs = resolve(workspace, '.run', name)
    if (!existsSync(abs)) continue
    sources.push(posixRelative(workspace, abs))
    readJsonl(abs, (event) => ingestEvents(event, calls, () => `missing:${++missingId}`))
  }

  return { sources, calls: [...calls.values()] }
}

function ingestSession(event, calls, nextMissing) {
  if (event?.type !== 'message' || !event.message) return
  const message = event.message
  if (message.role === 'assistant' && Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part?.type !== 'toolCall') continue
      const call = ensureCall(calls, part.id, nextMissing)
      fillCall(call, {
        toolName: part.name,
        model: message.model,
        arguments: normalizeArgs(part.arguments),
      })
    }
  }
  if (message.role === 'toolResult') {
    const call = ensureCall(calls, message.toolCallId, nextMissing)
    fillCall(call, { toolName: message.toolName })
    for (const text of contentTexts(message.content)) pushResult(call, text)
  }
}

function ingestEvents(event, calls, nextMissing) {
  if (event?.type === 'tool_execution_start') {
    const call = ensureCall(calls, event.toolCallId, nextMissing)
    fillCall(call, { toolName: event.toolName, arguments: normalizeArgs(event.args) })
  }
  if (event?.type === 'tool_execution_end') {
    const call = ensureCall(calls, event.toolCallId, nextMissing)
    fillCall(call, { toolName: event.toolName })
    for (const text of resultTexts(event.result)) pushResult(call, text)
  }
}

function ensureCall(calls, id, nextMissing) {
  const key = id === undefined || id === null || id === '' ? nextMissing() : String(id)
  let call = calls.get(key)
  if (!call) {
    call = { toolCallId: key, toolName: '', model: null, arguments: undefined, results: [] }
    calls.set(key, call)
  }
  return call
}

function fillCall(call, patch) {
  if (patch.toolName && !call.toolName) call.toolName = String(patch.toolName)
  if (typeof patch.model === 'string' && patch.model && !call.model) call.model = patch.model
  if (patch.arguments !== undefined && call.arguments === undefined) call.arguments = patch.arguments
}

function pushResult(call, text) {
  if (typeof text !== 'string' || call.results.includes(text)) return
  call.results.push(text)
}

function normalizeArgs(value) {
  if (typeof value !== 'string') return value
  try {
    const parsed = JSON.parse(value)
    if (parsed && typeof parsed === 'object') return parsed
  } catch {
    return value
  }
  return value
}

function contentTexts(content) {
  if (!Array.isArray(content)) return []
  const texts = []
  for (const part of content) {
    if (part?.type === 'text' && typeof part.text === 'string') texts.push(part.text)
  }
  return texts
}

function resultTexts(result) {
  if (typeof result === 'string') return [result]
  if (!result || typeof result !== 'object') return []
  const texts = contentTexts(result.content)
  const output = result.structuredContent?.output
  if (typeof output === 'string') texts.push(output)
  const details = result.details
  if (details && typeof details === 'object') {
    if (typeof details.diff === 'string') texts.push(details.diff)
    if (typeof details.patch === 'string') texts.push(details.patch)
  }
  return texts
}

function readJsonl(file, onEvent) {
  const text = readFileSync(file, 'utf8')
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      onEvent(JSON.parse(line))
    } catch {
      continue
    }
  }
}

function markerList() {
  const source = readFileSync(resolve(hiddenDir, 'e2e.test.ts'), 'utf8')
  const titles = []
  const re = /\btest\(\s*(['"])([\s\S]*?)\1/g
  let match
  while ((match = re.exec(source))) {
    if (match[2]) titles.push(match[2])
  }
  return [...new Set([...STATIC_MARKERS, ...titles])]
}

function workspaceRoots(workspace) {
  const roots = [workspace]
  const statusPath = resolve(workspace, '.run', 'status.json')
  if (!existsSync(statusPath)) return roots
  try {
    const status = JSON.parse(readFileSync(statusPath, 'utf8'))
    if (typeof status.cwd === 'string' && status.cwd.trim()) {
      const recorded = resolve(status.cwd)
      if (!roots.includes(recorded)) roots.push(recorded)
    }
  } catch {
    return roots
  }
  return roots
}

function pathArguments(toolName, args) {
  if (!args || typeof args !== 'object') return []
  const keys = toolName === 'find' ? ['path', 'pattern'] : ['path']
  const values = []
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) values.push(value.trim())
  }
  return values
}

function classifyPath(workspace, roots, pathValue) {
  const resolved = resolveAgainst(workspace, pathValue)
  if (roots.some((root) => isInside(root, resolved))) return null
  if (isInside(evalRoot, resolved)) return 'eval'
  return 'outside'
}

function bashCommand(args) {
  if (!args || typeof args !== 'object') return ''
  return typeof args.command === 'string' ? args.command : ''
}

function bashFindings(call, command, roots, seen, warnings) {
  for (const word of shellWords(command)) {
    const raw = word.replace(/[,)]+$/g, '')
    if (!raw) continue
    if (hasDotDot(raw)) {
      addFinding(seen, warnings, finding(call, 'bash path contains ..', raw))
      continue
    }
    const expanded = expandUser(raw)
    for (const candidate of absoluteCandidates(expanded)) {
      if (isSystemPath(candidate)) continue
      const resolved = resolve(candidate)
      if (roots.some((root) => isInside(root, resolved))) continue
      addFinding(seen, warnings, finding(call, 'bash absolute path outside workspace', candidate))
    }
  }
}

function finding(call, reason, excerpt) {
  return {
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    model: call.model,
    reason,
    excerpt: clip(excerpt),
  }
}

function shellWords(command) {
  const words = []
  let current = ''
  let quote = ''
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = ''
      else current += char
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (/[\s;|&>()]/.test(char)) {
      if (current) words.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (current) words.push(current)
  return words
}

function absoluteCandidates(word) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(word)) return []
  const found = []
  for (let index = 0; index < word.length; index++) {
    if (word[index] !== '/' || word[index + 1] === '/') continue
    const previous = index > 0 ? word[index - 1] : ''
    if (previous && !/[\s"'`=:(]/.test(previous)) continue
    const candidate = takeAbsolute(word, index)
    if (!isFilesystemAbsolute(candidate)) continue
    found.push(candidate)
    index += candidate.length
  }
  return found
}

function takeAbsolute(text, start) {
  let end = start + 1
  while (end < text.length) {
    const char = text[end]
    const next = text[end + 1] ?? ''
    if (char === ' ' && /[^"'`\s;|&<>()]/.test(next)) {
      end += 1
      continue
    }
    if (/[\s"'`;|&<>()]/.test(char)) break
    end += 1
  }
  return text.slice(start, end).replace(/[,)]+$/g, '')
}

function isFilesystemAbsolute(value) {
  if (!value.startsWith('/') || value.startsWith('//') || value === '/') return false
  const first = value.split('/').filter(Boolean)[0]
  return Boolean(first && FILESYSTEM_ROOTS.has(first))
}

function hasDotDot(value) {
  return value.split(/[\\/]/).includes('..')
}

function expandUser(value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/')) return resolve(homedir(), value.slice(2))
  return value
}

function resolveAgainst(workspace, value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/')) return resolve(homedir(), value.slice(2))
  return resolve(workspace, value)
}

function isSystemPath(value) {
  if (SYSTEM_EXACT.has(value) || value.startsWith('/dev/null')) return true
  return SYSTEM_PREFIXES.some((prefix) => value.startsWith(prefix))
}

function isInside(parent, child) {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function collectStrings(value, out) {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out)
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, out)
  }
}

function firstExcerpt(texts, marker) {
  for (const text of texts) {
    const index = text.indexOf(marker)
    if (index !== -1) return excerptAround(text, index, marker.length)
  }
  return ''
}

function excerptAround(text, index, length) {
  const start = Math.max(0, index - 80)
  const end = Math.min(text.length, index + length + 80)
  return clip(text.slice(start, end).replace(/\s+/g, ' ').trim())
}

function clip(value) {
  const text = String(value).replace(/\s+/g, ' ').trim()
  return text.length <= 200 ? text : text.slice(0, 200)
}

function addFinding(seen, list, item) {
  const key = `${item.toolCallId}\0${item.reason}\0${item.excerpt}`
  if (seen.has(key)) return
  seen.add(key)
  list.push(item)
}

function posixRelative(workspace, abs) {
  return relative(workspace, abs).split(sep).join('/')
}

function isDirectRun() {
  const entry = process.argv[1]
  if (!entry) return false
  return fileURLToPath(import.meta.url) === resolve(entry)
}

function parseArgs(argv) {
  const out = {}
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]
    if (!token?.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) out[key] = true
    else {
      out[key] = next
      index += 1
    }
  }
  return out
}

function required(value, flag) {
  if (!value || value === true) {
    console.error(`missing ${flag}`)
    process.exit(2)
  }
  return value
}

if (isDirectRun()) {
  const args = parseArgs(process.argv.slice(2))
  if (args.help === true) {
    console.log(`usage: bun evals/reatom-2048/hidden/audit-session.mjs --cwd <workspace>

Prints { ok, toolCalls, violations, warnings, sources } and exits 0 when there are no violations.`)
    process.exit(0)
  }
  const cwd = resolve(required(args.cwd, '--cwd'))
  const result = auditSession(cwd)
  console.log(JSON.stringify(result, null, 2))
  process.exit(result.ok ? 0 : 1)
}
