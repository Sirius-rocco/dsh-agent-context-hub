/**
 * base.mjs — the contract every session source adapter implements, plus the
 * small helpers they all need.
 *
 * An adapter turns one agent's on-disk history into the hub's session rows and
 * can read one of those sessions back as a transcript. Adapters never talk to
 * each other and never write to the index; `lib/hub.mjs` merges their output.
 *
 * See `docs/ADAPTER-CONTRACT.md` for the full written contract.
 */

import fs from 'node:fs'
import path from 'node:path'

/** Upper bound on searchable prompt snippets kept per session. */
export const MAX_PROMPTS = 20

/**
 * Recursively collect files under `root` whose name passes `match`.
 * Unreadable directories are skipped: a missing agent root is normal.
 *
 * @param {string} root
 * @param {(name: string) => boolean} match
 * @returns {string[]}
 */
export function walkFiles(root, match) {
  const out = []
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.isFile() && match(entry.name)) out.push(full)
    }
  }
  return out
}

/** `2026-10-30T16:20:21+08:00` — local ISO with the machine offset. */
export function localIso(date) {
  const time = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(time.getTime())) return null
  const pad = (value, size = 2) => String(Math.abs(value)).padStart(size, '0')
  const offsetMinutes = -time.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  return (
    `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())}` +
    `T${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}` +
    `${sign}${pad(Math.floor(Math.abs(offsetMinutes) / 60))}:${pad(Math.abs(offsetMinutes) % 60)}`
  )
}

/** Strip a trailing slash so the same project groups under one key. */
export function groupKey(cwd) {
  if (!cwd) return '__unknown__'
  return String(cwd).replace(/[\\/]+$/, '').toLowerCase()
}

/** Last path segment, used as the project label when no title exists. */
export function projectLabel(cwd) {
  if (!cwd) return '未知项目'
  const parts = String(cwd).split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? String(cwd)
}

/** Collapse whitespace, drop blanks, de-duplicate (case-insensitive), cap. */
export function mergePrompts(...lists) {
  const seen = new Set()
  const merged = []
  for (const list of lists) {
    for (const value of list ?? []) {
      const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
      if (!text) continue
      const key = text.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(text)
      if (merged.length >= MAX_PROMPTS) return merged
    }
  }
  return merged
}

/** A short, searchable title from the first real prompt. */
export function titleFromText(value, limit = 80) {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  if (!text) return ''
  if (text.length <= limit) return text
  const cut = text.slice(0, limit).replace(/[\s，,。.;；:：、-]+$/, '')
  return `${cut}…`
}

/** Normalize one adapter row so the hub can merge rows from any agent. */
export function normalizeSession(agent, row) {
  const updatedAt = row.updatedAt ?? row.createdAt ?? null
  return {
    id: String(row.id),
    agent,
    // Set by adapters that multiplex several agents (inbox): the real agent name.
    actor: row.actor ?? null,
    title: (row.title && String(row.title).trim()) || titleFromText(row.prompts?.[0]) || `${agent} · ${updatedAt?.slice(5, 16) ?? ''}`,
    cwd: row.cwd ?? null,
    file: row.file ?? null,
    createdAt: row.createdAt ?? null,
    updatedAt,
    originator: row.originator ?? null,
    model: row.model ?? null,
    sizeBytes: row.sizeBytes ?? null,
    remote: row.remote === true,
    host: row.host ?? null,
    // Filled in lazily when a transcript is opened.
    messageCount: row.messageCount ?? null,
    userPromptCount: row.userPromptCount ?? null,
    hasToolCalls: row.hasToolCalls ?? null,
    duplicateFiles: row.duplicateFiles ?? [],
    prompts: mergePrompts(row.prompts),
    // Adapter-specific extras (kept small; shown in the transcript header).
    extra: row.extra ?? null,
  }
}

/** Empty transcript skeleton shared by every local adapter. */
export function emptyTranscript(file = null) {
  return {
    id: null,
    title: null,
    cwd: null,
    model: null,
    createdAt: null,
    updatedAt: null,
    messages: [],
    messageCount: 0,
    userPromptCount: 0,
    hasToolCalls: false,
    truncated: false,
    badLines: 0,
    file,
  }
}

/**
 * Read a JSONL file line by line without loading the whole body twice.
 * Malformed lines are counted, not thrown: agent logs get truncated by crashes.
 *
 * @param {string} file
 * @param {(entry: any, line: string) => void} onEntry
 */
export async function readJsonl(file, onEntry) {
  const fsp = fs.promises
  const handle = await fsp.open(file, 'r')
  let badLines = 0
  let buffer = ''
  try {
    const chunk = Buffer.allocUnsafe(1 << 16)
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
      if (bytesRead === 0) break
      buffer += chunk.toString('utf8', 0, bytesRead)
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (line.trim()) {
          try {
            onEntry(JSON.parse(line), line)
          } catch {
            badLines += 1
          }
        }
        newline = buffer.indexOf('\n')
      }
    }
    if (buffer.trim()) {
      try {
        onEntry(JSON.parse(buffer), buffer)
      } catch {
        badLines += 1
      }
    }
  } finally {
    await handle.close()
  }
  return { badLines }
}

/** Read at most `bytes` from the head of a file (cheap metadata pass). */
export async function readHeadBytes(file, bytes = 262144) {
  const handle = await fs.promises.open(file, 'r')
  try {
    const buffer = Buffer.allocUnsafe(bytes)
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0)
    return buffer.toString('utf8', 0, bytesRead)
  } finally {
    await handle.close()
  }
}

/** Clamp a long text, reporting whether it was cut. */
export function clampText(value, limit) {
  const text = typeof value === 'string' ? value : String(value ?? '')
  if (text.length <= limit) return { text, truncated: false }
  return { text: `${text.slice(0, limit)}\n…[已截断 ${text.length - limit} 字]`, truncated: true }
}

/** Bounded-concurrency map (file scans are I/O bound; 8-12 is plenty). */
export async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const runners = new Array(Math.min(Math.max(limit, 1), items.length || 1)).fill(null).map(async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}
