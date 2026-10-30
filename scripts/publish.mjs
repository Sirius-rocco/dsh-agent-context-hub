#!/usr/bin/env node
/**
 * publish.mjs — turn this checkout into a publishable repository in one command.
 *
 *   node scripts/publish.mjs --owner <github-login> [--dry-run] [--push] [--pr]
 *
 * What it does, in order:
 *   1. validates the GitHub login and refuses the OWNER placeholder;
 *   2. rewrites the repository/homepage/bugs fields of package.json;
 *   3. renders publish/awesome-dsh-plugin.yml -> publish/<owner>__dsh-agent-context-hub.yml;
 *   4. points git's `origin` at https://github.com/<owner>/dsh-agent-context-hub.git;
 *   5. with --push: `git push -u origin main` (needs your git credentials);
 *   6. with --pr:   opens the market PR through `gh`, or prints the browser steps.
 *
 * Nothing here authenticates for you: creating the GitHub repository, pushing and
 * opening the market PR all happen under your own GitHub account. --dry-run shows
 * every change without touching a file or a remote.
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const doPush = argv.includes('--push')
const doPr = argv.includes('--pr')
const ownerFlag = argv.indexOf('--owner')
const owner = ownerFlag === -1 ? '' : String(argv[ownerFlag + 1] ?? '').trim()

const REPO = 'dsh-agent-context-hub'
const MARKET_REPO = 'awesome-dsh-plugin/awesome-dsh-plugin'

function fail(message, hint) {
  console.error(`error: ${message}`)
  if (hint) console.error(`hint:  ${hint}`)
  process.exit(1)
}

function read(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8')
}

function write(file, text) {
  const target = path.join(ROOT, file)
  if (dryRun) {
    console.log(`  would write ${file} (${Buffer.byteLength(text)} bytes)`)
    return
  }
  fs.writeFileSync(target, text)
  console.log(`  wrote ${file}`)
}

function git(args, options = {}) {
  return spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: options.capture ? 'pipe' : 'inherit', timeout: 120000 })
}

/* --------------------------------------------------------------- 1. owner */
if (!owner) {
  fail(
    'missing --owner <github-login>',
    'example: node scripts/publish.mjs --owner octocat --dry-run\n' +
      '       if you already have a repository, pass its account name; the market links are built from it.',
  )
}
if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner)) {
  fail(`"${owner}" is not a valid GitHub account name`)
}
if (/^(owner|your-?name|username|<owner>)$/i.test(owner)) {
  fail(`"${owner}" is a placeholder, not an account`)
}

console.log(`publishing as ${owner}/${REPO}${dryRun ? '  (dry run: nothing is written)' : ''}`)
console.log('')

/* -------------------------------------------------------------- 2. package */
const pkgFile = 'package.json'
const pkg = JSON.parse(read(pkgFile))
const before = JSON.stringify(pkg.repository ?? {}) + JSON.stringify(pkg.homepage ?? '') + JSON.stringify(pkg.bugs ?? {})

pkg.repository = { type: 'git', url: `git+https://github.com/${owner}/${REPO}.git` }
pkg.homepage = `https://github.com/${owner}/${REPO}#readme`
pkg.bugs = { url: `https://github.com/${owner}/${REPO}/issues` }
if (pkg.funding) delete pkg.funding
if ('private' in pkg) delete pkg.private

const after = JSON.stringify(pkg.repository) + JSON.stringify(pkg.homepage) + JSON.stringify(pkg.bugs)
if (before !== after) write(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`)
else console.log(`  ${pkgFile} already points at ${owner}`)

/* ------------------------------------------------------------- 3. market row */
const manifestSource = 'publish/awesome-dsh-plugin.yml'
const manifestTarget = `publish/${owner}__${REPO}.yml`
let manifest = read(manifestSource)
if (/<owner>/i.test(manifest)) {
  manifest = manifest.replace(/<owner>/gi, owner)
  write(manifestSource, manifest)
} else {
  console.log(`  ${manifestSource} already rendered`)
}
if (manifestTarget !== manifestSource) write(manifestTarget, manifest)

/* ------------------------------------------------------------------ 4. git */
const remotes = spawnSync('git', ['remote'], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' })
const url = `https://github.com/${owner}/${REPO}.git`
if (remotes.status !== 0) {
  console.log('  (not a git repository — run git init first)')
} else if (!(remotes.stdout ?? '').split('\n').includes('origin')) {
  if (dryRun) console.log(`  would run: git remote add origin ${url}`)
  else {
    git(['remote', 'add', 'origin', url])
    console.log(`  git remote add origin ${url}`)
  }
} else {
  const current = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' }).stdout?.trim()
  if (current !== url) {
    if (dryRun) console.log(`  would run: git remote set-url origin ${url}`)
    else {
      git(['remote', 'set-url', 'origin', url])
      console.log(`  git remote set-url origin ${url}`)
    }
  } else {
    console.log(`  origin already ${url}`)
  }
}

/* ------------------------------------------------------------------ 5. push */
const branch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' }).stdout?.trim() ?? ''
if (branch && branch !== 'main') {
  if (dryRun) console.log(`  would run: git branch -m ${branch} main`)
  else {
    git(['branch', '-m', branch, 'main'])
    console.log(`  renamed branch ${branch} -> main`)
  }
}

if (doPush) {
  if (dryRun) console.log('  would run: git push -u origin main')
  else {
    console.log('  git push -u origin main')
    const pushed = git(['push', '-u', 'origin', 'main'])
    if (pushed.status !== 0) {
      fail(
        'git push failed (no credentials for github.com?)',
        'sign in once with Git Credential Manager, or push from the GitHub web UI / GitHub Desktop, then re-run with --pr',
      )
    }
  }
}

/* --------------------------------------------------------------- 6. the PR */
const ghCheck = spawnSync('gh', ['--version'], { encoding: 'utf8', stdio: 'pipe' })
const hasGh = ghCheck.status === 0

if (doPr) {
  if (!hasGh) {
    console.log('')
    console.log('gh CLI is not installed, so the PR must be opened in the browser:')
    console.log(`  1. open https://github.com/${MARKET_REPO} and fork it`)
    console.log(`  2. add data/plugins/${owner}__${REPO}.yml with the content of ${manifestTarget}`)
    console.log('  3. open the pull request; the site picks the row up on its next build (~a day)')
  } else if (dryRun) {
    console.log(`  would run: gh repo create ${owner}/${REPO} --public --source . --remote origin --push`)
  } else {
    const created = spawnSync('gh', ['repo', 'view', `${owner}/${REPO}`], { encoding: 'utf8', stdio: 'pipe' })
    if (created.status !== 0) {
      console.log(`  gh repo create ${owner}/${REPO} --public --source . --push`)
      spawnSync('gh', ['repo', 'create', `${owner}/${REPO}`, '--public', '--source', '.', '--push'], { cwd: ROOT, stdio: 'inherit' })
    }
    console.log('  next: fork the market repo and add the row')
    console.log(`  gh repo fork ${MARKET_REPO} --clone=false`)
    console.log(`  gh api -X PUT repos/${owner}/${MARKET_REPO.split('/')[1]}/contents/data/plugins/${owner}__${REPO}.yml ...`)
    console.log('  (the exact body is generated by docs/MARKET.md §5; the web UI is simpler)')
  }
}

/* ------------------------------------------------------------- 7. checklist */
console.log('')
console.log('remaining after this run:')
const checks = []
if (!doPush) checks.push('push the repo:  git push -u origin main   (or --push next time)')
checks.push(`create the repository if it does not exist yet: https://github.com/new?name=${REPO} (public)`)
checks.push('add the topic "dsh-plugin" to the repository (the market filter needs it)')
checks.push(`one day after the first push, open the market PR with ${manifestTarget}`)
if (!hasGh) checks.push('optional: install GitHub CLI (`winget install GitHub.cli`) to script the PR')
checks.push('verify:  node scripts/preflight.mjs --live --port <host-port>')
for (const line of checks) console.log(`  - ${line}`)
