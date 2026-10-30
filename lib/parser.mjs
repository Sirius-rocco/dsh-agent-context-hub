/**
 * parser.mjs — read Codex rollout JSONL (read-only).
 *
 * Observed line shapes (see FORMAT.md for samples):
 *   { timestamp, ordinal, type, payload }
 *   type=session_meta            payload: session_id, id, cwd, timestamp, originator, cli_version, source, model_provider
 *   type=response_item           payload.type ∈ message | reasoning | custom_tool_call | custom_tool_call_output
 *                                              | function_call | function_call_output | compaction | additional_tools
 *   type=event_msg               payload.type ∈ token_count | item_completed | task_started
 *                                              | thread_settings_applied | task_complete | turn_aborted
 *   type=turn_context | world_state | token_usage_record  (metadata, not transcript)
 *
 * Nothing here writes: Codex may hold the file open while a session is live, and
 * plain `fs` reads (libuv shares read+write+delete) work on those files.
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import readline from 'node:readline'

/** Injected context that Codex records as if it were a user turn. */
const INJECTION_PREFIXES = [
  '<permissions instructions>',
  '<collaboration_mode>',
  '<environment_context>',
  '<recommended_plugins>',
  '<multi_agent_mode>',
  '<user_instructions>',
  '<tool_guidelines>',
  '<world_state>',
  '<skills_instructions>',
  '<plugins_instructions>',
  '<apps_instructions>',
]
/** Injected instruction blocks whose opening line is plain text, not a tag. */
const INJECTION_MARKERS = ['# AGENTS.md instructions for', '<INSTRUCTIONS>']

const HEAD_BYTES = 256 * 1024
const TAIL_BYTES = 64 * 1024
// Content snippets are wider than the metadata window: the index stores a few
// real user prompts per session so the panel search can match content, not just
// titles. Measured cost of a 1 MiB head + 256 KiB tail over 90 files: ~75 MB and
// well under a second (see FORMAT.md).
const SNIPPET_HEAD_BYTES = 1024 * 1024
const SNIPPET_TAIL_BYTES = 256 * 1024
const MAX_PROMPTS = 40
const PROMPT_CHARS = 200
const TOOL_OUTPUT_LIMIT = 4000
const TEXT_LIMIT = 120_000

/**
 * True when a "user" message is really injected context rather than something a
 * human typed: a known harness tag, or a payload that is nothing but a single
 * XML-ish tag (for example `<external_codex_apps_open_page>{"page_id":null}</…>`).
 */
export function isInjectionText(text) {
  const trimmed = String(text ?? '').trimStart()
  if (INJECTION_MARKERS.some((marker) => trimmed.includes(marker))) return true
  if (!trimmed.startsWith('<')) return false
  if (INJECTION_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) return true
  return /^<([a-zA-Z_][\w.-]*)(\s[^>]*)?>[\s\S]*<\/\1>\s*$/.test(trimmed)
}

function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const item of content) {
    if (typeof item === 'string') parts.push(item)
    else if (item && typeof item.text === 'string') parts.push(item.text)
  }
  return parts.join('\n')
}

function clampText(text, limit) {
  const value = String(text ?? '')
  if (value.length <= limit) return { text: value, truncated: false }
  return { text: value.slice(0, limit), truncated: true }
}

/**
 * Collapse a snippet candidate to one bounded line, or null when it carries no
 * information (empty / injected context).
 */
function normalizePrompt(text, limit = PROMPT_CHARS) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!flat) return null
  if (isInjectionText(flat)) return null
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

/**
 * Extract the real user prompts from rollout lines (string, possibly cut at the
 * end). Injected context, developer/system turns and assistant output are all
 * excluded, because the index uses this list for content search.
 */
export function collectPrompts(text, opts = {}) {
  const max = opts.max ?? MAX_PROMPTS
  const limit = opts.limit ?? PROMPT_CHARS
  const prompts = []
  const seen = new Set()
  if (max <= 0 || !text) return prompts
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    const payload = entry?.payload
    if (entry?.type !== 'response_item' || payload?.type !== 'message') continue
    if (payload.role !== 'user') continue
    const flat = normalizePrompt(contentText(payload.content), limit)
    if (!flat || seen.has(flat)) continue
    seen.add(flat)
    prompts.push(flat)
    if (prompts.length >= max) break
  }
  return prompts
}

/** Human-readable one-liner for a tool call's arguments. */
function summarizeToolInput(name, input) {
  const raw = typeof input === 'string' ? input : JSON.stringify(input ?? '')
  if (name === 'exec' || name === 'shell' || name === 'shell_command') {
    const command = raw.match(/"command"\s*:\s*"((?:[^"\\]|\\.)*)"/)
    if (command) return command[1].replace(/\\"/g, '"').replace(/\\n/g, '\n')
  }
  return raw
}

/**
 * Readable body of an inter-agent message: everything after the last
 * "Payload:" header line. Encrypted-only messages yield ''.
 */
function agentMessageBody(content) {
  const parts = Array.isArray(content) ? content : []
  const plain = parts
    .filter((item) => item && item.type !== 'encrypted_content' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n')
  const marker = plain.lastIndexOf('Payload:')
  return (marker === -1 ? plain : plain.slice(marker + 'Payload:'.length)).trim()
}

function pushMessage(messages, message) {
  if (!message) return
  const text = String(message.text ?? '')
  if (!text.trim()) return
  messages.push(message)
}

function messageFromResponseItem(payload, timestamp, messages) {
  switch (payload?.type) {
    case 'message': {
      const role = payload.role
      if (role !== 'user' && role !== 'assistant') return
      const text = contentText(payload.content)
      if (role === 'user' && isInjectionText(text)) return
      const clamped = clampText(text, TEXT_LIMIT)
      pushMessage(messages, {
        role,
        kind: 'message',
        ts: timestamp ?? null,
        text: clamped.text,
        truncated: clamped.truncated,
      })
      return
    }
    case 'custom_tool_call':
    case 'function_call': {
      const name = payload.name ?? 'tool'
      const input = payload.type === 'function_call' ? payload.arguments : payload.input
      const clamped = clampText(summarizeToolInput(name, input), TOOL_OUTPUT_LIMIT)
      pushMessage(messages, {
        role: 'tool',
        kind: 'tool_call',
        ts: timestamp ?? null,
        name,
        text: clamped.text,
        truncated: clamped.truncated,
      })
      return
    }
    case 'custom_tool_call_output':
    case 'function_call_output': {
      const clamped = clampText(contentText(payload.output), TOOL_OUTPUT_LIMIT)
      pushMessage(messages, {
        role: 'tool',
        kind: 'tool_output',
        ts: timestamp ?? null,
        name: payload.name ?? null,
        text: clamped.text,
        truncated: clamped.truncated,
      })
      return
    }
    case 'agent_message': {
      // Inter-agent traffic (`author` → `recipient`). The readable body sits
      // after the "Payload:" header; encrypted-only payloads leave nothing
      // behind and are dropped by `pushMessage`.
      const text = agentMessageBody(payload.content)
      const clamped = clampText(text, TEXT_LIMIT)
      pushMessage(messages, {
        role: 'agent',
        kind: 'agent_message',
        ts: timestamp ?? null,
        name: payload.author ?? payload.recipient ?? null,
        text: clamped.text,
        truncated: clamped.truncated,
      })
      return
    }
    case 'web_search_call': {
      const action = payload.action ?? {}
      const query = action.query ?? (Array.isArray(action.queries) ? action.queries.join(' ') : '')
      const clamped = clampText(query, TOOL_OUTPUT_LIMIT)
      pushMessage(messages, {
        role: 'tool',
        kind: 'tool_call',
        ts: timestamp ?? null,
        name: 'web_search',
        text: clamped.text,
        truncated: clamped.truncated,
      })
      return
    }
    default:
      // reasoning (encrypted), compaction, additional_tools: no displayable text.
      return
  }
}

function emptyTranscript(file) {
  return {
    id: null,
    title: null,
    cwd: null,
    model: null,
    createdAt: null,
    updatedAt: null,
    file,
    messages: [],
    messageCount: 0,
    truncated: false,
  }
}

/**
 * Parse a whole rollout body. Used by tests and by small files; `readTranscript`
 * streams instead so a 169 MB session does not have to fit in memory.
 */
export function parseRolloutText(text, opts = {}) {
  const maxMessages = opts.maxMessages ?? Infinity
  const result = emptyTranscript(opts.file ?? null)
  const messages = []
  let truncated = false
  let badLines = 0
  let userPromptCount = 0
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      badLines += 1
      continue
    }
    const payload = entry?.payload
    if (entry?.type === 'session_meta' && payload) {
      result.id = payload.session_id ?? payload.id ?? result.id
      result.cwd = payload.cwd ?? result.cwd
      result.createdAt = payload.timestamp ?? result.createdAt
      result.model = payload.model ?? result.model
      continue
    }
    if (entry?.type === 'event_msg' && payload?.type === 'thread_settings_applied') {
      result.model = payload.model ?? result.model
      continue
    }
    if (entry?.type !== 'response_item') continue
    const before = messages.length
    messageFromResponseItem(payload, entry.timestamp, messages)
    if (messages.length > before && payload?.role === 'user') userPromptCount += 1
    if (messages.length >= maxMessages) {
      truncated = true
      break
    }
    result.updatedAt = entry.timestamp ?? result.updatedAt
  }
  result.messages = messages
  result.messageCount = messages.length
  result.userPromptCount = userPromptCount
  result.truncated = truncated
  result.badLines = badLines
  return result
}

/**
 * Consume rollout lines from any async iterable (a file readline stream, an SSH
 * stdout readline stream, ...) into a transcript, stopping once `maxMessages` is
 * reached. `opts.onStop` runs when we stopped early so the caller can kill the
 * producer (e.g. destroy the ssh child process).
 */
export async function collectTranscript(lines, opts = {}) {
  const maxMessages = opts.maxMessages ?? 400
  const result = emptyTranscript(opts.file ?? null)
  const meta = opts.meta ?? null
  const messages = []
  let truncated = false
  let userPromptCount = 0
  let badLines = 0
  let stopped = false

  try {
    for await (const line of lines) {
      if (!line.trim()) continue
      let entry
      try {
        entry = JSON.parse(line)
      } catch {
        badLines += 1
        continue
      }
      const payload = entry?.payload
      if (entry?.type === 'session_meta' && payload) {
        result.id = payload.session_id ?? payload.id ?? result.id
        result.cwd = payload.cwd ?? result.cwd
        result.createdAt = payload.timestamp ?? result.createdAt
        result.model = payload.model ?? result.model
        continue
      }
      if (entry?.type === 'event_msg' && payload?.type === 'thread_settings_applied') {
        result.model = payload.model ?? result.model
        continue
      }
      if (entry?.type !== 'response_item') continue
      const before = messages.length
      messageFromResponseItem(payload, entry.timestamp, messages)
      if (messages.length > before && payload?.role === 'user') userPromptCount += 1
      result.updatedAt = entry.timestamp ?? result.updatedAt
      if (messages.length >= maxMessages) {
        truncated = true
        stopped = true
        break
      }
    }
  } catch (error) {
    if (!(stopped && error?.code === 'ERR_STREAM_PREMATURE_CLOSE')) throw error
  }
  if (stopped) opts.onStop?.()

  result.messages = messages
  result.messageCount = messages.length
  result.userPromptCount = userPromptCount
  result.truncated = truncated
  result.badLines = badLines
  if (meta) {
    result.title = meta.title ?? result.title
    result.cwd = meta.cwd ?? result.cwd
    result.model = meta.model ?? result.model
    result.createdAt = meta.createdAt ?? result.createdAt
    result.updatedAt = meta.updatedAt ?? result.updatedAt
  }
  return result
}

/**
 * Stream one local rollout file into a transcript. Remote rollouts use
 * `collectTranscript` directly on the ssh stdout stream.
 * @param {string} file absolute rollout path
 * @param {{maxMessages?: number, meta?: object}} [opts] `meta` is the index row,
 *        used to fill title/cwd without re-reading the head.
 */
export async function readTranscript(file, opts = {}) {
  const stream = fs.createReadStream(file, { encoding: 'utf8' })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
  try {
    const result = await collectTranscript(rl, { ...opts, file })
    if (result.truncated) stream.destroy()
    return result
  } finally {
    rl.close()
    stream.destroy()
  }
}

/**
 * Read the beginning of a rollout: session_meta, model, first real user prompt
 * and the head content snippets.
 *
 * Two windows share one read: `metaBytes` (256 KiB) is the documented metadata
 * window that drives `truncatedWindow`/`windowTruncations`, while `headBytes`
 * (1 MiB) additionally feeds `prompts` for content search.
 */
export async function readHeadInfo(file, opts = {}) {
  const bytes = opts.headBytes ?? SNIPPET_HEAD_BYTES
  const metaBytes = opts.metaBytes ?? HEAD_BYTES
  const handle = await fsp.open(file, 'r')
  let text
  let truncatedWindow = false
  let truncatedRead = false
  let scannedBytes = 0
  try {
    const stat = await handle.stat()
    const window = Math.max(1, Math.min(bytes, stat.size))
    const buffer = Buffer.alloc(window)
    const { bytesRead } = await handle.read(buffer, 0, window, 0)
    text = buffer.subarray(0, bytesRead).toString('utf8')
    scannedBytes = bytesRead
    truncatedWindow = stat.size > metaBytes
    truncatedRead = stat.size > bytesRead
  } finally {
    await handle.close()
  }

  if (truncatedRead) {
    // The window stops mid-line. That fragment is a cut, not a malformed line,
    // so dropping it keeps badLines meaning "genuinely unparseable line" instead
    // of "file bigger than the head window".
    const cut = text.lastIndexOf('\n')
    text = cut === -1 ? '' : text.slice(0, cut)
  }
  const promptSource = text
  const metaEnd = metaBytes >= text.length ? text.length : Math.max(0, text.lastIndexOf('\n', metaBytes))
  const metaText = text.slice(0, metaEnd)

  const info = { id: null, cwd: null, createdAt: null, model: null, originator: null, firstUserText: null }
  let badLines = 0
  for (const line of metaText.split('\n')) {
    if (!line.trim()) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      badLines += 1
      continue
    }
    const payload = entry?.payload
    if (entry?.type === 'session_meta' && payload) {
      info.id = payload.session_id ?? payload.id ?? info.id
      info.cwd = payload.cwd ?? info.cwd
      info.createdAt = payload.timestamp ?? info.createdAt
      info.model = payload.model ?? info.model
      info.originator = payload.originator ?? info.originator
      continue
    }
    if (entry?.type === 'event_msg' && payload?.type === 'thread_settings_applied' && !info.model) {
      info.model = payload.model ?? info.model
      continue
    }
    if (info.firstUserText || entry?.type !== 'response_item' || payload?.type !== 'message') continue
    if (payload.role !== 'user') continue
    const candidate = contentText(payload.content)
    if (isInjectionText(candidate)) continue
    info.firstUserText = candidate
  }
  info.badLines = badLines
  info.truncatedWindow = truncatedWindow
  info.scannedBytes = scannedBytes
  info.prompts = collectPrompts(promptSource, { max: MAX_PROMPTS })
  return info
}

/**
 * Count genuinely unparseable lines in a whole rollout (streaming, read-only).
 *
 * The fast scan only reads the head window of each file, so a malformed line
 * further down is invisible there. `--deep` uses this to get a real number.
 */
export async function countBadLines(file) {
  const stream = fs.createReadStream(file, { encoding: 'utf8' })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
  let badLines = 0
  let lines = 0
  try {
    for await (const line of rl) {
      lines += 1
      if (!line.trim()) continue
      try {
        JSON.parse(line)
      } catch {
        badLines += 1
      }
    }
  } finally {
    rl.close()
    stream.destroy()
  }
  return { badLines, lines }
}

/** Read the last `bytes` of a file as text (empty when the file is empty). */
async function readTailText(file, bytes) {
  const stat = await fsp.stat(file)
  const length = Math.min(bytes, stat.size)
  if (length <= 0) return { text: '', scannedBytes: 0 }
  const handle = await fsp.open(file, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, stat.size - length)
    return { text: buffer.subarray(0, bytesRead).toString('utf8'), scannedBytes: bytesRead }
  } finally {
    await handle.close()
  }
}

/** Last timestamp written in the file (small tail read), used when mtime is moot. */
export async function readTailTimestamp(file) {
  const { text } = await readTailText(file, TAIL_BYTES)
  const lines = text.split('\n').filter((line) => line.trim())
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const entry = JSON.parse(lines[index])
      if (entry?.timestamp) return entry.timestamp
    } catch {
      /* partial tail line: keep walking back */
    }
  }
  return null
}

/**
 * Recent prompts from the end of a rollout (the widest tail window), plus the
 * same `timestamp` as `readTailTimestamp`.
 *
 * The window may start mid-line; that first fragment is dropped because it is a
 * cut, while a cut final line simply fails to parse and is skipped.
 *
 * @returns {Promise<{prompts: string[], timestamp: string|null, scannedBytes: number}>}
 */
export async function readTailPrompts(file, opts = {}) {
  const bytes = opts.tailBytes ?? SNIPPET_TAIL_BYTES
  const max = opts.max ?? 12
  const limit = opts.limit ?? PROMPT_CHARS
  const { text, scannedBytes } = await readTailText(file, bytes)
  if (!text) return { prompts: [], timestamp: null, scannedBytes }
  const firstBreak = text.indexOf('\n')
  const body = scannedBytes < bytes && firstBreak !== -1 ? text.slice(firstBreak + 1) : text
  const all = collectPrompts(body, { max: Number.MAX_SAFE_INTEGER, limit })
  const prompts = max > 0 ? all.slice(-max) : []
  let timestamp = null
  const lines = text.split('\n')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const entry = JSON.parse(lines[index])
      if (entry?.timestamp) {
        timestamp = entry.timestamp
        break
      }
    } catch {
      /* partial tail line: keep walking back */
    }
  }
  return { prompts, timestamp, scannedBytes }
}

/** Collapse a title candidate to one short line. */
export function titleFromText(value, limit = 80) {
  return normalizePrompt(value, limit)
}

export {
  TOOL_OUTPUT_LIMIT,
  TEXT_LIMIT,
  HEAD_BYTES,
  TAIL_BYTES,
  SNIPPET_HEAD_BYTES,
  SNIPPET_TAIL_BYTES,
  MAX_PROMPTS,
  PROMPT_CHARS,
}