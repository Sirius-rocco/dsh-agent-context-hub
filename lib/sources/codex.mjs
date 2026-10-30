/**
 * codex.mjs — Codex CLI/desktop sessions (the original source).
 *
 * Two on-disk roots are scanned by `../indexer.mjs`: the canonical
 * `~/.codex/sessions` and the Documents mirror that keeps sessions the
 * canonical root has already pruned. Sessions on an ssh host arrive as
 * metadata fragments and their transcript is read over ssh on demand.
 */

import fs from 'node:fs'
import { scanSessions, defaultRoots, INDEX_VERSION as CODEX_INDEX_VERSION } from '../indexer.mjs'
import * as parserModule from '../parser.mjs'
import { readRemoteTranscript } from '../remote.mjs'
import { normalizeSession } from './base.mjs'

export const meta = {
  id: 'codex',
  label: 'Codex',
  order: 10,
  remote: true,
}

export function detect(ctx) {
  const roots = ctx?.codexRoots ?? defaultRoots()
  return roots.some((root) => {
    try {
      return Boolean(root) && fs.existsSync(root)
    } catch {
      return false
    }
  })
}

export async function scan(ctx) {
  const index = await scanSessions({
    roots: ctx?.codexRoots ?? undefined,
    indexFile: null,
    deep: ctx?.deep === true,
    remoteDir: ctx?.remoteDir,
    home: ctx?.home,
    concurrency: ctx?.concurrency,
  })
  const sessions = []
  for (const group of index.groups ?? []) {
    for (const row of group.sessions ?? []) {
      sessions.push(normalizeSession(meta.id, { ...row, cwd: row.cwd ?? group.cwd ?? null }))
    }
  }
  return {
    sessions,
    warnings: index.warnings ?? [],
    stats: {
      ...index.stats,
      indexVersion: CODEX_INDEX_VERSION,
      roots: index.roots ?? [],
      hosts: index.hosts ?? [],
    },
  }
}

export async function readTranscript(session, ctx = {}) {
  const maxMessages = ctx.maxMessages ?? 400
  if (session.remote === true) {
    const transcript = await readRemoteTranscript(parserModule, session, { maxMessages, timeoutMs: ctx.timeoutMs })
    return { ...transcript, remote: true, host: session.host ?? transcript.host ?? null }
  }
  return parserModule.readTranscript(session.file, { maxMessages, meta: session })
}
