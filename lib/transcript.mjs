/**
 * transcript.mjs — one entry point that reads any session, whatever agent it
 * came from. The HTTP layer and the CLI both call this so "open a session"
 * behaves the same for every source.
 */

import { ADAPTERS } from './sources/index.mjs'

export function adapterFor(agentId) {
  return ADAPTERS.find((adapter) => adapter.meta?.id === agentId) ?? null
}

export function adapterLabel(agentId) {
  return adapterFor(agentId)?.meta?.label ?? agentId ?? '未知来源'
}

/**
 * @param {{agent?: string, id?: string, file?: string, remote?: boolean, host?: string}} session
 * @param {{maxMessages?: number, timeoutMs?: number}} [options]
 */
export async function readSessionTranscript(session, options = {}) {
  const adapter = adapterFor(session?.agent)
  if (!adapter) {
    const error = new Error(`未知来源：${session?.agent ?? '(missing)'}`)
    error.code = 'EUNKNOWN_AGENT'
    throw error
  }
  return adapter.readTranscript(session, options)
}
