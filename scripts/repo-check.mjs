#!/usr/bin/env node
/* Read-only status board for the published plugin.
 *
 *   node scripts/repo-check.mjs                 # repo + market PR + CI
 *   node scripts/repo-check.mjs --json          # machine-readable
 *   node scripts/repo-check.mjs --pr 11332       # another PR number
 *
 * The token is read from %USERPROFILE%\.dsh\gh-token.txt (one line, never
 * printed). Requests go through the SOCKS tunnel that github-setup.mjs starts,
 * because api.github.com is not reachable directly on this machine.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const arg = (name, fallback = null) => {
  const i = args.indexOf(name)
  return i === -1 ? fallback : args[i + 1] ?? fallback
}
const JSON_OUT = args.includes('--json')
const SOCKS = arg('--socks', '10808')
const TOKEN_FILE = arg('--token-file', path.join(os.homedir(), '.dsh', 'gh-token.txt'))
const PR_NUMBER = arg('--pr')
const OWNER = arg('--owner', 'Sirius-rocco')
const REPO = arg('--repo', 'dsh-agent-context-hub')
const MARKET = arg('--market', 'awesome-dsh-plugin/awesome-dsh-plugin')

if (!fs.existsSync(TOKEN_FILE)) {
  console.error(`no token at ${TOKEN_FILE} — run \`node scripts/github-setup.mjs auth\` first`)
  process.exit(2)
}
const TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim()

function api(endpoint) {
  const out = spawnSync(
    'curl',
    ['-sS', '--max-time', '60', '-H', `Authorization: Bearer ${TOKEN}`, '-H', 'Accept: application/vnd.github+json',
      '-H', 'X-GitHub-Api-Version: 2022-11-28', '--socks5-hostname', `127.0.0.1:${SOCKS}`,
      '-w', '\n%{http_code}', `https://api.github.com${endpoint}`],
    { encoding: 'utf8' },
  )
  const text = out.stdout ?? ''
  const cut = text.lastIndexOf('\n')
  let json = null
  try { json = JSON.parse(text.slice(0, cut)) } catch { /* not JSON */ }
  return { status: Number(text.slice(cut + 1).trim()), json }
}

const report = { repository: null, head: null, entry: null, pr: null, checks: [], problems: [] }

const repo = api(`/repos/${OWNER}/${REPO}`)
if (repo.status !== 200) {
  report.problems.push(`repository ${OWNER}/${REPO}: HTTP ${repo.status}`)
} else {
  const created = new Date(repo.json.created_at)
  report.repository = {
    full_name: repo.json.full_name,
    private: repo.json.private,
    default_branch: repo.json.default_branch,
    topics: repo.json.topics ?? [],
    ageDays: Number(((Date.now() - created.getTime()) / 86400000).toFixed(2)),
    pushedAt: repo.json.pushed_at,
  }
  if (repo.json.private) report.problems.push('repository is private (the market requires a public repo)')
  if (report.repository.ageDays < 1) report.problems.push('repository is younger than the market one-day floor')
  for (const topic of ['dsh-plugin']) {
    if (!report.repository.topics.includes(topic)) report.problems.push(`missing topic "${topic}"`)
  }

  const head = api(`/repos/${OWNER}/${REPO}/commits/main`)
  if (head.status === 200) {
    report.head = { sha: head.json.sha.slice(0, 7), message: head.json.commit.message.split('\n')[0] }
  }

  const tree = api(`/repos/${OWNER}/${REPO}/git/trees/main?recursive=1`)
  const paths = (tree.json?.tree ?? []).map((e) => e.path)
  const leaks = paths.filter((p) => /gh-credentials|\.env(\.|$)|token\.txt/i.test(p))
  if (leaks.length) report.problems.push(`credential-looking paths in the repo: ${leaks.join(', ')}`)
  const pkg = api(`/repos/${OWNER}/${REPO}/contents/package.json`)
  if (pkg.status === 200 && pkg.json?.content) {
    const parsed = JSON.parse(Buffer.from(pkg.json.content, 'base64').toString('utf8'))
    if (!parsed.dsh?.bundle) report.problems.push('package.json does not declare dsh.bundle (the market gate requires it)')
    report.entry = {
      files: paths.length,
      name: parsed.name,
      version: parsed.version,
      declaresBundle: Boolean(parsed.dsh?.bundle),
      hasPatch: fs.existsSync(path.join(process.cwd(), 'cordis.patch.yml')),
      hasIcon: paths.includes('assets/icon-180.png'),
    }
  }
}

if (PR_NUMBER) {
  const pr = api(`/repos/${MARKET}/pulls/${PR_NUMBER}`)
  if (pr.status === 200) {
    report.pr = {
      state: pr.json.state,
      mergeable: pr.json.mergeable,
      mergeableState: pr.json.mergeable_state,
      changedFiles: pr.json.changed_files,
      url: pr.json.html_url,
      title: pr.json.title,
    }
    const runs = api(`/repos/${MARKET}/commits/${pr.json.head.sha}/check-runs`)
    report.checks = (runs.json?.check_runs ?? []).map((c) => ({
      name: c.name, status: c.status, conclusion: c.conclusion, url: c.html_url,
    }))
    for (const c of report.checks) {
      if (c.conclusion === 'failure') report.problems.push(`CI check "${c.name}" failed: ${c.url}`)
    }
  } else {
    report.problems.push(`pull request #${PR_NUMBER}: HTTP ${pr.status}`)
  }
}

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2))
} else {
  if (report.repository) {
    const r = report.repository
    console.log(`repository  ${r.full_name} (${r.private ? 'private' : 'public'}, ${r.default_branch})`)
    console.log(`            topics: ${r.topics.join(', ') || '(none)'} · ${r.ageDays} days old · pushed ${r.pushedAt}`)
  }
  if (report.head) console.log(`head        ${report.head.sha} ${report.head.message}`)
  if (report.entry) {
    const e = report.entry
    console.log(`package     ${e.name}@${e.version} · ${e.files} files · dsh.bundle ${e.declaresBundle ? 'yes' : 'NO'} · patch ${e.hasPatch ? 'yes' : 'NO'} · icon ${e.hasIcon ? 'yes' : 'NO'}`)
  }
  if (report.pr) {
    const p = report.pr
    console.log(`market PR   #${PR_NUMBER} ${p.state} · mergeable ${p.mergeable} (${p.mergeableState}) · ${p.changedFiles} file(s)`)
    console.log(`            ${p.url}`)
  }
  for (const c of report.checks) console.log(`CI          ${c.name}: ${c.status}/${c.conclusion ?? '-'}`)
  if (report.problems.length) {
    console.log('problems:')
    for (const p of report.problems) console.log(`  - ${p}`)
  } else {
    console.log('problems: none')
  }
}

process.exit(report.problems.some((p) => !p.startsWith('CI check')) ? 1 : 0)
