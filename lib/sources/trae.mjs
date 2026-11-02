/**
 * trae.mjs — Trae (CN) as a session source.
 *
 * Trae is a VS Code fork whose chat lives on the vendor's servers: there is no
 * local rollout file, no per-message cache, and `state.vscdb` only holds UI
 * state (`ChatStore.turnsHeight`, `icube_session_agent_map`). What it *does*
 * write locally is a compact memory per completed turn —
 *
 *   ~/.trae-cn/memory/projects/<project>/<yyyyMMdd>/session_memory_<session>.jsonl
 *     {"intent","actions":[],"outcome","learned":[],"message_summary_time",
 *      "message_id","compact_summary_meta":{...}}
 *   ~/.trae-cn/memory/projects/<project>/<yyyyMMdd>/topics.md
 *     "[session_id: … | topic_summary_time: …]<prose topic summary>"
 *
 * so this adapter indexes *summaries*, not transcripts: one row per session,
 * title and searchable prompts taken from `topics.md` / `intent` / `outcome`,
 * and `readTranscript` replays the summary timeline with an explicit note that
 * the original messages are not on this machine. That is honest and still fills
 * the gap — before this adapter those sessions appeared nowhere in the hub.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { normalizeSession, localIso, mergePrompts, titleFromText, clampText, emptyTranscript, mapWithConcurrency } from './base.mjs'

export const meta = {
  id: 'trae',
  label: 'Trae',
  order: 40,
  remote: false,
}

const MAX_TEXT = 4000
const MEMORY_DIRS = ['.trae-cn/memory', '.trae/memory']
const WORKSPACE_ROOTS = [
  'AppData/Roaming/Trae CN/User/workspaceStorage',
  'AppData/Roaming/Trae/User/workspaceStorage',
  'Library/Application Support/Trae CN/User/workspaceStorage',
  'Library/Application Support/Trae/User/workspaceStorage',
  '.config/Trae CN/User/workspaceStorage',
  '.config/Trae/User/workspaceStorage',
]

const homeOf = (ctx) => {
  const home = typeof ctx?.home === 'string' && ctx.home ? ctx.home : os.homedir()
  return home
}

function memoryRoot(home) {
  for (const rel of MEMORY_DIRS) {
    const full = path.join(home, rel)
    try {
      if (fs.statSync(full).isDirectory()) return full
    } catch {
      /* try the next candidate */
    }
  }
  return null
}

/** Trae's project directory names are a lossy cwd encoding, e.g.
 *  `-d-Users-80407921-Documents--p2-a3e798753adaa7d0343b`. Normalize a real
 *  cwd the same way and keep the candidates that are a prefix of the name. */
function encodeCwd(cwd) {
  return String(cwd)
    .replace(/[\\/:]+/g, '-')
    .replace(/^([A-Za-z])-/, (_m, drive) => `-${drive.toLowerCase()}-`)
    .replace(/-+$/, '')
    .toLowerCase()
}

function readWorkspaces(home) {
  const out = []
  for (const rel of WORKSPACE_ROOTS) {
    const dir = path.join(home, rel)
    let names = []
    try {
      names = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      try {
        const doc = JSON.parse(fs.readFileSync(path.join(dir, name, 'workspace.json'), 'utf8'))
        const folder = doc?.folder
        if (typeof folder !== 'string' || !folder.startsWith('file://')) continue
        const decoded = decodeURIComponent(folder.replace(/^file:\/\/\/?/, ''))
        const cwd = decoded
          .replace(/^\/([A-Za-z])\//, (_m, drive) => `${drive.toUpperCase()}:\\`)
          .replace(/^([A-Za-z]):\//, (_m, drive) => `${drive.toUpperCase()}:\\`)
          .replace(/\//g, '\\')
        out.push({ cwd, encoded: encodeCwd(cwd) })
      } catch {
        /* a workspace without workspace.json is not interesting */
      }
    }
  }
  return out
}

/** Best-effort project → cwd, only when a real workspace path matches. */
function cwdForProject(project, workspaces) {
  const name = project.toLowerCase()
  let best = null
  for (const ws of workspaces) {
    if (!ws.encoded || !name.startsWith(ws.encoded)) continue
    if (!best || ws.encoded.length > best.encoded.length) best = ws
  }
  return best?.cwd ?? null
}

/** `2026-10-12 10:15:44` (Trae writes local wall-clock, no offset). */
function parseWallClock(value) {
  if (typeof value !== 'string') return null
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(value.trim())
  if (!match) return null
  const [, y, mo, d, h, mi, s] = match
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s))
  return Number.isNaN(date.getTime()) ? null : localIso(date)
}

function readTopics(file) {
  const out = new Map()
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return out
  }
  const header = /\[session_id:\s*([^\s|\]]+)\s*\|\s*topic_summary_time:\s*([^\]]+)\]\s*([\s\S]*?)(?=\n\[session_id:|$)/g
  let match
  while ((match = header.exec(text)) !== null) {
    const [, id, time, body] = match
    const clean = String(body).replace(/\s+/g, ' ').trim()
    if (!clean) continue
    out.set(id, { text: clean, at: parseWallClock(time) })
  }
  return out
}

/** Every `<project>/<day>/session_memory_*.jsonl` file, grouped by session id. */
function collectMemoryFiles(root) {
  const bySession = new Map()
  const topics = new Map()
  let projects = []
  try {
    projects = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    return { bySession, topics, projects }
  }
  for (const project of projects) {
    const projectDir = path.join(root, project)
    let days = []
    try {
      days = fs.readdirSync(projectDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    } catch {
      continue
    }
    for (const day of days) {
      const dayDir = path.join(projectDir, day)
      for (const [id, value] of readTopics(path.join(dayDir, 'topics.md'))) {
        const previous = topics.get(id)
        // Newest topic summary wins: it covers the whole session, not one turn.
        if (!previous || String(value.at ?? '') >= String(previous.at ?? '')) topics.set(id, { ...value, project })
      }
      let files = []
      try {
        files = fs.readdirSync(dayDir).filter((name) => name.startsWith('session_memory_') && name.endsWith('.jsonl'))
      } catch {
        continue
      }
      for (const name of files) {
        const id = name.slice('session_memory_'.length, -'.jsonl'.length)
        const list = bySession.get(id) ?? []
        list.push({ file: path.join(dayDir, name), project, day })
        bySession.set(id, list)
      }
    }
  }
  return { bySession, topics, projects }
}

function readRecords(files) {
  const records = []
  let badLines = 0
  let bytes = 0
  for (const { file } of files) {
    let text = ''
    try {
      text = fs.readFileSync(file, 'utf8')
      bytes += Buffer.byteLength(text)
    } catch {
      badLines += 1
      continue
    }
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line)
        if (entry && typeof entry === 'object') records.push(entry)
        else badLines += 1
      } catch {
        badLines += 1
      }
    }
  }
  records.sort((a, b) => String(a.message_summary_time ?? '').localeCompare(String(b.message_summary_time ?? '')))
  return { records, badLines, bytes }
}

function recordText(record) {
  const parts = []
  if (typeof record.intent === 'string' && record.intent.trim()) parts.push(record.intent.trim())
  if (typeof record.outcome === 'string' && record.outcome.trim()) parts.push(record.outcome.trim())
  for (const item of Array.isArray(record.learned) ? record.learned : []) {
    if (typeof item === 'string' && item.trim()) parts.push(item.trim())
  }
  return parts
}

export function detect(ctx = {}) {
  const home = homeOf(ctx)
  const root = memoryRoot(home)
  if (!root) return false
  try {
    return fs.readdirSync(root).some((name) => name === 'projects')
  } catch {
    return false
  }
}

export async function scan(ctx = {}) {
  const home = homeOf(ctx)
  const root = memoryRoot(home)
  const warnings = []
  if (!root) {
    return { sessions: [], warnings: ['未找到 Trae 的记忆目录（~/.trae-cn/memory）'], stats: { sessions: 0, files: 0 } }
  }
  const projectsDir = path.join(root, 'projects')
  const { bySession, topics, projects } = collectMemoryFiles(projectsDir)
  const workspaces = readWorkspaces(home)

  const ids = [...bySession.keys()]
  const scanned = await mapWithConcurrency(ids, 8, async (id) => {
    const files = bySession.get(id)
    return { id, ...readRecords(files), files, project: files[0]?.project ?? null }
  })

  const sessions = []
  let badLines = 0
  let bytes = 0
  for (const item of scanned) {
    badLines += item.badLines
    bytes += item.bytes
    const topic = topics.get(item.id)
    const prompts = []
    if (topic?.text) prompts.push(topic.text)
    for (const record of item.records) prompts.push(...recordText(record))
    const first = item.records[0]?.message_summary_time
    const last = item.records[item.records.length - 1]?.message_summary_time
    const cwd = cwdForProject(item.project ?? '', workspaces)
    const fallbackTitle = topic?.text ? titleFromText(topic.text) : titleFromText(prompts[0])
    sessions.push(
      normalizeSession(meta.id, {
        id: item.id,
        title: fallbackTitle || `Trae 会话 ${item.id.slice(0, 8)}`,
        cwd,
        file: item.files[0]?.file ?? null,
        createdAt: parseWallClock(first) ?? topic?.at ?? null,
        updatedAt: parseWallClock(last) ?? topic?.at ?? null,
        prompts: mergePrompts(prompts),
        sizeBytes: item.bytes,
        hasToolCalls: false,
        // Trae keeps no message bodies locally; say so once, here, so the panel
        // and the API can label the row instead of implying a full transcript.
        extra: {
          summaryOnly: true,
          project: item.project,
          memoryFiles: item.files.map((entry) => entry.file),
          memoryRecords: item.records.length,
          topic: Boolean(topic),
          app: 'Trae',
        },
      }),
    )
  }

  const withoutMemory = projects.length > 0 ? `（${projects.length} 个项目目录）` : ''
  if (sessions.length === 0) warnings.push(`Trae 没有可读的记忆摘要${withoutMemory}`)
  if (badLines > 0) warnings.push(`Trae 有 ${badLines} 行记忆摘要无法解析`)

  return {
    sessions,
    warnings,
    stats: {
      files: [...bySession.values()].reduce((total, list) => total + list.length, 0),
      sessions: sessions.length,
      projects: projects.length,
      bytes,
      badLines,
      summaryOnly: true,
    },
  }
}

/** Replay the summary timeline. There is no message body to replay. */
export async function readTranscript(session, ctx = {}) {
  const maxMessages = ctx.maxMessages ?? 400
  const extra = session.extra ?? {}
  const listed = Array.isArray(extra.memoryFiles) ? extra.memoryFiles : []
  const files = listed.length
    ? listed.map((entry) => (typeof entry === 'string' ? { file: entry } : entry)).filter((entry) => entry && entry.file)
    : (() => {
        const out = []
        const root = memoryRoot(homeOf(ctx))
        if (!root || !extra.project) return out
        const projectsDir = path.join(root, 'projects', String(extra.project))
        let days = []
        try {
          days = fs.readdirSync(projectsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
        } catch {
          return out
        }
        for (const day of days) {
          const file = path.join(projectsDir, day, `session_memory_${session.id}.jsonl`)
          if (fs.existsSync(file)) out.push({ file, project: extra.project, day })
        }
        return out
      })()

  const { records, badLines } = readRecords(files)
  const result = emptyTranscript(files[0]?.file ?? session.file ?? null)
  result.id = session.id
  result.title = session.title ?? null
  result.cwd = session.cwd ?? null
  result.model = session.model ?? null
  result.createdAt = session.createdAt ?? null
  result.updatedAt = session.updatedAt ?? null
  result.summaryOnly = true
  result.badLines = badLines

  const messages = [
    {
      role: 'note',
      kind: 'note',
      ts: null,
      text:
        'Trae 只在本地保存「记忆摘要」，不保存原始对话：下面是每个已完成回合的 intent / outcome / learned。' +
        '原始消息在 Trae 云端，本机读不到。',
    },
  ]
  let truncated = false
  for (const record of records) {
    if (messages.length >= maxMessages) {
      truncated = true
      break
    }
    const ts = parseWallClock(record.message_summary_time)
    if (typeof record.intent === 'string' && record.intent.trim()) {
      messages.push({ role: 'user', kind: 'message', ts, text: clampText(record.intent.trim(), MAX_TEXT).text })
      if (messages.length >= maxMessages) {
        truncated = true
        break
      }
    }
    const body = []
    if (typeof record.outcome === 'string' && record.outcome.trim()) body.push(record.outcome.trim())
    const actions = (Array.isArray(record.actions) ? record.actions : []).filter((item) => typeof item === 'string' && item.trim())
    if (actions.length) body.push(`动作：${actions.join('；')}`)
    const learned = (Array.isArray(record.learned) ? record.learned : []).filter((item) => typeof item === 'string' && item.trim())
    if (learned.length) body.push(`学到：${learned.join('；')}`)
    if (body.length) messages.push({ role: 'assistant', kind: 'summary', ts, text: clampText(body.join('\n'), MAX_TEXT).text })
  }

  result.messages = messages
  result.messageCount = messages.length
  result.userPromptCount = messages.filter((message) => message.role === 'user').length
  result.hasToolCalls = false
  result.truncated = truncated
  return result
}

export default { meta, detect, scan, readTranscript }
