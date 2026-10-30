#!/usr/bin/env node
/**
 * preflight.mjs — answer one question: "can this repository be listed in the
 * DSH plugin market right now, and if not, what exactly is missing?"
 *
 * Every check is read-only and offline-safe except two probes that are skipped
 * when neither the flags nor the environment provide a target:
 *   node scripts/preflight.mjs                 # repo-only checks
 *   node scripts/preflight.mjs --live          # + talk to the running host
 *   node scripts/preflight.mjs --live --port 56842
 *   node scripts/preflight.mjs --json          # machine-readable
 *
 * Exit codes: 0 = every blocking check passed, 1 = something must be fixed
 * before the PR (or before the repo is pushed), 2 = unexpected error.
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const asJson = argv.includes('--json')
const live = argv.includes('--live')
const portIndex = argv.indexOf('--port')
const PORT = portIndex === -1 ? Number(process.env.DSH_PORT ?? 0) : Number(argv[portIndex + 1])

const results = []
/** blocking: the market row or the repo cannot work without it. */
function check(name, blocking, run) {
  let ok = false
  let detail = ''
  try {
    const out = run()
    ok = out === undefined ? true : Boolean(out.ok)
    detail = out && typeof out === 'object' && out.detail !== undefined ? String(out.detail) : ''
  } catch (error) {
    ok = false
    detail = error.message
  }
  results.push({ name, blocking, ok, detail })
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'))
}

function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel))
}

function run(cmd, args) {
  return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 }).trim()
}

function tryRun(cmd, args) {
  try {
    return { ok: true, out: run(cmd, args) }
  } catch (error) {
    return { ok: false, out: `${error.stdout ?? ''}${error.stderr ?? ''}`.trim() || error.message }
  }
}

/* ---------------------------------------------------------------- package */
let pkg = null
check('package.json parses', true, () => {
  pkg = readJson('package.json')
  return { ok: true, detail: `${pkg.name}@${pkg.version}` }
})

check('name matches the market convention (dsh-*)', true, () =>
  ({ ok: /^dsh-[a-z0-9-]+$/.test(pkg.name), detail: pkg.name }),
)

check('no "private" field (the market refuses private packages)', true, () =>
  ({ ok: !('private' in pkg), detail: 'private' in pkg ? 'remove "private": true' : 'absent' }),
)

check('declares dsh.bundle.patch', true, () =>
  ({ ok: Boolean(pkg.dsh?.bundle?.patch), detail: pkg.dsh?.bundle?.patch ?? 'missing' }),
)

check('declares dsh.client.platform = web (panel)', true, () =>
  ({ ok: pkg.dsh?.client?.platform === 'web', detail: pkg.dsh?.client?.platform ?? 'missing' }),
)

check('repository/homepage/bugs point at a real account', true, () => {
  const urls = [pkg.repository?.url, pkg.homepage, pkg.bugs?.url].filter(Boolean)
  const placeholders = urls.filter((url) => /github\.com\/(OWNER|<owner>)\//i.test(url))
  return {
    ok: urls.length === 3 && placeholders.length === 0,
    detail: placeholders.length ? `replace OWNER in ${placeholders.length} field(s)` : urls.length === 3 ? 'ok' : 'a field is missing',
  }
})

check('engines.node covers the zstd frames the DSH adapter needs', false, () =>
  ({ ok: />=22\.15|>=23|>=24/.test(pkg.engines?.node ?? ''), detail: pkg.engines?.node ?? 'unset' }),
)

/* ------------------------------------------------------------------ files */
for (const file of [
  'index.js',
  'client.js',
  'cordis.patch.yml',
  'LICENSE',
  'README.md',
  'CONTRACT.md',
  'SKILL.md',
  'CHANGELOG.md',
  'icon.svg',
  'assets/icon-180.png',
  'assets/icon-512.png',
  'publish/awesome-dsh-plugin.yml',
  'docs/MARKET.md',
  'docs/ADAPTER-CONTRACT.md',
  'examples/inbox-sample.jsonl',
  'examples/sources.json',
]) {
  check(`file: ${file}`, true, () => ({ ok: exists(file), detail: exists(file) ? '' : 'missing' }))
}

check('cordis.patch.yml inserts the *installable* package name', true, () => {
  const yaml = fs
    .readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8')
    .split('\n')
    .map((line) => line.replace(/(^|\s)#.*$/, ''))
    .join('\n')
  const inserted = yaml.match(/^\s*(?:-\s+)?name:\s*['"]?([a-z0-9@/._-]+)['"]?\s*$/im)
  return {
    ok: inserted?.[1] === pkg.name,
    detail: inserted ? `insert name = ${inserted[1]} (package name = ${pkg.name})` : 'no name found',
  }
})

check('icon.svg is a real vector file', true, () => {
  const svg = fs.readFileSync(path.join(ROOT, 'icon.svg'), 'utf8')
  return { ok: svg.includes('<svg') && svg.length > 200, detail: `${svg.length} bytes` }
})

check('icon-180.png looks like a PNG', true, () => {
  const buf = fs.readFileSync(path.join(ROOT, 'assets', 'icon-180.png'))
  return { ok: buf.subarray(1, 4).toString() === 'PNG', detail: `${buf.length} bytes` }
})

/* -------------------------------------------------------------------- git */
const gitBranch = tryRun('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
check('git repository initialised', true, () => ({ ok: gitBranch.ok, detail: gitBranch.ok ? gitBranch.out : 'run git init' }))

if (gitBranch.ok) {
  check('at least one commit exists', true, () => {
    const log = tryRun('git', ['log', '--oneline'])
    return { ok: log.ok && log.out.length > 0, detail: log.ok ? `${log.out.split('\n').length} commit(s)` : 'no commits' }
  })

  check('working tree is clean', false, () => {
    const status = tryRun('git', ['status', '--porcelain'])
    return { ok: status.ok && status.out === '', detail: status.out ? `${status.out.split('\n').length} changed path(s)` : 'clean' }
  })

  check('node_modules / cache / .verify* are not tracked', true, () => {
    const tracked = tryRun('git', ['ls-files'])
    const bad = tracked.out.split('\n').filter((line) => /(^|\/)(node_modules|cache|\.verify)/.test(line))
    return { ok: tracked.ok && bad.length === 0, detail: bad.slice(0, 3).join(', ') }
  })

  check('remote origin is configured', true, () => {
    const remotes = tryRun('git', ['remote', '-v'])
    return { ok: remotes.ok && remotes.out.includes('origin'), detail: remotes.out ? remotes.out.split('\n')[0] : 'no remote' }
  })

  check('branch is main (market convention)', false, () => ({
    ok: gitBranch.out === 'main',
    detail: gitBranch.out === 'main' ? 'main' : `currently ${gitBranch.out}`,
  }))
}

/* --------------------------------------------------------- publish tooling */
const gh = tryRun('gh', ['--version'])
check('gh CLI available (needed for repo create / topic / PR)', false, () => ({
  ok: gh.ok,
  detail: gh.ok ? gh.out.split('\n')[0] : 'gh not installed — do the GitHub steps in the browser (docs/MARKET.md §8)',
}))

const npmWho = tryRun('npm', ['whoami'])
check('npm login (only needed for an npm release; the market works GitHub-only)', false, () => ({
  ok: npmWho.ok,
  detail: npmWho.ok ? npmWho.out : 'not logged in (npm publish is optional)',
}))

check('no token leaks into the repository', true, () => {
  const tracked = tryRun('git', ['ls-files'])
  const risky = tracked.out
    .split('\n')
    .filter((line) => line && !line.startsWith('test/fixtures/'))
    .filter((line) => {
      try {
        const text = fs.readFileSync(path.join(ROOT, line), 'utf8')
        return /(ghp_[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,})/.test(text)
      } catch {
        return false
      }
    })
  return { ok: risky.length === 0, detail: risky.slice(0, 3).join(', ') }
})

/* ------------------------------------------------------------------- live */
async function liveChecks() {
  if (!PORT) {
    results.push({ name: 'live host: skipped (pass --port or set DSH_PORT)', blocking: false, ok: true, detail: '' })
    return
  }
  const base = `http://127.0.0.1:${PORT}`
  try {
    const ping = await fetch(`${base}/agent-context/api/ping`).then((r) => r.json())
    results.push({
      name: 'live host: plugin answers /ping',
      blocking: false,
      ok: ping?.ok === true && ping?.name === 'agent-context-hub',
      detail: JSON.stringify(ping),
    })
    const list = await fetch(`${base}/agent-context/api/list`).then((r) => r.json())
    results.push({
      name: 'live host: /list serves the current index version',
      blocking: false,
      ok: list?.version >= 5 && Array.isArray(list?.groups),
      detail: `version ${list?.version}, ${list?.groups?.length ?? 0} groups, ${list?.stats?.sessions ?? '?'} sessions`,
    })
    const js = await fetch(`${base}/agent-context/api/client.js`).then((r) => (r.ok ? r.text() : ''))
    results.push({
      name: 'live host: /client.js serves the panel bundle',
      blocking: false,
      ok: js.includes('__agentContextHubLoaded') && js.length > 20000,
      detail: `${js.length} bytes`,
    })
  } catch (error) {
    results.push({ name: 'live host: reachable', blocking: false, ok: false, detail: error.message })
  }
}

try {
  if (live) await liveChecks()
} catch (error) {
  console.error('preflight: unexpected error', error)
  process.exit(2)
}

/* ------------------------------------------------------------------ output */
const blockingFailures = results.filter((row) => row.blocking && !row.ok)
const warnings = results.filter((row) => !row.blocking && !row.ok)

if (asJson) {
  console.log(JSON.stringify({ ok: blockingFailures.length === 0, blockingFailures: blockingFailures.length, warnings: warnings.length, results }, null, 2))
} else {
  const pad = Math.max(...results.map((row) => row.name.length))
  for (const row of results) {
    const mark = row.ok ? 'PASS' : row.blocking ? 'FAIL' : 'WARN'
    console.log(`${mark}  ${row.name.padEnd(pad)}  ${row.detail}`)
  }
  console.log('')
  console.log(`${results.length - blockingFailures.length - warnings.length} pass / ${blockingFailures.length} blocking / ${warnings.length} warning`)
  if (blockingFailures.length) {
    console.log('')
    console.log('Blocking before pushing the repo or opening the market PR:')
    for (const row of blockingFailures) console.log(`  - ${row.name}: ${row.detail}`)
  }
}

process.exit(blockingFailures.length === 0 ? 0 : 1)
