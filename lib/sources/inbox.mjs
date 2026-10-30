/**
 * inbox.mjs — the universal adapter: any agent that can append a JSON line can
 * hand its history to the hub, without the hub knowing that agent's format.
 *
 * One line per event, in `~/.dsh/agent-context/inbox/*.jsonl`:
 *
 *   {"agent":"my-bot","session":"run-42","cwd":"D:\\work\\demo",
 *    "title":"可选标题","ts":"2026-10-30T10:00:00+08:00",
 *    "role":"user","text":"请把报告整理成表格","model":"optional"}
 *
 * `role` is `user` | `assistant` | `tool` | `note`. Only `user`/`note` text
 * becomes a searchable prompt; everything else is transcript body.
 * `sources.json` can add more roots (`{"sources":[{"id":"x","glob":"D:/logs/*.jsonl"}]}`),
 * each line then optionally omitting `agent` (the source id is used).
 */

import fs from 'node:fs'
import path from 'node:path'
import { normalizeSession, localIso, mergePrompts, titleFromText, clampText, emptyTranscript, readJsonl, walkFiles } from './base.mjs'
import { inboxDir, sourcesFile } from '../paths.mjs'

export const meta = {
  id: 'inbox',
  label: '通用接入',
  order: 90,
  remote: false,
}

const MAX_TEXT = 4000

function readConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(sourcesFile(), 'utf8'))
    const list = Array.isArray(parsed?.sources) ? parsed.sources : []
    return list.filter((entry) => entry && typeof entry.id === 'string' && entry.id.trim())
  } catch {
    return []
  }
}

function globToRegex(pattern) {
  const escaped = String(pattern)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/\\\\]*')
    .replace(/\u0000/g, '.*')
  return new RegExp(`^${escaped}$`, 'i')
}

/** Expand a configured glob into files. Only `*` / `**` are supported. */
function expandGlob(pattern) {
  const normalized = String(pattern).replace(/\\/g, '/')
  const star = normalized.indexOf('*')
  if (star === -1) {
    try {
      return fs.statSync(normalized).isFile() ? [normalized] : []
    } catch {
      return []
    }
  }
  const rootEnd = normalized.lastIndexOf('/', star)
  const root = rootEnd > 0 ? normalized.slice(0, rootEnd) : normalized.slice(0, star)
  if (!root) return []
  const matcher = globToRegex(normalized)
  return walkFiles(root, () => true).filter((file) => matcher.test(file.replace(/\\/g, '/')))
}

function collectFiles(ctx) {
  const files = []
  for (const file of walkFiles(inboxDir(), (name) => name.endsWith('.jsonl'))) {
    files.push({ file, agent: null })
  }
  for (const source of readConfig()) {
    if (source.kind && source.kind !== 'inbox') continue
    const patterns = Array.isArray(source.glob) ? source.glob : [source.glob].filter(Boolean)
    for (const pattern of patterns) {
      for (const file of expandGlob(path.isAbsolute(pattern) ? pattern : path.join(path.dirname(sourcesFile()), pattern))) {
        files.push({ file, agent: source.id })
      }
    }
  }
  return files
}

export function detect() {
  try {
    const hasInbox = walkFiles(inboxDir(), (name) => name.endsWith('.jsonl')).length > 0
    return hasInbox || readConfig().length > 0
  } catch {
    return false
  }
}

/**
 * Group events into sessions. Inbox files are small by construction (an agent
 * appends a line per turn, not a rollout), so a full read here is fine.
 */
export async function scan(ctx = {}) {
  const files = collectFiles(ctx)
  const warnings = []
  const byKey = new Map()
  let events = 0
  let badLines = 0
  let bytes = 0

  for (const { file, agent } of files) {
    let size = 0
    try {
      size = (await fs.promises.stat(file)).size
    } catch {
      warnings.push(`无法读取文件信息: ${file}`)
      continue
    }
    bytes += size
    try {
      const counted = await readJsonl(file, (entry) => {
        if (!entry || typeof entry !== 'object') return
        const agentId = String(entry.agent ?? agent ?? 'inbox').trim() || 'inbox'
        const sessionId = String(entry.session ?? entry.sessionId ?? path.basename(file, '.jsonl'))
        const key = `${agentId}\u0000${sessionId}`
        let row = byKey.get(key)
        if (!row) {
          row = { agent: agentId, id: sessionId, cwd: null, title: null, file, prompts: [], events: [], model: null, firstTs: null, lastTs: null }
          byKey.set(key, row)
        }
        if (typeof entry.cwd === 'string' && entry.cwd.trim() && !row.cwd) row.cwd = entry.cwd.trim()
        if (typeof entry.title === 'string' && entry.title.trim() && !row.title) row.title = entry.title.trim()
        if (typeof entry.model === 'string' && entry.model.trim()) row.model = entry.model.trim()
        if (typeof entry.ts === 'string' && entry.ts.trim()) {
          if (!row.firstTs) row.firstTs = entry.ts
          row.lastTs = entry.ts
        }
        const role = String(entry.role ?? 'note').toLowerCase()
        const text = typeof entry.text === 'string' ? entry.text : ''
        if (!text.trim()) return
        events += 1
        row.events.push({ role, ts: entry.ts ?? null, text })
        if (role === 'user' || role === 'note') row.prompts.push(text)
      })
      badLines += counted.badLines
    } catch (error) {
      warnings.push(`无法解析 ${path.basename(file)}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (badLines > 0) warnings.push(`通用接入有 ${badLines} 行无法解析，相关会话正文可能不完整`)

  const sessions = []
  for (const row of byKey.values()) {
    let updatedAt = row.lastTs ?? null
    if (!updatedAt) {
      try {
        updatedAt = localIso((await fs.promises.stat(row.file)).mtimeMs)
      } catch {
        updatedAt = null
      }
    }
    sessions.push(
      normalizeSession(meta.id, {
        id: `${row.agent}/${row.id}`,
        cwd: row.cwd,
        title: row.title || titleFromText(row.prompts[0]),
        file: row.file,
        createdAt: row.firstTs ?? null,
        updatedAt,
        model: row.model,
        prompts: mergePrompts(row.prompts),
        actor: row.agent,
        // The id is `<source>/<session>`, and a source id may itself contain
        // slashes (`team/alpha`); readTranscript must not re-split the prefix.
        extra: { agent: row.agent, sessionId: row.id, events: row.events.length },
      }),
    )
  }

  return {
    sessions,
    warnings,
    stats: { files: files.length, bytes, events, badLines, sessions: sessions.length },
  }
}

export async function readTranscript(session, ctx = {}) {
  const maxMessages = ctx.maxMessages ?? 400
  const extra = session.extra ?? {}
  const wanted = String(session.id ?? '')
  const slash = wanted.indexOf('/')
  // A source id may contain `/` (`team/alpha`), so trust what `scan` recorded
  // instead of splitting the joined id on its first slash.
  const agentId =
    typeof extra.agent === 'string' && extra.agent
      ? extra.agent
      : slash === -1
        ? null
        : wanted.slice(0, slash)
  const sessionId =
    typeof extra.sessionId === 'string' && extra.sessionId
      ? extra.sessionId
      : slash === -1
        ? wanted
        : wanted.slice(slash + 1)
  const result = emptyTranscript(session.file ?? null)
  result.id = session.id
  result.title = session.title ?? null
  result.cwd = session.cwd ?? null
  const messages = []
  let truncated = false

  await readJsonl(session.file, (entry) => {
    if (truncated || !entry || typeof entry !== 'object') return
    // Rows from a `sources.json` glob may omit `agent`; those belong to the
    // source id that produced the session id prefix, not to the adapter id.
    const rowAgent = entry.agent == null ? (agentId ?? 'inbox') : String(entry.agent)
    const rowSession = String(entry.session ?? entry.sessionId ?? '')
    if (agentId && rowAgent !== agentId) return
    if (rowSession && rowSession !== sessionId) return
    const text = typeof entry.text === 'string' ? entry.text : ''
    if (!text.trim()) return
    const clamped = clampText(text, MAX_TEXT)
    const role = String(entry.role ?? 'note').toLowerCase()
    messages.push({
      role: role === 'note' ? 'agent' : role,
      kind: 'message',
      ts: entry.ts ?? null,
      name: entry.name ?? null,
      text: clamped.text,
      truncated: clamped.truncated,
    })
    if (messages.length >= maxMessages) truncated = true
  })

  result.messages = messages
  result.messageCount = messages.length
  result.userPromptCount = messages.filter((message) => message.role === 'user').length
  result.hasToolCalls = messages.some((message) => message.role === 'tool')
  result.truncated = truncated
  return result
}
