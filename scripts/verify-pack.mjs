#!/usr/bin/env node
/**
 * pack-check.mjs — would this repository work for someone who installs it?
 *
 * Two independent questions:
 *   1. npm view:  does the `files` whitelist in package.json ship every module the
 *      plugin imports at runtime (plus the locale/icon/bundle patch)?
 *   2. git view:  does a fresh `git clone` of the repository pass its own test
 *      suite? That is exactly what `dsh plugin add github:<owner>/<repo>` gets.
 *
 *   node scripts/verify-pack.mjs [--json]
 *
 * Exit 0 when both hold, 1 otherwise. Read-only: it clones into the temp dir.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const asJson = process.argv.includes('--json')
const rows = []

function record(name, ok, detail) {
  rows.push({ name, ok, detail })
}

function sh(cmd, args, cwd) {
  return spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 300000, shell: process.platform === 'win32' })
}

/* ------------------------------------------------------- 1. npm file list */
const packed = sh('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], ROOT)
let files = []
try {
  const parsed = JSON.parse(packed.stdout ?? '[]')
  files = (parsed[0]?.files ?? []).map((entry) => entry.path.replace(/\\/g, '/'))
} catch {
  record('npm pack --dry-run runs', false, `${(packed.stderr ?? '').slice(0, 200)}`)
}

if (files.length) {
  const present = new Set(files)
  const required = ['index.js', 'client.js', 'cordis.patch.yml', 'icon.svg', 'locale/zh.json', 'locale/en.json', 'lib/parser.mjs', 'lib/hub.mjs', 'lib/paths.mjs', 'lib/shared.mjs', 'lib/transcript.mjs', 'lib/cli.mjs', 'lib/sources/index.mjs']
  const missing = required.filter((file) => !present.has(file))
  record('npm tarball ships every runtime module', missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : `${files.length} files`)

  const sources = fs.readdirSync(path.join(ROOT, 'lib', 'sources')).filter((name) => name.endsWith('.mjs'))
  const missingSources = sources.filter((name) => !present.has(`lib/sources/${name}`))
  record('npm tarball ships every adapter', missingSources.length === 0, missingSources.length ? `missing: ${missingSources.join(', ')}` : `${sources.length} adapters`)

  const leaked = files.filter((file) => /(^|\/)(cache|\.verify|node_modules)\//.test(file) || file.startsWith('.verify'))
  record('npm tarball carries no cache or harness scratch', leaked.length === 0, leaked.slice(0, 3).join(', '))

  const bytes = (JSON.parse(packed.stdout)[0]?.size) ?? 0
  record('npm tarball stays under 4 MB', bytes > 0 && bytes < 4 * 1024 * 1024, `${files.length} files, ${(bytes / 1024).toFixed(0)} KB`)
}

/* --------------------------------------------------- 2. fresh git clone run */
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-clone-'))
const clone = sh('git', ['clone', '--quiet', '.', work], ROOT)
record('git clone of the repository succeeds', clone.status === 0, clone.status === 0 ? work : (clone.stderr ?? '').slice(0, 200))

if (clone.status === 0) {
  const syntax = sh('node', ['--check', 'index.js'], work)
  record('index.js parses in the clone', syntax.status === 0, (syntax.stderr ?? '').slice(0, 160))

  const tests = sh('node', ['lib/test.mjs'], work)
  const summary = (tests.stdout ?? '').trim().split('\n').filter((line) => /passed|failed/i.test(line)).slice(-1)[0] ?? ''
  record('clone passes its own test suite', tests.status === 0, summary || (tests.stderr ?? '').slice(0, 160))

  const stats = sh('node', ['lib/cli.mjs', 'stats', '--json'], work)
  let sessions = null
  try {
    const parsed = JSON.parse(stats.stdout ?? '{}')
    sessions = parsed.stats?.sessions ?? parsed.sessions ?? null
  } catch {
    sessions = null
  }
  record('clone can scan this machine (cli stats --json)', stats.status === 0 && sessions !== null, sessions === null ? ((stats.stderr ?? '') || (stats.stdout ?? '')).slice(0, 160) : `${sessions} sessions`)

  const help = sh('node', ['lib/cli.mjs', 'list', '--limit', '1'], work)
  record('clone can list sessions', help.status === 0, (help.stdout ?? '').split('\n')[0]?.slice(0, 80) ?? '')
}

/* ------------------------------------------------------------------ output */
const failed = rows.filter((row) => !row.ok)
if (asJson) {
  console.log(JSON.stringify({ ok: failed.length === 0, rows }, null, 2))
} else {
  const pad = Math.max(...rows.map((row) => row.name.length))
  for (const row of rows) console.log(`${row.ok ? 'PASS' : 'FAIL'}  ${row.name.padEnd(pad)}  ${row.detail}`)
  console.log('')
  console.log(`${rows.length - failed.length} pass / ${failed.length} fail`)
}

fs.rmSync(work, { recursive: true, force: true })
process.exit(failed.length === 0 ? 0 : 1)
