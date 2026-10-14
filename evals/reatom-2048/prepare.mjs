#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../..')
const starter = resolve(here, 'starter')
const hidden = resolve(here, 'hidden')
const oracle = resolve(here, 'oracle')
const batonWorkspace = resolve(repoRoot, 'tmp/baton')
const opusWorkspace = resolve(repoRoot, 'tmp/opus')

const args = parseArgs(process.argv.slice(2))
if (args.help === true) {
  console.log(`usage: bun evals/reatom-2048/prepare.mjs --name <name> [--dest dir]

Copies starter/ to tmp/<name>, including node_modules and .agents/skills.
Does not copy hidden/ or oracle/. Writes .prepared and replaces the destination
only when it is missing, empty, or already has that marker.`)
  process.exit(0)
}

const name = required(args.name, '--name')
if (!/^[A-Za-z0-9._-]+$/.test(name)) {
  console.error('--name must be a single path segment (letters, numbers, ., _, -)')
  process.exit(2)
}

const dest = resolve(typeof args.dest === 'string' ? args.dest : resolve(repoRoot, 'tmp', name))
assertSafeDestination(dest)
assertReplaceable(dest)

if (!existsSync(resolve(starter, 'node_modules'))) {
  console.error('starter/node_modules is missing. Run: bun install --cwd evals/reatom-2048/starter')
  process.exit(1)
}
if (!existsSync(resolve(starter, '.agents/skills/reatom/SKILL.md'))) {
  console.error('starter skills are missing')
  process.exit(1)
}

rmSync(dest, { recursive: true, force: true })
mkdirSync(dirname(dest), { recursive: true })
const copied = spawnSync('cp', ['-R', starter, dest], { stdio: 'inherit' })
if (copied.status !== 0) process.exit(copied.status ?? 1)
writeFileSync(resolve(dest, '.prepared'), '')
console.log(dest)

function assertReplaceable(dest) {
  if (!existsSync(dest)) return
  let entries
  try {
    entries = readdirSync(dest)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`refusing to replace ${dest}: ${message}`)
    process.exit(2)
  }
  if (entries.length === 0 || entries.includes('.prepared')) return
  console.error(`refusing to replace ${dest}: it is not empty and has no .prepared marker`)
  process.exit(2)
}

function assertSafeDestination(dest) {
  if (dest === repoRoot || dest === here) {
    console.error(`refusing to replace ${dest}`)
    process.exit(2)
  }
  const forbiddenRoots = [starter, hidden, oracle]
  if (forbiddenRoots.some((root) => isInside(root, dest))) {
    console.error(`refusing to replace ${dest}`)
    process.exit(2)
  }
  const protectedDirs = [batonWorkspace, opusWorkspace, starter, hidden, oracle, here]
  if (protectedDirs.some((protectedDir) => isInside(dest, protectedDir))) {
    console.error(`refusing to replace ${dest} because it contains a protected directory`)
    process.exit(2)
  }
}

function isInside(parent, child) {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
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
