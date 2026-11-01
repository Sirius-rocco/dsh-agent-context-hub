#!/usr/bin/env node
/**
 * github-setup.mjs — finish the GitHub side of the market listing with a token.
 *
 *   node scripts/github-setup.mjs auth              # who am I, what scopes
 *   node scripts/github-setup.mjs repo              # create the repository if needed
 *   node scripts/github-setup.mjs push              # push main over HTTPS with the token
 *   node scripts/github-setup.mjs topics            # add the dsh-plugin topic
 *   node scripts/github-setup.mjs market [--pr]     # fork the market repo, add the row, open the PR
 *   node scripts/github-setup.mjs all [--pr]        # everything above, in order
 *
 * The token is read from (first hit wins):
 *   --token-file <path> | $GH_TOKEN_FILE | ~/.dsh/gh-token.txt | ~/ghtoken.txt
 * It is never printed, never written into git config, and is scrubbed from child output.
 *
 * api.github.com is unreachable from this machine directly, so every call goes through
 * a SOCKS proxy (default 127.0.0.1:10808, the 'ssh -D' tunnel to rag_research).
 * Override with --socks <port>, or --proxy direct to skip the proxy.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO = 'dsh-agent-context-hub'
const MARKET = { owner: 'awesome-dsh-plugin', repo: 'awesome-dsh-plugin' }

const argv = process.argv.slice(2)
const command = argv.find((arg) => !arg.startsWith('-')) ?? 'auth'
const flag = (name) => {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? '' : String(argv[index + 1] ?? '')
}
const has = (name) => argv.includes(`--${name}`)

const socksFlag = flag('socks') || '10808'
const proxyMode = has('proxy') && flag('proxy') === 'direct' ? 'direct' : 'socks'
const SOCKS = proxyMode === 'direct' ? '' : `socks5h://127.0.0.1:${socksFlag}`

function die(message, hint) {
  console.error(`error: ${message}`)
  if (hint) console.error(`hint:  ${hint}`)
  process.exit(1)
}

/* ------------------------------------------------------------------ token */
function tokenPath() {
  const explicit = flag('token-file') || process.env.GH_TOKEN_FILE
  if (explicit) return path.resolve(explicit)
  const candidates = [path.join(os.homedir(), '.dsh', 'gh-token.txt'), path.join(os.homedir(), 'ghtoken.txt')]
  return candidates.find((file) => fs.existsSync(file)) ?? candidates[0]
}

const TOKEN_FILE = tokenPath()
if (!fs.existsSync(TOKEN_FILE)) {
  die(
    `no token file at ${TOKEN_FILE}`,
    'create a fine-grained token (contents: read/write, pull requests: read/write; or a classic token with the "repo" scope),\n' +
      `       paste it as one line into ${TOKEN_FILE}, then re-run.`,
  )
}
const TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim()
if (!/^(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})$/.test(TOKEN)) {
  die(`${TOKEN_FILE} does not look like a GitHub token (expected gh?… or github_pat_…)`)
}

const scrub = (text) => String(text ?? '').split(TOKEN).join('<token>')

/* --------------------------------------------------------------- transport */
function api(method, endpoint, body) {
  const args = ['-sS', '--max-time', '60', '-X', method, '-H', `Authorization: Bearer ${TOKEN}`, '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28']
  if (SOCKS) args.push('--socks5-hostname', `127.0.0.1:${socksFlag}`)
  if (body !== undefined) {
    args.push('-H', 'Content-Type: application/json', '-d', JSON.stringify(body))
  }
  const url = endpoint.startsWith('http') ? endpoint : `https://api.github.com${endpoint}`
  const result = spawnSync('curl', [...args, '-w', '\n%{http_code}', url], { encoding: 'utf8', timeout: 90000 })
  const out = result.stdout ?? ''
  const cut = out.lastIndexOf('\n')
  const status = Number(out.slice(cut + 1).trim())
  const text = out.slice(0, cut)
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  if (!status) die(`network error calling ${method} ${endpoint}: ${scrub(result.stderr || 'no response')}`)
  return { status, json, text }
}

function apiOk(method, endpoint, body, what) {
  const res = api(method, endpoint, body)
  if (res.status >= 400) {
    die(`${what} failed: HTTP ${res.status} ${scrub(res.json?.message ?? res.text).slice(0, 300)}`)
  }
  return res.json
}

function git(args, options = {}) {
  const full = ['-c', 'advice.detachedHead=false', ...args]
  if (SOCKS) full.unshift('-c', `http.proxy=${SOCKS}`)
  const result = spawnSync('git', full, { cwd: ROOT, encoding: 'utf8', stdio: options.capture ? 'pipe' : 'inherit', timeout: 180000 })
  return result
}

/* --------------------------------------------------------------- metadata */
/** Point package.json and the market row at the authenticated account, and commit it. */
function syncMetadata(login) {
  const pkgFile = path.join(ROOT, 'package.json')
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'))
  const want = {
    repository: { type: 'git', url: `git+https://github.com/${login}/${REPO}.git` },
    homepage: `https://github.com/${login}/${REPO}#readme`,
    bugs: { url: `https://github.com/${login}/${REPO}/issues` },
  }
  const changed = JSON.stringify(pkg.repository) !== JSON.stringify(want.repository) || pkg.homepage !== want.homepage || JSON.stringify(pkg.bugs) !== JSON.stringify(want.bugs)
  if (changed) {
    Object.assign(pkg, want)
    if ('private' in pkg) delete pkg.private
    fs.writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`)
    console.log(`  package.json now points at ${login}/${REPO}`)
  }
  const rowFile = path.join(ROOT, 'publish', `${login}__${REPO}.yml`)
  if (!fs.existsSync(rowFile)) {
    fs.writeFileSync(rowFile, marketRow(login))
    console.log(`  rendered publish/${login}__${REPO}.yml`)
  }
  const dirty = git(['status', '--porcelain'], { capture: true }).stdout ?? ''
  if (dirty.trim()) {
    git(['add', '-A'])
    git(['-c', 'user.name=wuqi', '-c', 'user.email=wuqi@oppo.com', 'commit', '-q', '-m', `chore(publish): point metadata at ${login}/${REPO}`])
    console.log('  committed the metadata change')
  }
}

/* -------------------------------------------------------------------- auth */
function whoAmI() {
  return apiOk('GET', '/user', undefined, 'GET /user')
}

/* -------------------------------------------------------------------- repo */
function ensureRepo(login) {
  const found = api('GET', `/repos/${login}/${REPO}`)
  if (found.status === 200) {
    console.log(`  repository exists: ${found.json.full_name} (${found.json.private ? 'private' : 'public'})`)
    return found.json
  }
  if (found.status !== 404) apiOk('GET', `/repos/${login}/${REPO}`, undefined, 'inspect repository')
  const created = apiOk(
    'POST',
    '/user/repos',
    {
      name: REPO,
      description: 'One context hub for every coding agent: index Codex / Claude Code / DSH session history, sync it daily, and share decisions between agents.',
      homepage: `https://github.com/${login}/${REPO}`,
      private: false,
      has_issues: true,
      has_wiki: false,
      has_projects: false,
    },
    'create repository',
  )
  console.log(`  created ${created.full_name} (${created.private ? 'private' : 'public'})`)
  return created
}

/* -------------------------------------------------------------------- push */
function push(login) {
  const remote = `https://github.com/${login}/${REPO}.git`
  const tempCredentials = path.join(os.tmpdir(), `gh-credentials-${process.pid}`)
  fs.writeFileSync(tempCredentials, `https://x-access-token:${TOKEN}@github.com\n`, { mode: 0o600 })
  try {
    const existing = git(['remote', 'get-url', 'origin'], { capture: true })
    if (existing.status === 0) git(['remote', 'set-url', 'origin', remote])
    else git(['remote', 'add', 'origin', remote])

    const branch = (git(['rev-parse', '--abbrev-ref', 'HEAD'], { capture: true }).stdout ?? '').trim()
    if (branch && branch !== 'main') git(['branch', '-m', branch, 'main'])

    const pushed = spawnSync(
      'git',
      ['-c', `credential.helper=store --file=${tempCredentials}`, ...(SOCKS ? ['-c', `http.proxy=${SOCKS}`] : []), 'push', '-u', 'origin', 'main'],
      { cwd: ROOT, encoding: 'utf8' },
    )
    const output = scrub(`${pushed.stdout ?? ''}${pushed.stderr ?? ''}`).trim()
    if (pushed.status !== 0) die(`git push failed:\n${output}`)
    console.log(`  pushed main -> ${remote}`)
    if (output) console.log(`  ${output.split('\n').slice(-2).join('\n  ')}`)
  } finally {
    try {
      fs.unlinkSync(tempCredentials)
    } catch {
      /* already gone */
    }
  }
}

/* ------------------------------------------------------------------ topics */
function topics(login) {
  const current = apiOk('GET', `/repos/${login}/${REPO}/topics`, undefined, 'read topics')
  const names = new Set([...(current.names ?? []), 'dsh-plugin', 'dsh-bundle', 'agent-context', 'session-history'])
  apiOk('PUT', `/repos/${login}/${REPO}/topics`, { names: [...names] }, 'set topics')
  console.log(`  topics: ${[...names].join(', ')}`)
}

/* ------------------------------------------------------------------ market */
function marketRow(login) {
  const source = path.join(ROOT, 'publish', 'awesome-dsh-plugin.yml')
  let text = fs.readFileSync(source, 'utf8')
  return text.replace(/<owner>/gi, login)
}

function openMarketPr(login) {
  // 1. fork (idempotent: an existing fork returns 422, which we treat as done)
  const fork = api('POST', `/repos/${MARKET.owner}/${MARKET.repo}/forks`, {})
  if (fork.status >= 400 && fork.status !== 422) {
    die(`fork failed: HTTP ${fork.status} ${scrub(fork.json?.message ?? fork.text)}`)
  }
  console.log(`  fork ready: ${login}/${MARKET.repo}`)

  // 2. wait for the fork to appear, then read its default branch
  let base = 'main'
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const repo = api('GET', `/repos/${login}/${MARKET.repo}`)
    if (repo.status === 200) {
      base = repo.json.default_branch || 'main'
      break
    }
    spawnSync('sleep', ['3'])
  }

  // 3. add (or update) the plugin row on a branch
  const branch = `add-${REPO}`
  const filePath = `data/plugins/${login}__${REPO}.yml`
  const ref = api('GET', `/repos/${login}/${MARKET.repo}/git/ref/heads/${branch}`)
  if (ref.status === 404) {
    apiOk('POST', `/repos/${login}/${MARKET.repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: apiOk('GET', `/repos/${login}/${MARKET.repo}/git/ref/heads/${base}`, undefined, 'read base ref').object.sha }, 'create branch')
  }

  const existing = api('GET', `/repos/${login}/${MARKET.repo}/contents/${filePath}?ref=${branch}`)
  const body = {
    message: `Add ${REPO}`,
    content: Buffer.from(marketRow(login), 'utf8').toString('base64'),
    branch,
  }
  if (existing.status === 200) body.sha = existing.json.sha
  apiOk('PUT', `/repos/${login}/${MARKET.repo}/contents/${filePath}`, body, 'write market row')
  console.log(`  wrote ${filePath} on ${login}:${branch}`)

  // 4. pull request
  const pr = api('POST', `/repos/${MARKET.owner}/${MARKET.repo}/pulls`, {
    title: `Add ${REPO}`,
    head: `${login}:${branch}`,
    base,
    body: [
      `Adds **${REPO}** — one context hub for every coding agent.`,
      '',
      '- Indexes Codex (local + SSH remote), Claude Code, DSH itself and any JSONL inbox source into one read-only index grouped by project.',
      '- Keeps the index fresh through a scheduled sync (Windows task or any scheduler).',
      '- Ships an append-only shared board (`shared.jsonl`) plus `/digest`, so a decision made in one agent is visible to the next one.',
      '',
      `Repository: https://github.com/${login}/${REPO}`,
      `Install: \`dsh plugin --profile web add github:${login}/${REPO}\``,
      '',
      'Icon is a GitHub-hosted PNG (`assets/icon-180.png`), only the row file is added by this PR.',
    ].join('\n'),
  })
  if (pr.status === 422 && /already exists/i.test(pr.json?.message ?? '')) {
    console.log('  pull request already exists')
    return
  }
  if (pr.status >= 400) die(`opening the pull request failed: HTTP ${pr.status} ${scrub(pr.json?.message ?? pr.text)}`)
  console.log(`  pull request: ${pr.json.html_url}`)
}

/* -------------------------------------------------------------------- main */
console.log(`github-setup: ${command}${SOCKS ? ` via ${SOCKS}` : ' (direct)'}`)

const user = whoAmI()
const login = user.login
console.log(`  authenticated as ${login}`)
if (user.name) console.log(`  account name: ${user.name}`)

if (!['all', 'auth', 'repo', 'push', 'topics', 'market'].includes(command)) {
  die(`unknown command "${command}"`, 'use: auth | repo | push | topics | market | all')
}

if (command === 'repo' || command === 'all') ensureRepo(login)
if (command === 'push' || command === 'all') syncMetadata(login)
if (command === 'push' || command === 'all') push(login)
if (command === 'topics' || command === 'all') topics(login)
if (command === 'market' || command === 'all') openMarketPr(login)

console.log('done')
