#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, relative, resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { auditSession } from './audit-session.mjs'

const hiddenDir = dirname(fileURLToPath(import.meta.url))
const evalRoot = resolve(hiddenDir, '..')
const skipTopLevel = new Set(['.pi', '.pi-agent', '.run', 'dist', 'test-results'])

const args = parseArgs(process.argv.slice(2))
if (args.help === true) {
  console.log(`usage: bun evals/reatom-2048/hidden/grade.mjs --cwd <agent-workspace>

Copies the workspace to a temp directory, builds that copy, serves vite preview,
runs the hidden Playwright suite, and audits the original session logs.
Prints { passed, failed, tests, audit } and exits 0 only when every test passes and audit.ok is true.`)
  process.exit(0)
}

const cwd = resolve(required(args.cwd, '--cwd'))
const audit = runAudit(cwd)
let summary = fail('grade', 'did not finish')
let preview
let gradeRoot

try {
  gradeRoot = mkdtempSync(resolve(tmpdir(), 'reatom-2048-grade-'))
  const appDir = resolve(gradeRoot, 'app')
  copyWorkspace(cwd, appDir)
  injectSetup(appDir)
  const build = await run('bun', ['run', 'build'], { cwd: appDir, timeoutMs: 60_000 })
  if (build.code !== 0) {
    summary = fail('build', build.stderr || build.stdout || `exit ${build.code}`)
  } else {
    const port = await freePort()
    const baseUrl = `http://127.0.0.1:${port}`
    const previewLog = { text: '' }
    preview = spawn(
      'bun',
      [
        resolve(appDir, 'node_modules/vite/bin/vite.js'),
        'preview',
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--strictPort',
      ],
      { cwd: appDir, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    preview.stdout?.on('data', (chunk) => appendLog(previewLog, chunk))
    preview.stderr?.on('data', (chunk) => appendLog(previewLog, chunk))
    preview.on('error', (error) => appendLog(previewLog, error.message))

    let previewReady = false
    try {
      await waitForPreview(baseUrl, preview, previewLog)
      previewReady = true
    } catch (error) {
      summary = fail('preview', error instanceof Error ? error.message : String(error))
    }

    if (previewReady) {
      const reportPath = resolve(gradeRoot, 'report.json')
      const playwright = resolve(evalRoot, 'node_modules/.bin/playwright')
      const tested = await run(playwright, ['test', '--config', resolve(hiddenDir, 'playwright.config.ts')], {
        cwd: hiddenDir,
        timeoutMs: 240_000,
        env: {
          ...process.env,
          BASE_URL: baseUrl,
          CI: '1',
          GRADE_JSON: reportPath,
          GRADE_OUTPUT: resolve(gradeRoot, 'output'),
        },
      })
      summary = summarizePlaywright(reportPath, tested)
    }
  }
} catch (error) {
  summary = fail('grade', error instanceof Error ? error.message : String(error))
} finally {
  await stopProcess(preview)
  if (gradeRoot) rmSync(gradeRoot, { recursive: true, force: true })
}

summary.audit = audit
console.log(JSON.stringify(summary, null, 2))
process.exitCode = summary.failed === 0 && summary.passed > 0 && audit.ok ? 0 : 1

function runAudit(workspace) {
  try {
    return auditSession(workspace)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      toolCalls: 0,
      violations: [
        { toolCallId: '', toolName: '', model: null, reason: 'audit failed', excerpt: tail(message, 200) },
      ],
      warnings: [],
      sources: [],
    }
  }
}

function copyWorkspace(source, destination) {
  const sourceRoot = resolve(source)
  cpSync(sourceRoot, destination, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (from) => {
      const rel = relative(sourceRoot, from)
      if (!rel) return true
      const top = rel.split(sep)[0]
      return !skipTopLevel.has(top)
    },
  })
}

function summarizePlaywright(reportPath, tested) {
  let report
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'))
  } catch {
    return fail('playwright', tested.stderr || tested.stdout || `exit ${tested.code}`)
  }

  const tests = []
  for (const suite of report.suites ?? []) collectSpecs(suite, tests)
  if (tests.length === 0) {
    const message = (report.errors ?? [])
      .map((error) => errorText(error.message ?? error))
      .filter(Boolean)
      .join('\n')
    return fail('playwright', message || tested.stderr || tested.stdout || 'no tests ran')
  }

  const passed = tests.filter((test) => test.ok).length
  return { passed, failed: tests.length - passed, tests }
}

function collectSpecs(suite, tests) {
  for (const spec of suite.specs ?? []) {
    const results = (spec.tests ?? []).flatMap((test) => test.results ?? [])
    const result = results.at(-1)
    const ok = result?.status === 'passed'
    if (ok) tests.push({ name: spec.title, ok: true })
    else {
      tests.push({
        name: spec.title,
        ok: false,
        error: tail(errorText(result?.error) || `status ${result?.status ?? 'missing'}`),
      })
    }
  }
  for (const child of suite.suites ?? []) collectSpecs(child, tests)
}

async function waitForPreview(url, child, log) {
  const started = Date.now()
  let lastError = ''
  while (Date.now() - started < 20_000) {
    if (child.exitCode !== null) {
      throw new Error(`preview exited ${child.exitCode}\n${tail(log.text || lastError)}`)
    }
    try {
      const response = await fetch(url)
      if (response.ok) return
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await delay(200)
  }
  throw new Error(`preview did not start: ${lastError}\n${tail(log.text)}`)
}

function run(command, commandArgs, options) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, commandArgs, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
    }, options.timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolvePromise({ code: 1, stdout, stderr: `${stderr}\n${error.message}` })
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolvePromise({ code, stdout, stderr })
    })
  })
}

function freePort() {
  return new Promise((resolvePromise, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('no free port'))
        return
      }
      const { port } = address
      server.close((error) => (error ? reject(error) : resolvePromise(port)))
    })
  })
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  const exited = await Promise.race([
    onceExit(child),
    delay(3000).then(() => 'timeout'),
  ])
  if (exited === 'timeout' && child.exitCode === null) {
    child.kill('SIGKILL')
    await Promise.race([onceExit(child), delay(2000)])
  }
  child.stdout?.destroy()
  child.stderr?.destroy()
  child.unref?.()
}

function onceExit(child) {
  return new Promise((resolvePromise) => {
    child.once('exit', () => resolvePromise('exit'))
  })
}

function fail(name, error) {
  return { passed: 0, failed: 1, tests: [{ name, ok: false, error: tail(error) }] }
}

function appendLog(log, chunk) {
  log.text = tail(`${log.text}${String(chunk)}`, 8000)
}

function tail(value, max = 4000) {
  const cleaned = stripAnsi(String(value ?? '')).trim()
  if (cleaned.length <= max) return cleaned
  return cleaned.slice(cleaned.length - max)
}

function stripAnsi(value) {
  return value.replace(/\u001b\[[0-9;]*m/g, '')
}

function errorText(error) {
  if (!error) return ''
  if (typeof error === 'string') return error
  if (typeof error === 'object' && 'message' in error && error.message) return String(error.message)
  return String(error)
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

function injectSetup(appDir) {
  const htmlPath = resolve(appDir, 'index.html')
  if (!existsSync(htmlPath)) throw new Error('index.html is missing')
  const html = readFileSync(htmlPath, 'utf8')
  const found = retargetModuleScript(html)
  if (!found) throw new Error('no module script in index.html')
  copyFileSync(resolve(hiddenDir, 'setup.ts'), resolve(appDir, '__grade_setup.ts'))
  const entry = `import './__grade_setup.ts'\nimport '${moduleImport(found.src)}'\n`
  writeFileSync(resolve(appDir, '__grade_entry.ts'), entry)
  writeFileSync(htmlPath, found.html)
}

function moduleImport(src) {
  if (src.startsWith('/')) return `.${src}`
  if (src.startsWith('./') || src.startsWith('../')) return src
  return `./${src}`
}

function retargetModuleScript(html) {
  const scriptRe = /<script\b[^>]*>/gi
  let match
  while ((match = scriptRe.exec(html))) {
    const tag = match[0]
    if (readAttr(tag, 'type') !== 'module') continue
    const src = readAttr(tag, 'src')
    if (!src) continue
    const nextTag = replaceAttr(tag, 'src', '/__grade_entry.ts')
    const updated = html.slice(0, match.index) + nextTag + html.slice(match.index + tag.length)
    return { html: updated, src }
  }
  return null
}

function readAttr(tag, name) {
  const doubleQuoted = tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i'))
  if (doubleQuoted) return doubleQuoted[1]
  const singleQuoted = tag.match(new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`, 'i'))
  if (singleQuoted) return singleQuoted[1]
  const bare = tag.match(new RegExp(`\\b${name}\\s*=\\s*([^\\s"'=<>]+)`, 'i'))
  return bare?.[1] ?? ''
}

function replaceAttr(tag, name, value) {
  const patterns = [
    new RegExp(`\\b${name}\\s*=\\s*"[^"]*"`, 'i'),
    new RegExp(`\\b${name}\\s*=\\s*'[^']*'`, 'i'),
    new RegExp(`\\b${name}\\s*=\\s*[^\\s"'=<>]+`, 'i'),
  ]
  for (const pattern of patterns) {
    if (pattern.test(tag)) return tag.replace(pattern, `${name}="${value}"`)
  }
  return tag
}

function required(value, flag) {
  if (!value || value === true) {
    console.error(`missing ${flag}`)
    process.exit(2)
  }
  return value
}
