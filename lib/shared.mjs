/**
 * shared.mjs — the shared context every agent reads and writes.
 *
 * One append-only JSONL file (`~/.dsh/agent-context/shared.jsonl`). Appending a
 * line is atomic enough across processes (`O_APPEND`, lines far below PIPE_BUF),
 * so Codex, Claude, a shell script and DSH can all write without a lock, and a
 * reader never sees a half entry.
 *
 * Entry:
 *   {"id":"…","at":"ISO","agent":"codex","kind":"decision|handoff|note|task",
 *    "title":"一句话","body":"正文","tags":["…"],"refs":["path#L1"],"cwd":"…"}
 *
 * Why not a database: the whole point is that *any* agent can append with one
 * `echo >>` / `curl -X POST` without shipping a client, and grep still works
 * when the hub is down.
 */

import fs from 'node:fs'
import crypto from 'node:crypto'
import { sharedFile, ensureDir } from './paths.mjs'
import { localIso } from './sources/base.mjs'

export const KINDS = ['decision', 'handoff', 'note', 'task']
const MAX_BODY = 20000
const MAX_TITLE = 200
const MAX_TAG = 40
const MAX_TAGS = 12

function normalizeTags(value) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,，\s]+/) : []
  const seen = new Set()
  const tags = []
  for (const item of list) {
    const tag = String(item ?? '').trim().slice(0, MAX_TAG)
    if (!tag) continue
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    tags.push(tag)
    if (tags.length >= MAX_TAGS) break
  }
  return tags
}

/**
 * Validate and append one context entry.
 * @returns {{entry: object}} the stored entry (with id/at filled in)
 */
export function appendShared(input = {}) {
  const title = String(input.title ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE)
  const body = String(input.body ?? input.text ?? '').trim().slice(0, MAX_BODY)
  if (!title && !body) throw new Error('标题和正文至少要有一个')
  const kind = String(input.kind ?? 'note').trim().toLowerCase()
  // A typo like `--kind decision2` must not be silently downgraded to `note`:
  // the caller is told which kinds exist.
  if (!KINDS.includes(kind)) throw new Error(`未知的 kind：${kind}（可用：${KINDS.join('|')}）`)
  const entry = {
    id: crypto.randomUUID(),
    at: localIso(new Date()),
    agent: String(input.agent ?? 'unknown').trim().slice(0, 60) || 'unknown',
    kind,
    title: title || body.split('\n')[0].slice(0, MAX_TITLE),
    body,
    tags: normalizeTags(input.tags),
    refs: (Array.isArray(input.refs) ? input.refs : []).map((ref) => String(ref).slice(0, 400)).slice(0, 20),
    cwd: typeof input.cwd === 'string' && input.cwd.trim() ? input.cwd.trim() : null,
  }
  ensureDir(sharedFile().replace(/[\\/][^\\/]+$/, ''))
  fs.appendFileSync(sharedFile(), `${JSON.stringify(entry)}\n`, 'utf8')
  return entry
}

/** Parse the whole log, skipping lines another writer left half-finished. */
export function readShared() {
  let text = ''
  try {
    text = fs.readFileSync(sharedFile(), 'utf8')
  } catch {
    return { entries: [], badLines: 0 }
  }
  const entries = []
  let badLines = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line)
      if (parsed && typeof parsed === 'object' && parsed.id) entries.push(parsed)
      else badLines += 1
    } catch {
      badLines += 1
    }
  }
  return { entries, badLines }
}

/**
 * Newest-first filtered list.
 * @param {{q?: string, agent?: string, kind?: string, cwd?: string, limit?: number}} [options]
 */
export function listShared(options = {}) {
  const { entries, badLines } = readShared()
  const limit = Math.min(Math.max(Number(options.limit ?? 50), 1), 500)
  const needle = String(options.q ?? '').trim().toLowerCase()
  const agent = String(options.agent ?? '').trim().toLowerCase()
  const kind = String(options.kind ?? '').trim().toLowerCase()
  const cwd = String(options.cwd ?? '').trim().toLowerCase()
  const matched = entries
    .filter((entry) => {
      if (agent && String(entry.agent ?? '').toLowerCase() !== agent) return false
      if (kind && String(entry.kind ?? '').toLowerCase() !== kind) return false
      if (cwd && String(entry.cwd ?? '').toLowerCase() !== cwd) return false
      if (!needle) return true
      // Same haystack idea as the session search: title, body, tags, refs.
      const hay = [entry.title, entry.body, (entry.tags ?? []).join(' '), (entry.refs ?? []).join(' '), entry.agent, entry.kind]
        .filter(Boolean)
        .join('\n')
        .toLowerCase()
      return hay.includes(needle)
    })
    .sort((a, b) => Date.parse(b.at ?? 0) - Date.parse(a.at ?? 0))
  const counts = {}
  for (const entry of entries) counts[entry.kind ?? 'note'] = (counts[entry.kind ?? 'note'] ?? 0) + 1
  const agents = {}
  for (const entry of entries) agents[entry.agent ?? 'unknown'] = (agents[entry.agent ?? 'unknown'] ?? 0) + 1
  return { entries: matched.slice(0, limit), total: matched.length, all: entries.length, counts, agents, badLines }
}

/**
 * A compact markdown digest for an agent that wants "what do I need to know
 * before touching this project": decisions first, then handoffs, newest first
 * within each kind.
 */
export function digestShared(options = {}) {
  const limit = Math.min(Math.max(Number(options.limit ?? 20), 1), 200)
  const { entries } = readShared()
  const root = String(options.cwd ?? '').replace(/[\\/]+$/, '').toLowerCase()
  const relevant = entries.filter((entry) => {
    if (!root) return true
    const cwd = String(entry.cwd ?? '').toLowerCase()
    // Entries without a cwd are global on purpose (they apply everywhere).
    return !cwd || cwd === root || cwd.startsWith(`${root}/`) || root.startsWith(`${cwd}/`)
  })
  const order = ['decision', 'handoff', 'task', 'note']
  const picked = []
  for (const kind of order) {
    const bucket = relevant
      .filter((entry) => (entry.kind ?? 'note') === kind)
      .sort((a, b) => Date.parse(b.at ?? 0) - Date.parse(a.at ?? 0))
    picked.push(...bucket.slice(0, Math.max(1, Math.floor(limit / order.length))))
  }
  const lines = []
  for (const entry of picked.slice(0, limit)) {
    const tags = (entry.tags ?? []).length > 0 ? ` _${(entry.tags ?? []).join(',')}_` : ''
    lines.push(`- **${entry.kind ?? 'note'}** ${entry.title ?? ''} — ${entry.agent ?? '?'} · ${entry.at ?? ''}${tags}`)
    if (entry.body) lines.push(`  ${String(entry.body).split('\n').slice(0, 6).join('\n  ')}`)
  }
  return { count: picked.length, markdown: lines.join('\n'), entries: picked.slice(0, limit) }
}
