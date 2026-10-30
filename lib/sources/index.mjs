/**
 * sources/index.mjs — the adapter registry.
 *
 * The hub knows nothing about any single agent: it walks this array, asks each
 * adapter whether its data exists (`detect`), scans it, and merges the results
 * into one index. Adding support for another coding agent means adding a file
 * that follows `docs/ADAPTER-CONTRACT.md` and one line here — nothing else in
 * the package changes.
 *
 * Order matters only for display: `order` sorts the source chips in the panel,
 * and ties fall back to this array's order.
 */

import * as codex from './codex.mjs'
import * as claudeCode from './claude-code.mjs'
import * as dsh from './dsh.mjs'
import * as inbox from './inbox.mjs'

/**
 * Registered adapters. `inbox` stays last: it is the generic, always-available
 * path for an agent nobody has written an adapter for yet.
 */
export const ADAPTERS = [codex, claudeCode, dsh, inbox]

export function adapterById(id) {
  const key = String(id ?? '').toLowerCase()
  return ADAPTERS.find((adapter) => adapter.meta.id === key) ?? null
}

export default ADAPTERS
