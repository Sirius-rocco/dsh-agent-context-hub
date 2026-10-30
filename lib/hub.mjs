/**
 * hub.mjs — merge every source adapter into one index the panel, the CLI and
 * the HTTP API all read.
 *
 * The merge is deliberately cwd-first: a project group shows what Codex, Claude
 * and DSH each did in the same folder, newest first. That is the "switching
 * agents must not leave a gap" requirement expressed as data.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { ADAPTERS } from './sources/index.mjs'
import { groupKey, projectLabel, localIso, mapWithConcurrency } from './sources/base.mjs'
import { indexFile as defaultIndexFile, remoteDir as defaultRemoteDir, ensureLayout } from './paths.mjs'

/** Bumped whenever the on-disk shape changes; the host refuses older files. */
export const INDEX_VERSION = 5

function adapterWarningTail(warnings, limit = 6) {
  if (!Array.isArray(warnings) || warnings.length === 0) return []
  const head = warnings.slice(0, limit)
  if (warnings.length > limit) head.push(`…另有 ${warnings.length - limit} 条同类提示`)
  return head
}

/**
 * Run every adapter and merge the results.
 *
 * @param {{home?: string, deep?: boolean, concurrency?: number, maxAgeMs?: number,
 *          adapters?: typeof ADAPTERS, codexRoots?: string[], remoteDir?: string}} [options]
 */
export async function scanAll(options = {}) {
  const started = Date.now()
  const home = options.home
  const adapters = options.adapters ?? ADAPTERS
  const warnings = []
  const sources = []
  const sessions = []
  let duplicates = 0
  let unreadable = 0
  let badLines = 0
  let badLinesScope = 'head'
  let windowTruncations = 0
  let files = 0
  let totalBytes = 0
  let remoteFiles = 0
  let remoteBytes = 0
  let remoteShadowsLocal = 0

  const ctx = {
    home,
    deep: options.deep === true,
    concurrency: Math.min(Math.max(Number(options.concurrency ?? 10), 1), 24),
    maxPrompts: 20,
    codexRoots: options.codexRoots,
    // Every entry point (HTTP, CLI, tests) must read the same fragment directory.
    remoteDir: options.remoteDir ?? defaultRemoteDir(),
  }

  for (const adapter of adapters) {
    const meta = adapter.meta ?? { id: 'unknown', label: '未知来源', order: 999 }
    const sourceStarted = Date.now()
    let detected = false
    try {
      detected = adapter.detect ? adapter.detect(ctx) === true : true
    } catch {
      detected = false
    }
    if (!detected) {
      sources.push({ id: meta.id, label: meta.label, order: meta.order, detected: false, sessions: 0, files: 0, bytes: 0, ms: 0, error: null, warnings: 0 })
      continue
    }
    try {
      const result = (await adapter.scan(ctx)) ?? {}
      const rows = Array.isArray(result.sessions) ? result.sessions : []
      const stats = result.stats ?? {}
      // Adapters may dedupe internally; enforce it once more so the counts in
      // `stats` and the rows in the panel can never disagree.
      const seen = new Map()
      for (const row of rows) {
        const key = `${meta.id}\u0000${String(row.id).toLowerCase()}`
        const previous = seen.get(key)
        if (!previous) {
          seen.set(key, row)
          continue
        }
        duplicates += 1
        const keepNew = (row.sizeBytes ?? 0) > (previous.sizeBytes ?? 0)
        const kept = keepNew ? row : previous
        const dropped = keepNew ? previous : row
        kept.duplicateFiles = [...(previous.duplicateFiles ?? []), ...(row.duplicateFiles ?? []), dropped.file].filter(Boolean)
        seen.set(key, kept)
      }
      for (const row of seen.values()) sessions.push(row)
      files += Number(stats.files ?? rows.length)
      totalBytes += Number(stats.totalBytes ?? stats.bytes ?? stats.compressedBytes ?? 0)
      duplicates += Number(stats.duplicates ?? 0)
      unreadable += Number(stats.unreadable ?? 0)
      badLines += Number(stats.badLines ?? 0)
      if (stats.badLinesScope === 'full') badLinesScope = 'full'
      windowTruncations += Number(stats.windowTruncations ?? 0)
      remoteFiles += Number(stats.remoteFiles ?? 0)
      remoteBytes += Number(stats.remoteBytes ?? 0)
      remoteShadowsLocal += Number(stats.remoteShadowsLocal ?? 0)
      const ownWarnings = Array.isArray(result.warnings) ? result.warnings : []
      for (const line of adapterWarningTail(ownWarnings)) warnings.push(`[${meta.label}] ${line}`)
      sources.push({
        id: meta.id,
        label: meta.label,
        order: meta.order,
        detected: true,
        sessions: rows.length,
        files: Number(stats.files ?? rows.length),
        bytes: Number(stats.totalBytes ?? stats.bytes ?? stats.compressedBytes ?? 0),
        ms: Date.now() - sourceStarted,
        error: null,
        warnings: ownWarnings.length,
        stats,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      warnings.push(`[${meta.label}] 扫描失败：${message}`)
      sources.push({
        id: meta.id,
        label: meta.label,
        order: meta.order,
        detected: true,
        sessions: 0,
        files: 0,
        bytes: 0,
        ms: Date.now() - sourceStarted,
        error: message,
        warnings: 0,
      })
    }
  }

  // Group by cwd across agents.
  const groups = new Map()
  for (const session of sessions) {
    const key = groupKey(session.cwd)
    if (!groups.has(key)) {
      groups.set(key, { key, label: projectLabel(session.cwd), cwd: session.cwd ?? null, sessions: [], agents: {} })
    }
    const group = groups.get(key)
    group.sessions.push(session)
    group.agents[session.agent] = (group.agents[session.agent] ?? 0) + 1
  }
  const groupList = [...groups.values()].map((group) => {
    group.sessions.sort((a, b) => (Date.parse(b.updatedAt ?? 0) || 0) - (Date.parse(a.updatedAt ?? 0) || 0))
    group.updatedAt = group.sessions[0]?.updatedAt ?? null
    group.count = group.sessions.length
    return group
  })
  groupList.sort((a, b) => (Date.parse(b.updatedAt ?? 0) || 0) - (Date.parse(a.updatedAt ?? 0) || 0))

  const hosts = [...new Set(sessions.filter((session) => session.host).map((session) => session.host))].sort()
  const byAgent = {}
  for (const session of sessions) {
    const bucket = byAgent[session.agent] ?? { sessions: 0, remote: 0, withPrompts: 0 }
    bucket.sessions += 1
    if (session.remote) bucket.remote += 1
    if ((session.prompts ?? []).length > 0) bucket.withPrompts += 1
    byAgent[session.agent] = bucket
  }
  const withPrompts = sessions.filter((session) => (session.prompts ?? []).length > 0).length
  const promptTotal = sessions.reduce((total, session) => total + (session.prompts ?? []).length, 0)
  if (badLines > 0) {
    warnings.push(
      `有 ${badLines} 行无法解析（${badLinesScope === 'full' ? '全量扫描' : '仅头部窗口内'}），相关会话正文可能不完整`,
    )
  }

  return {
    version: INDEX_VERSION,
    generatedAt: localIso(new Date()),
    sources: sources.sort((a, b) => a.order - b.order),
    hosts,
    stats: {
      files,
      sessions: sessions.length,
      duplicates,
      unreadable,
      badLines,
      badLinesScope,
      windowTruncations,
      totalBytes,
      groups: groupList.length,
      remoteSessions: sessions.filter((session) => session.remote).length,
      remoteFiles,
      remoteBytes,
      remoteShadowsLocal,
      withPrompts,
      promptTotal,
      scanMs: Date.now() - started,
      byAgent,
    },
    warnings,
    groups: groupList,
  }
}

export async function readIndex(file = defaultIndexFile()) {
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8'))
    if (!parsed || !Array.isArray(parsed.groups)) return null
    return parsed
  } catch {
    return null
  }
}

export async function writeIndex(index, file = defaultIndexFile()) {
  ensureLayout()
  const dir = path.dirname(file)
  await fsp.mkdir(dir, { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(index, null, 2), 'utf8')
  await fsp.rename(tmp, file)
  return file
}

/** Reuse a fresh index from disk; scan (and persist) when missing or stale. */
export async function ensureIndex(options = {}) {
  const file = options.indexFile ?? defaultIndexFile()
  const maxAgeMs = options.maxAgeMs ?? 10 * 60 * 1000
  if (!options.force) {
    const cached = await readIndex(file)
    const generated = Date.parse(cached?.generatedAt ?? '')
    if (cached && Number.isFinite(generated) && Date.now() - generated < maxAgeMs) return cached
  }
  const scanned = await scanAll(options)
  await writeIndex(scanned, file)
  return scanned
}

/**
 * Ids are only unique per agent (Codex and Claude both use UUIDs), so a lookup
 * accepts `agent:id` and falls back to a plain id when it is unambiguous.
 */
export function findSession(index, id) {
  const wanted = String(id ?? '').trim()
  if (!wanted) return null
  const lower = wanted.toLowerCase()
  const matches = []
  for (const group of index?.groups ?? []) {
    for (const session of group.sessions ?? []) {
      const plain = String(session.id ?? '').toLowerCase()
      const qualified = `${String(session.agent ?? '').toLowerCase()}:${plain}`
      if (qualified === lower || plain === lower) matches.push({ group, session, exact: qualified === lower })
    }
  }
  if (matches.length === 0) return null
  const exact = matches.filter((match) => match.exact)
  return exact.length > 0 ? exact[0] : matches[0]
}

export async function scanSources(options = {}) {
  return mapWithConcurrency(ADAPTERS, 1, (adapter) => adapter.meta.id).catch(() => [])
}
