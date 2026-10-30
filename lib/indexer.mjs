/**
 * indexer.mjs — build the Codex session index from rollout files (read-only).
 *
 * Two roots are scanned: the canonical ~/.codex/sessions and the mirror that
 * Codex keeps under Documents. The mirror still holds sessions the canonical
 * root has since cleaned up, so both are needed; a session present in both is
 * counted once and reported as a duplicate.
 *
 * Indexing is deliberately cheap: per file it reads only the head (session
 * metadata + first real user prompt) and, when the file has no usable mtime,
 * the tail. Message counts are NOT computed here — 2.7 GB of rollout would make
 * a scan minutes long; `readTranscript` counts exactly when a session is opened.
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readHeadInfo, readTailPrompts, titleFromText, isInjectionText, countBadLines, MAX_PROMPTS } from './parser.mjs'

export const INDEX_VERSION = 3

export function defaultRoots() {
  const fromEnv = process.env.CODEX_SESSION_ROOTS
  if (fromEnv && fromEnv.trim()) {
    return fromEnv.split(path.delimiter).map((entry) => entry.trim()).filter(Boolean)
  }
  return [
    path.join(os.homedir(), '.codex', 'sessions'),
    path.join(os.homedir(), 'Documents', '.codex', 'sessions'),
  ]
}

export function defaultIndexFile() {
  return path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'cache', 'index.json')
}

/** Directory holding `remote-<host>.json` fragments (metadata of ssh sessions). */
export function defaultRemoteDir() {
  return path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'cache')
}

/** Local ISO-8601 with the machine's offset, e.g. 2026-10-20T16:40:00+08:00. */
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

function walkJsonl(root) {
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
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full)
    }
  }
  return out
}

/** Canonical thread titles from session_index.jsonl (may contain noisy names). */
export async function readThreadNames(home = os.homedir()) {
  const map = new Map()
  const file = path.join(home, '.codex', 'session_index.jsonl')
  let text
  try {
    text = await fsp.readFile(file, 'utf8')
  } catch {
    return map
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    const id = entry?.id
    const name = typeof entry?.thread_name === 'string' ? entry.thread_name : ''
    if (!id || !name) continue
    // A usable title needs real characters and no replacement/mojibake markers.
    if (name.includes('\uFFFD')) continue
    if (!/[\p{L}\p{N}]/u.test(name)) continue
    map.set(String(id).toLowerCase(), name)
  }
  return map
}

function sessionIdFromFile(file) {
  const match = path.basename(file).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i)
  return match ? match[1].toLowerCase() : null
}

function projectLabel(cwd) {
  if (!cwd) return '未知项目'
  const parts = String(cwd).split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? String(cwd)
}

function groupKey(cwd) {
  if (!cwd) return '__unknown__'
  return String(cwd).replace(/[\\/]+$/, '').toLowerCase()
}

/**
 * Concatenate prompt lists (head window, tail window, remote fragment) into one
 * searchable snippet list: trimmed, de-duplicated, first-seen order preserved,
 * capped at MAX_PROMPTS items.
 */
function mergePrompts(...lists) {
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

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const runners = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

/**
 * Read every `remote-<host>.json` fragment.
 *
 * A broken one must not break the whole scan, but it must not disappear silently
 * either: a fragment that keeps failing would quietly drop remote sessions from
 * the panel, so the unreadable names are returned for the warnings list.
 *
 * @returns {Promise<{ fragments: object[], broken: string[] }>}
 */
async function readRemoteFragments(dir) {
  let names = []
  try {
    names = (await fsp.readdir(dir)).filter((name) => /^remote-[A-Za-z0-9._-]+\.json$/.test(name))
  } catch {
    return { fragments: [], broken: [] }
  }
  const fragments = []
  const broken = []
  for (const name of names.sort()) {
    const full = path.join(dir, name)
    try {
      const parsed = JSON.parse(await fsp.readFile(full, 'utf8'))
      if (parsed && Array.isArray(parsed.sessions)) fragments.push(parsed)
      else broken.push(name)
    } catch {
      // A half-written fragment (sync killed mid-write, disk full, mojibake) lands
      // here; keep going with the remaining hosts but report the file.
      broken.push(name)
    }
  }
  return { fragments, broken }
}

/**
 * Scan both roots and produce the index object described in CONTRACT.md.
 * @param {{roots?: string[], indexFile?: string|null, concurrency?: number, home?: string, remoteDir?: string}} [options]
 */
export async function scanSessions(options = {}) {
  const started = Date.now()
  const roots = options.roots ?? defaultRoots()
  const concurrency = options.concurrency ?? 12
  const deep = options.deep === true
  const warnings = []
  const threadNames = await readThreadNames(options.home ?? os.homedir())

  const candidates = []
  const rootStats = []
  for (let rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
    const root = roots[rootIndex]
    const files = walkJsonl(root)
    let bytes = 0
    for (const file of files) {
      let stat
      try {
        stat = await fsp.stat(file)
      } catch {
        warnings.push(`无法读取文件信息: ${file}`)
        continue
      }
      bytes += stat.size
      candidates.push({ file, rootIndex, size: stat.size, mtimeMs: stat.mtimeMs })
    }
    rootStats.push({ path: root, files: files.length, bytes, exists: fs.existsSync(root) })
    if (!fs.existsSync(root)) warnings.push(`数据根不存在: ${root}`)
  }

  const scanned = await mapWithConcurrency(candidates, concurrency, async (candidate) => {
    try {
      const info = await readHeadInfo(candidate.file)
      return { ...candidate, info, badLines: info.badLines ?? 0 }
    } catch (error) {
      return { ...candidate, info: null, error: error?.code ?? String(error?.message ?? error) }
    }
  })

  const unreadable = scanned.filter((entry) => entry.info === null)
  for (const entry of unreadable.slice(0, 10)) warnings.push(`无法解析: ${entry.file} (${entry.error})`)
  if (unreadable.length > 10) warnings.push(`…另有 ${unreadable.length - 10} 个文件无法解析`)

  // Deduplicate by session id: canonical root wins, then the larger file.
  const byId = new Map()
  let duplicates = 0
  for (const entry of scanned) {
    if (!entry.info) continue
    const id = (entry.info.id ?? sessionIdFromFile(entry.file) ?? '').toLowerCase()
    if (!id) continue
    const existing = byId.get(id)
    if (!existing) {
      byId.set(id, entry)
      continue
    }
    duplicates += 1
    const existingRank = [existing.rootIndex, -existing.size]
    const nextRank = [entry.rootIndex, -entry.size]
    const better = nextRank[0] < existingRank[0] || (nextRank[0] === existingRank[0] && nextRank[1] < existingRank[1])
    const kept = better ? entry : existing
    const dropped = better ? existing : entry
    // `entry` is always new here, so every copy collected so far lives on
    // `existing`; carry that list whichever file wins, otherwise the
    // per-session duplicateFiles lists stop summing to stats.duplicates.
    const carried = existing.duplicates ?? []
    kept.duplicates = [...carried, dropped.file]
    byId.set(id, kept)
  }

  // Content snippets for search: the head window was already parsed for
  // metadata, so only the wider tail window is read here, and only for the
  // files that survived deduplication.
  const keptEntries = [...byId.values()]
  const tailPrompts = await mapWithConcurrency(keptEntries, Math.min(concurrency, 8), async (entry) => {
    try {
      return (await readTailPrompts(entry.file, { max: 12 })).prompts
    } catch {
      return []
    }
  })
  const tailById = new Map()
  keptEntries.forEach((entry, index) => {
    const id = String(entry.info?.id ?? '').toLowerCase()
    if (id) tailById.set(id, tailPrompts[index] ?? [])
  })

  // Remote sessions live on an ssh host (their rollout files never leave the
  // server). `scripts/sync-remote.mjs` writes a metadata-only fragment; the
  // transcript is fetched over ssh on demand by index.js.
  const remoteDir = options.remoteDir ?? defaultRemoteDir()
  const { fragments: remoteFragments, broken: brokenFragments } = await readRemoteFragments(remoteDir)
  const remoteRows = []
  let remoteShadowsLocal = 0
  for (const name of brokenFragments) {
    warnings.push(
      `远程会话片段 ${name} 无法解析（同步中断或文件损坏），该主机的会话本次未纳入；重跑 scripts/sync-remote.mjs 可重建`,
    )
  }
  for (const fragment of remoteFragments) {
    for (const row of fragment.sessions ?? []) {
      const remoteId = String(row?.id ?? '').toLowerCase()
      if (!remoteId) continue
      if (byId.has(remoteId)) {
        remoteShadowsLocal += 1
        continue
      }
      if (remoteRows.some((entry) => entry.id === remoteId)) continue
      // The fragment host is the fallback: older/hand-written fragments only
      // carry it once at the top level, while sync-remote.mjs repeats it per row.
      remoteRows.push({ ...row, id: remoteId, host: row?.host ?? fragment.host ?? null })
    }
    const age = Date.now() - Date.parse(fragment.generatedAt ?? '')
    if (Number.isFinite(age) && age > 48 * 3600 * 1000) {
      warnings.push(
        `远程主机 ${fragment.host} 的会话索引已 ${Math.round(age / 3600000)} 小时未刷新（运行 scripts/sync-remote.mjs 或等待每日 09:45 任务）`,
      )
    }
  }

  const groups = new Map()
  const sessions = []
  const addSession = (session) => {
    sessions.push(session)
    const key = groupKey(session.cwd)
    if (!groups.has(key)) groups.set(key, { key, label: projectLabel(session.cwd), cwd: session.cwd ?? null, sessions: [] })
    groups.get(key).sessions.push(session)
  }
  for (const [id, entry] of byId) {
    const info = entry.info
    const cwd = info.cwd ?? null
    const label = projectLabel(cwd)
    const threadName = threadNames.get(id) ?? null
    const title =
      (threadName && threadName.trim()) ||
      titleFromText(info.firstUserText) ||
      `${label} · ${localIso(entry.mtimeMs)?.slice(5, 16) ?? ''}`
    addSession({
      id,
      title,
      cwd,
      sourceRoot: entry.rootIndex === 0 ? 'canonical' : entry.rootIndex === 1 ? 'mirror' : `root${entry.rootIndex}`,
      file: entry.file,
      createdAt: info.createdAt ? localIso(info.createdAt) : null,
      updatedAt: localIso(entry.mtimeMs),
      originator: info.originator ?? null,
      model: info.model ?? null,
      sizeBytes: entry.size,
      messageCount: null,
      userPromptCount: null,
      hasToolCalls: null,
      duplicateFiles: entry.duplicates ?? [],
      prompts: mergePrompts(info.prompts, tailById.get(id)),
    })
  }
  for (const row of remoteRows) {
    addSession({
      id: row.id,
      title: row.title ?? row.id,
      cwd: row.cwd ?? null,
      sourceRoot: row.host ?? 'remote',
      remote: true,
      host: row.host ?? null,
      file: row.file ?? null,
      createdAt: row.createdAt ?? null,
      updatedAt: row.updatedAt ?? row.createdAt ?? null,
      originator: row.originator ?? null,
      model: row.model ?? null,
      sizeBytes: row.sizeBytes ?? null,
      messageCount: null,
      userPromptCount: null,
      hasToolCalls: null,
      duplicateFiles: [],
      prompts: mergePrompts(row.prompts),
    })
  }

  const groupList = [...groups.values()].map((group) => {
    group.sessions.sort((a, b) => Date.parse(b.updatedAt ?? 0) - Date.parse(a.updatedAt ?? 0))
    group.updatedAt = group.sessions[0]?.updatedAt ?? null
    group.count = group.sessions.length
    return group
  })
  groupList.sort((a, b) => (Date.parse(b.updatedAt ?? 0) || 0) - (Date.parse(a.updatedAt ?? 0) || 0))

  // Bad-line accounting has two honest modes:
  //   head (default) — only the head window is parsed, so a malformed line past
  //                    256 KB is invisible; report what was actually seen.
  //   deep           — stream every kept rollout and count every failure.
  // Never claim the head count is a whole-file count.
  let badLines = 0
  let scannedLines = 0
  if (deep) {
    const keptFiles = [...byId.values()].map((entry) => entry.file)
    const counted = await mapWithConcurrency(keptFiles, Math.min(concurrency, 6), async (file) => {
      try {
        return await countBadLines(file)
      } catch {
        return { badLines: 0, lines: 0 }
      }
    })
    badLines = counted.reduce((total, item) => total + (item?.badLines ?? 0), 0)
    scannedLines = counted.reduce((total, item) => total + (item?.lines ?? 0), 0)
  } else {
    badLines = scanned.reduce((total, entry) => total + (entry.badLines ?? 0), 0)
  }
  const windowTruncations = scanned.filter((entry) => entry.info?.truncatedWindow).length
  if (badLines > 0) {
    warnings.push(
      deep
        ? `有 ${badLines} 行无法解析（全量扫描 ${scannedLines} 行），相关会话正文可能不完整`
        : `有 ${badLines} 行无法解析（仅头部窗口内；完整计数请用 --deep），相关会话正文可能不完整`,
    )
  }
  const indexedIds = new Set([...byId.keys(), ...remoteRows.map((row) => row.id)].map((id) => String(id).toLowerCase()))
  const missingRollouts = [...threadNames.keys()].filter((id) => !indexedIds.has(String(id).toLowerCase())).length
  if (threadNames.size > 0 && missingRollouts > 0) {
    warnings.push(
      `session_index 列出 ${threadNames.size} 个会话，其中 ${missingRollouts} 个没有本地或远程 rollout 文件（只有索引记录，正文不可读）`,
    )
  }
  const hosts = [...new Set(remoteRows.map((row) => row.host).filter(Boolean))].sort()
  const withPrompts = sessions.filter((session) => (session.prompts ?? []).length > 0).length
  const promptTotal = sessions.reduce((total, session) => total + (session.prompts ?? []).length, 0)
  const index = {
    version: INDEX_VERSION,
    generatedAt: localIso(new Date()),
    roots: rootStats,
    hosts,
    stats: {
      files: candidates.length,
      sessions: sessions.length,
      duplicates,
      unreadable: unreadable.length,
      badLines,
      badLinesScope: deep ? 'full' : 'head',
      windowTruncations,
      totalBytes: candidates.reduce((total, entry) => total + entry.size, 0),
      groups: groupList.length,
      remoteSessions: remoteRows.length,
      remoteFiles: remoteFragments.reduce((total, fragment) => total + (fragment.files ?? 0), 0),
      remoteBytes: remoteFragments.reduce((total, fragment) => total + (fragment.bytes ?? 0), 0),
      remoteShadowsLocal,
      withPrompts,
      promptTotal,
      scanMs: Date.now() - started,
    },
    warnings,
    groups: groupList,
  }

  if (options.indexFile) await writeIndex(options.indexFile, index)
  return index
}

export async function readIndex(indexFile) {
  try {
    const text = await fsp.readFile(indexFile, 'utf8')
    const parsed = JSON.parse(text)
    if (!parsed || !Array.isArray(parsed.groups)) return null
    return parsed
  } catch {
    return null
  }
}

export async function writeIndex(indexFile, index) {
  const dir = path.dirname(indexFile)
  await fsp.mkdir(dir, { recursive: true })
  const tmp = `${indexFile}.${process.pid}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(index, null, 2), 'utf8')
  await fsp.rename(tmp, indexFile)
  return indexFile
}

/** Reuse a fresh index from disk; scan (and persist) when it is missing or old. */
export async function ensureIndex(options = {}) {
  const indexFile = options.indexFile ?? defaultIndexFile()
  const maxAgeMs = options.maxAgeMs ?? 10 * 60 * 1000
  const cached = await readIndex(indexFile)
  if (cached && !options.force) {
    const generated = Date.parse(cached.generatedAt ?? '')
    if (Number.isFinite(generated) && Date.now() - generated < maxAgeMs) return cached
  }
  return scanSessions({ ...options, indexFile })
}

export function findSession(index, id) {
  const wanted = String(id ?? '').toLowerCase()
  if (!wanted) return null
  for (const group of index?.groups ?? []) {
    for (const session of group.sessions ?? []) {
      if (String(session.id ?? '').toLowerCase() === wanted) return { group, session }
    }
  }
  return null
}

export { isInjectionText }