/**
 * remote.mjs — read a Codex rollout that lives on an ssh host.
 *
 * Only the metadata of remote sessions is indexed locally (see
 * `scripts/sync-remote.mjs`); the body is streamed with `ssh <host> cat -- <path>`
 * on demand and never persisted. Shared by the host half (`index.js`) and the CLI,
 * so `cli.mjs show --id <remote-session>` behaves like the Web panel.
 */

import readline from 'node:readline'
import { spawn } from 'node:child_process'

/** Never prompt, never hang on a dead host. */
export const SSH_ARGS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15']
/** Give up on one remote rollout after this long. */
export const SSH_READ_TIMEOUT_MS = 60 * 1000
/** Host used when a session/fragment does not name one. */
export const DEFAULT_REMOTE_HOST = 'rag_research'

/** Single-quote a path for the remote shell (ssh joins argv into one command). */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/**
 * Stream one remote rollout through the parser.
 *
 * @param {{ collectTranscript: Function }} parser parser module from ./parser.mjs
 * @param {{ id: string, file?: string|null, host?: string|null }} session index row
 * @param {{ maxMessages?: number, timeoutMs?: number, host?: string }} [options]
 * @returns {Promise<object>} transcript plus `remote: true`, `host`, `fetchMs`
 */
export async function readRemoteTranscript(parser, session, options = {}) {
  const host = session?.host || options.host || DEFAULT_REMOTE_HOST
  const remotePath = session?.file
  if (typeof remotePath !== 'string' || !remotePath.startsWith('/')) {
    throw new Error(`session ${session?.id ?? '(unknown)'} has no usable remote path`)
  }
  const started = Date.now()
  const timeoutMs = options.timeoutMs ?? SSH_READ_TIMEOUT_MS
  const child = spawn('ssh', [...SSH_ARGS, host, `cat -- ${shellQuote(remotePath)}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const stderr = []
  child.stderr.on('data', (chunk) => {
    if (stderr.length < 16) stderr.push(chunk)
  })
  const closed = new Promise((resolve) => child.on('close', (code) => resolve(code ?? -1)))
  let exitCode = null
  child.on('exit', (code) => {
    exitCode = code
  })
  child.on('error', () => {})
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill()
  }, timeoutMs)

  let transcript = null
  let streamError = null
  try {
    transcript = await parser.collectTranscript(lines, {
      maxMessages: options.maxMessages,
      meta: session,
      file: remotePath,
      onStop: () => child.kill(),
    })
  } catch (error) {
    streamError = error
  } finally {
    clearTimeout(timer)
    lines.close()
  }

  // `cat` can close stdout before ssh itself is reaped, so wait for the real exit
  // event instead of killing immediately: killing here reported `-1` for what was
  // actually `ssh … exited 1` (found by the sixth independent verification round).
  let code = exitCode
  if (code === null) {
    code = await Promise.race([closed, new Promise((resolve) => setTimeout(() => resolve(null), 1000))])
  }
  if (code === null && child.exitCode === null && child.signalCode === null) {
    child.kill()
    code = await closed
  }
  if (!transcript) {
    if (timedOut) throw new Error(`ssh ${host} timed out after ${Math.round(timeoutMs / 1000)}s`)
    throw new Error(`ssh ${host} stream failed: ${streamError?.message ?? 'unknown error'}`)
  }
  if (transcript.messageCount === 0 && code !== 0) {
    const detail = Buffer.concat(stderr).toString('utf8').trim()
    throw new Error(`ssh ${host} exited ${code}${detail ? `: ${detail.slice(0, 300)}` : ''}`)
  }
  return { ...transcript, remote: true, host, fetchMs: Date.now() - started }
}
