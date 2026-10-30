/**
 * paths.mjs — where the hub keeps its state.
 *
 * Deliberately outside the package directory: after an npm/market install the
 * package may be read-only, and every agent on this machine (Codex, Claude,
 * scripts, another DSH profile) must be able to append to the same shared
 * context. One home for all of it.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** `~/.dsh/agent-context` unless DSH_AGENT_CONTEXT_HOME overrides it. */
export function dataHome() {
  const fromEnv = process.env.DSH_AGENT_CONTEXT_HOME
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv.trim())
  return path.join(os.homedir(), '.dsh', 'agent-context')
}

export function indexFile() {
  return path.join(dataHome(), 'index.json')
}

/** Append-only shared context log, one JSON object per line. */
export function sharedFile() {
  return path.join(dataHome(), 'shared.jsonl')
}

/** `remote-<host>.json` metadata fragments written by scripts/sync-remote.mjs. */
export function remoteDir() {
  return path.join(dataHome(), 'remote')
}

/** Universal drop folder: any agent can append JSONL here and be indexed. */
export function inboxDir() {
  return path.join(dataHome(), 'inbox')
}

/** Optional per-machine source configuration (extra roots, custom adapters). */
export function sourcesFile() {
  return path.join(dataHome(), 'sources.json')
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** Create every directory the hub writes to. */
export function ensureLayout() {
  ensureDir(dataHome())
  ensureDir(remoteDir())
  ensureDir(inboxDir())
  return dataHome()
}
