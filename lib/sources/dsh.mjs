/**
 * dsh.mjs — DSH 自身的历史会话（`~/.dsh/sessions/<workspace-encoded>/<session>/`）。
 *
 * 为什么要专门写一个适配器：DSH 的日志不是普通 JSONL，而是「多帧 zstd 拼接 +
 * 每帧若干行 JSON」。Node 的 `zlib.zstdDecompressSync(buffer)` 只解**第一帧**
 * 就返回（实测一份 277KB 的会话只得到 312 字节、1 条 header），所以任何
 * 「读整个文件再 JSON.parse」的写法都会静默丢正文。这里的做法是按帧推进：
 * 用 `info: true` 拿回本次消费的压缩字节数（`engine.bytesWritten`），逐帧解压拼接，
 * 解出来的才是完整 JSONL。
 *
 * 扫描策略：每份正文必须整份解压（zstd 没有随机读），单文件最大约 5.5MB 压缩 /
 * 17MB 解压，本机 51 个会话合计 32MB→103MB，实测 ~3s，所以不做头部截断，
 * 而是逐文件处理、处理完即丢，并发上限 4（见 SCAN_CONCURRENCY）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import {
  MAX_PROMPTS,
  clampText,
  emptyTranscript,
  localIso,
  mapWithConcurrency,
  mergePrompts,
  normalizeSession,
  titleFromText,
} from './base.mjs'

export const meta = {
  id: 'dsh',
  label: 'DSH',
  order: 30,
  remote: false,
}

/** 每条 prompt 的展示上限：索引要能扫，正文详情页才看全文。 */
const MAX_PROMPT_CHARS = 200
/** 正文单条上限，与契约 §3 一致。 */
const MAX_MESSAGE_CHARS = 120000
/** 工具参数/输出上限，比正文更狠，否则一张表就能塞满一屏。 */
const MAX_TOOL_CHARS = 4000
const DEFAULT_MAX_MESSAGES = 400
/** 解压是同步 CPU 操作，并发只用来重叠文件读取与磁盘等待；再高只会挤内存。 */
const SCAN_CONCURRENCY = 4
/** 投影缓存目录（DSH 自己写的小 JSON），只在正文读不出来时当兜底元数据。 */
const PROJECTION_CACHE = path.join('storages', 'session_projcache', 'sessions')

/**
 * `user/message.data.source.kind` 是 DSH 自己给的「这条消息是谁写的」标记，
 * 比按文本猜可靠得多：只有 `user` 才是人真正敲进去的字。
 * 其余都是运行时注入（规则、技能目录、时间上下文、审批变更、任务完成通知……）。
 */
const INJECTED_SOURCE_KINDS = new Set([
  'agent-instructions',
  'runtime-context',
  'skill-catalog',
  'time-context',
  'tool-jobs',
  'user-approval',
  'subagent-settled',
  'model-selection',
  'schedule',
  'skill-invocation',
  'compact-checkpoint',
])

/** 老版本日志可能没有 `source`，这时按文本前缀兜底过滤。 */
const INJECTED_TEXT_PATTERNS = [
  /^<system-reminder>/i,
  /^<skill_content\b/i,
  /^Current runtime context\b/i,
  /^Time sampled while preparing turn\b/i,
  /^The approval policy changed\b/i,
  /^\[SCHEDULE REMINDER BATCH\]/i,
  /^\[model changed:/i,
  /^Background subagent\s+[0-9a-f-]{8,}/i,
  /^background job\s+\S+/i,
  /^Agent\s+[0-9a-f]{8}-[0-9a-f-]{27,}/i,
  /^Team message from\b/i,
]

function sessionsRoot(home) {
  return path.join(home ?? os.homedir(), '.dsh', 'sessions')
}

function looksZstd(buffer) {
  return (
    buffer.length >= 4 &&
    buffer[0] === 0x28 &&
    buffer[1] === 0xb5 &&
    buffer[2] === 0x2f &&
    buffer[3] === 0xfd
  )
}

/**
 * 按帧解压。`engine.bytesWritten` 是本次调用实际吃掉的**压缩**字节数，
 * 用它推进游标，既不靠魔数扫描（魔数可能出现在压缩数据里），也不会死循环。
 * 尾部被截断时保留已解出的部分并把错误交给调用方记 warning——损坏的会话
 * 至少还能显示前半段，而不是整份消失。
 */
function decompressZstdFrames(buffer) {
  const chunks = []
  let offset = 0
  let frames = 0
  let error = null
  while (offset < buffer.length) {
    let outcome
    try {
      outcome = zlib.zstdDecompressSync(buffer.subarray(offset), { info: true })
    } catch (failure) {
      error = failure instanceof Error ? failure : new Error(String(failure))
      break
    }
    const out = outcome?.buffer ?? outcome
    chunks.push(Buffer.isBuffer(out) ? out : Buffer.from(out))
    frames += 1
    const consumed = Number(outcome?.engine?.bytesWritten ?? 0)
    if (!consumed) {
      // 没有帧长度信息就停下来，把已解出的部分返回；继续解会重复喂同一段数据。
      error = new Error('zstd 未报告已消费字节，无法继续下一个帧')
      break
    }
    offset += consumed
  }
  const joined = Buffer.concat(chunks)
  return { text: joined.toString('utf8'), bytes: joined.length, frames, error }
}

/** 读一份正文：zstd 按帧解，普通 jsonl 直读；扩展名骗人时按魔数判断。 */
function readBody(file) {
  const buffer = fs.readFileSync(file)
  if (file.toLowerCase().endsWith('.zstd') || looksZstd(buffer)) {
    if (typeof zlib.zstdDecompressSync !== 'function') {
      throw new Error('当前 Node 不支持 zstd（需要 Node ≥ 22.15 的 zlib.zstdDecompressSync）')
    }
    const decoded = decompressZstdFrames(buffer)
    return {
      text: decoded.text,
      bytes: decoded.bytes,
      frames: decoded.frames,
      error: decoded.error,
      compressedBytes: buffer.length,
    }
  }
  return { text: buffer.toString('utf8'), bytes: buffer.length, frames: 0, error: null, compressedBytes: buffer.length }
}

/**
 * 逐行喂记录，畸形行只计数不抛错：DSH 崩溃/断电会留下半行。
 * 回调返回 false 可以提前收工（readTranscript 到达 maxMessages 时用）。
 */
function forEachRecord(text, visit) {
  let badLines = 0
  let records = 0
  let index = 0
  while (index < text.length) {
    let newline = text.indexOf('\n', index)
    if (newline === -1) newline = text.length
    const line = text.slice(index, newline)
    index = newline + 1
    if (!line.trim()) continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      badLines += 1
      continue
    }
    records += 1
    if (visit(record) === false) break
  }
  return { badLines, records }
}

/** 内容区里可能混着文本与图片；图片只留占位符，别把 base64 写进索引。 */
function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    if (part.type === 'text' && typeof part.text === 'string') parts.push(part.text)
    else if (part.type === 'image') parts.push('[图片]')
  }
  return parts.join('\n')
}

function countImages(content) {
  if (!Array.isArray(content)) return 0
  let total = 0
  for (const part of content) {
    if (part && part.type === 'image') total += 1
  }
  return total
}

function clip(text, limit) {
  if (typeof text !== 'string') return ''
  const trimmed = text.trim()
  if (trimmed.length <= limit) return trimmed
  return `${trimmed.slice(0, limit)}…`
}

function isInjected(data) {
  const kind = data?.source?.kind
  if (typeof kind === 'string' && kind !== 'user' && kind !== 'agent-message') return true
  if (kind === 'user' || kind === 'agent-message') return false
  const text = contentText(data?.content)
  return INJECTED_TEXT_PATTERNS.some((pattern) => pattern.test(text))
}

/** 只有真实用户输入才进 `prompts`；`@` 引用块照原样留着，只截断长度。 */
function promptTextOf(data) {
  if (isInjected(data)) return ''
  if (data?.source?.kind === 'agent-message') return ''
  return clip(contentText(data?.content), MAX_PROMPT_CHARS)
}

/** 目录名编码是有损的：`--D-Users-...-new-chat--` 无法还原名字里的 `-`。 */
function cwdFromDirName(name) {
  if (typeof name !== 'string') return null
  const match = /^--(.+)--$/.exec(name)
  if (!match) return null
  const parts = match[1].split('-').filter(Boolean)
  if (parts.length < 2 || parts[0].length !== 1) return null
  return `${parts[0].toUpperCase()}:\\${parts.slice(1).join('\\')}`
}

const BODY_MATCHERS = [
  (name) => /^session.*\.jsonl\.zstd$/i.test(name),
  (name) => /\.jsonl\.zstd$/i.test(name),
  (name) => /\.zstd$/i.test(name),
  (name) => /^session.*\.jsonl$/i.test(name),
  (name) => /\.jsonl$/i.test(name),
]

/** 同一目录里 zstd 优先、`session*` 优先，保证同一份会话永远选同一个文件。 */
function pickBodyName(names) {
  for (const matcher of BODY_MATCHERS) {
    const hits = names.filter((name) => matcher(name)).sort()
    if (hits.length > 0) return hits[0]
  }
  return null
}

function listNames(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/**
 * 会话目录布局：`sessions/<workspace-encoded>/<sessionDir>/<body>`。
 * 没有 workspace 层（正文直接挂在 sessions/ 下）也认，避免以后改布局就全盲。
 */
function listSessionDirs(root) {
  const out = []
  for (const workspace of listNames(root)) {
    if (!workspace.isDirectory() || workspace.name.startsWith('.')) continue
    const workspaceDir = path.join(root, workspace.name)
    const children = listNames(workspaceDir)
    const directName = pickBodyName(children.filter((entry) => entry.isFile()).map((entry) => entry.name))
    if (directName) {
      out.push({ workspace: null, name: workspace.name, dir: workspaceDir, body: path.join(workspaceDir, directName) })
      continue
    }
    for (const child of children) {
      if (!child.isDirectory() || child.name.startsWith('.')) continue
      const dir = path.join(workspaceDir, child.name)
      const bodyName = pickBodyName(listNames(dir).filter((entry) => entry.isFile()).map((entry) => entry.name))
      out.push({ workspace: workspace.name, name: child.name, dir, body: bodyName ? path.join(dir, bodyName) : null })
    }
  }
  return out
}

export function detect(ctx = {}) {
  const root = sessionsRoot(ctx.home)
  for (const workspace of listNames(root)) {
    if (!workspace.isDirectory()) continue
    const workspaceDir = path.join(root, workspace.name)
    const children = listNames(workspaceDir)
    const fileNames = children.filter((entry) => entry.isFile()).map((entry) => entry.name)
    if (pickBodyName(fileNames)) return true
    for (const child of children) {
      if (!child.isDirectory()) continue
      const names = listNames(path.join(workspaceDir, child.name))
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
      if (pickBodyName(names)) return true
    }
  }
  return false
}

/**
 * 兜底元数据：`~/.dsh/storages/session_projcache/sessions/<id>.json` 是 DSH
 * 自己维护的投影缓存（version 7，非公开 API）。正文彻底读不出来时用它至少
 * 还能显示标题和 cwd，而不是给用户一个只有路径的破行。
 */
function readProjectionCache(home, sessionId) {
  if (!sessionId) return null
  const candidates = [sessionId, `session-${sessionId}`]
  for (const candidate of candidates) {
    const file = path.join(home ?? os.homedir(), '.dsh', PROJECTION_CACHE, `${candidate}.json`)
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      const record = parsed?.record ?? {}
      const rows = record.rows ?? {}
      const title = rows.title?.val
      const firstPrompt = rows.titleInput?.val?.first?.text
      const model = rows.modelSelection?.val?.lastUsed?.model
      return {
        cwd: typeof record.identity?.cwd === 'string' ? record.identity.cwd : null,
        createdAt: Number.isFinite(record.identity?.createdAt) ? record.identity.createdAt : null,
        title: typeof title === 'string' && title.trim() ? title.trim() : null,
        prompt: typeof firstPrompt === 'string' && firstPrompt.trim() ? firstPrompt.trim() : null,
        model: typeof model === 'string' && model.trim() ? model.trim() : null,
      }
    } catch {
      // 没有缓存或版本变了都算正常，继续找下一个命名。
    }
  }
  return null
}

function normalizeId(name) {
  return String(name ?? '').replace(/^session-/, '')
}

function recordTime(record) {
  const time = Number(record?.time)
  return Number.isFinite(time) ? time : null
}

/** 汇总一份正文的元数据；返回 null 表示整份不可读（已记 warning）。 */
function summarizeBody(entry, home, stats, warnings) {
  let size = 0
  try {
    size = fs.statSync(entry.body).size
  } catch {
    warnings.push(`无法读取会话文件信息: ${entry.body}`)
    return null
  }
  stats.files += 1
  stats.compressedBytes += size
  stats.maxFileBytes = Math.max(stats.maxFileBytes ?? 0, size)

  const decompressStarted = performance.now()
  let body
  try {
    body = readBody(entry.body)
  } catch (error) {
    stats.unreadable += 1
    warnings.push(
      `解压失败，已跳过正文: ${entry.body}（${error instanceof Error ? error.message : String(error)}）`,
    )
    return fallbackRow(entry, home, size)
  }
  stats.decompressMs += performance.now() - decompressStarted
  stats.decompressedBytes += body.bytes ?? body.text.length
  stats.frames += body.frames
  if (body.error) {
    stats.unreadable += 1
    warnings.push(
      `会话尾部解压中断，只保留已读出的部分: ${entry.body}（${body.error.message}）`,
    )
  }

  const info = {
    id: null,
    cwd: null,
    title: null,
    model: null,
    provider: null,
    origin: null,
    parentSession: null,
    delegationDepth: null,
    agentPreset: null,
    createdAtMs: null,
    updatedAtMs: null,
    prompts: [],
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    compactions: 0,
    images: 0,
    spliced: 0,
  }

  const parseStarted = performance.now()
  const counted = forEachRecord(body.text, (record) => {
    if (!record || typeof record !== 'object') return
    const time = recordTime(record)
    if (time !== null && (info.updatedAtMs === null || time > info.updatedAtMs)) info.updatedAtMs = time
    const data = record.data ?? {}
    switch (record.type) {
      case 'session': {
        // 文件第一行是唯一一处「字段直接挂在记录上」的类型（没有 seq/time/data），
        // 其它记录才是 `{type,seq,time,data}`；两种形态都认，免得换版本就丢 cwd。
        const header = data && Object.keys(data).length > 0 ? data : record
        if (typeof header.id === 'string' && header.id.trim()) info.id = normalizeId(header.id)
        if (typeof header.cwd === 'string' && header.cwd.trim()) info.cwd = header.cwd.trim()
        if (Number.isFinite(header.createdAt)) info.createdAtMs = header.createdAt
        if (typeof header.origin === 'string') info.origin = header.origin
        if (typeof header.parentSession === 'string') info.parentSession = header.parentSession
        if (Number.isFinite(header.delegationDepth)) info.delegationDepth = header.delegationDepth
        if (typeof header.agentPreset === 'string') info.agentPreset = header.agentPreset
        break
      }
      case 'session/title': {
        const title = typeof data.title === 'string' ? data.title.trim() : ''
        if (title) info.title = title
        break
      }
      case 'user/message': {
        info.userMessages += 1
        info.images += countImages(data.content)
        const prompt = promptTextOf(data)
        if (prompt) info.prompts.push(prompt)
        break
      }
      case 'agent/inbox/spliced': {
        // 子代理的初始提示词先落在 inbox splice 里，再变成 user/message；两边都收，
        // mergePrompts() 会去重，崩溃在中间也不会丢 prompt。splice 里还混着审批、
        // 日程、时间等注入，所以必须看插入项自己的 source.kind，不能整段照收。
        for (const inserted of data.inserted ?? []) {
          const kind = inserted?.source?.kind
          if (typeof kind === 'string' && kind !== 'user') continue
          const text = clip(contentText(inserted?.content), MAX_PROMPT_CHARS)
          if (!text) continue
          if (INJECTED_TEXT_PATTERNS.some((pattern) => pattern.test(text))) continue
          info.prompts.push(text)
          info.spliced += 1
        }
        break
      }
      case 'request/header': {
        const config = data.header?.config ?? {}
        if (!info.model && typeof config.model === 'string') info.model = config.model
        if (!info.provider && typeof config.provider === 'string') info.provider = config.provider
        break
      }
      case 'model/selection': {
        // 会话中途换模型是常态，最后一条才是当前模型。
        if (typeof data.model === 'string' && data.model.trim()) info.model = data.model.trim()
        if (typeof data.provider === 'string' && data.provider.trim()) info.provider = data.provider.trim()
        break
      }
      case 'subagent/descriptor': {
        if (!info.model && typeof data.agentModel === 'string') info.model = data.agentModel
        if (!info.provider && typeof data.agentProvider === 'string') info.provider = data.agentProvider
        if (typeof data.label === 'string' && data.label.trim() && !info.title) info.title = data.label.trim()
        break
      }
      case 'assistant/message': {
        info.assistantMessages += 1
        for (const part of data.message?.content ?? []) {
          if (part?.type === 'tool-call') info.toolCalls += 1
        }
        break
      }
      case 'tool/result': {
        info.images += countImages(data.message?.content)
        break
      }
      case 'compaction/summary': {
        info.compactions += 1
        break
      }
      default:
        break
    }
  })
  stats.parseMs += performance.now() - parseStarted
  stats.records += counted.records
  stats.badLines += counted.badLines

  const createdAtMs = info.createdAtMs ?? info.updatedAtMs ?? statMtime(entry.body)

  return {
    id: info.id ?? normalizeId(entry.name),
    title: info.title ?? '',
    cwd: info.cwd,
    file: entry.body,
    createdAt: localIso(createdAtMs),
    updatedAt: localIso(info.updatedAtMs ?? statMtime(entry.body)),
    model: info.model,
    sizeBytes: size,
    prompts: info.prompts,
    messageCount: info.userMessages + info.assistantMessages,
    userPromptCount: info.prompts.length,
    hasToolCalls: info.toolCalls > 0,
    extra: {
      workspace: entry.workspace,
      provider: info.provider,
      origin: info.origin,
      parentSession: info.parentSession,
      delegationDepth: info.delegationDepth,
      agentPreset: info.agentPreset,
      records: counted.records,
      frames: body.frames,
      compactions: info.compactions,
      images: info.images,
      badLines: counted.badLines,
    },
  }
}

function statMtime(file) {
  try {
    return fs.statSync(file).mtimeMs
  } catch {
    return null
  }
}

/** 正文读不出来时的兜底行：投影缓存 > 目录名反解，宁可信息少也不要丢掉会话。 */
function fallbackRow(entry, home, size) {
  const cached = readProjectionCache(home, normalizeId(entry.name))
  const mtime = statMtime(entry.body)
  return {
    id: normalizeId(entry.name),
    title: cached?.title ?? '',
    cwd: cached?.cwd ?? null,
    file: entry.body,
    createdAt: localIso(cached?.createdAt ?? mtime),
    updatedAt: localIso(mtime),
    model: cached?.model ?? null,
    sizeBytes: size,
    prompts: cached?.prompt ? [clip(cached.prompt, MAX_PROMPT_CHARS)] : [],
    messageCount: null,
    userPromptCount: null,
    hasToolCalls: null,
    extra: { workspace: entry.workspace, degraded: 'projection-cache' },
  }
}

export async function scan(ctx = {}) {
  const started = performance.now()
  const home = ctx.home ?? os.homedir()
  const root = sessionsRoot(home)
  const warnings = []
  const stats = {
    files: 0,
    sessions: 0,
    compressedBytes: 0,
    decompressedBytes: 0,
    frames: 0,
    records: 0,
    badLines: 0,
    duplicates: 0,
    unreadable: 0,
    decompressMs: 0,
    parseMs: 0,
    concurrency: 0,
    maxFileBytes: 0,
  }

  const entries = listSessionDirs(root)
  const concurrency = Math.min(Math.max(Number(ctx.concurrency) || SCAN_CONCURRENCY, 1), SCAN_CONCURRENCY)
  stats.concurrency = concurrency
  const maxPrompts = Math.min(Math.max(Number(ctx.maxPrompts) || MAX_PROMPTS, 1), MAX_PROMPTS)

  const summarized = await mapWithConcurrency(entries, concurrency, async (entry) => {
    if (!entry.body) {
      warnings.push(`会话目录里没有可读的正文文件，已跳过: ${entry.dir}`)
      return null
    }
    return summarizeBody(entry, home, stats, warnings)
  })

  // 目录名编码有损（`2026-09-29` 会被拆成三层），所以先用同 workspace 下其它会话的
  // 多数 cwd 兜底，最后才退回名字反解。
  const workspaceCwds = new Map()
  for (const row of summarized) {
    if (!row || !row.cwd || !row.extra?.workspace) continue
    const bucket = workspaceCwds.get(row.extra.workspace) ?? new Map()
    bucket.set(row.cwd, (bucket.get(row.cwd) ?? 0) + 1)
    workspaceCwds.set(row.extra.workspace, bucket)
  }
  const majorityCwd = (workspace) => {
    const bucket = workspaceCwds.get(workspace)
    if (!bucket) return null
    let best = null
    let bestCount = 0
    for (const [cwd, count] of bucket) {
      if (count > bestCount) {
        best = cwd
        bestCount = count
      }
    }
    return best
  }

  const byId = new Map()
  for (const row of summarized) {
    if (!row) continue
    if (!row.cwd && row.extra?.workspace) row.cwd = majorityCwd(row.extra.workspace) ?? cwdFromDirName(row.extra.workspace)
    if (!row.cwd) row.cwd = cwdFromDirName(row.extra?.workspace)

    const normalized = normalizeSession(meta.id, {
      ...row,
      title: row.title || titleFromText(row.prompts?.[0]),
      prompts: mergePrompts((row.prompts ?? []).slice(0, maxPrompts)),
    })
    const previous = byId.get(normalized.id)
    if (!previous) {
      byId.set(normalized.id, normalized)
      continue
    }
    // 同一 id 出现在多个目录（迁移/备份）：保留更新的那份，另一份记进 duplicateFiles。
    stats.duplicates += 1
    const keepNewer = String(normalized.updatedAt ?? '') > String(previous.updatedAt ?? '')
    const kept = keepNewer ? normalized : previous
    const dropped = keepNewer ? previous : normalized
    kept.duplicateFiles = [...(kept.duplicateFiles ?? []), ...(dropped.duplicateFiles ?? []), dropped.file].filter(Boolean)
    byId.set(kept.id, kept)
  }

  const sessions = [...byId.values()]
  stats.sessions = sessions.length
  stats.scanMs = performance.now() - started
  stats.root = root
  return { sessions, warnings, stats }
}

/** 正文映射：assistant/message 里的 tool-call 与独立 tool/call 记录重复，只用前者。 */
export async function readTranscript(session, ctx = {}) {
  const maxMessages = Number(ctx.maxMessages) || DEFAULT_MAX_MESSAGES
  const file = session?.file ?? null
  if (!file) {
    const error = new Error('该 DSH 会话没有正文文件（可能只在索引里）')
    error.code = 'ENOENT'
    throw error
  }
  let body
  try {
    if (!fs.existsSync(file)) {
      const error = new Error(`会话文件不存在: ${file}`)
      error.code = 'ENOENT'
      throw error
    }
    body = readBody(file)
  } catch (error) {
    if (!error.code) error.code = 'EIO'
    throw error
  }

  const transcript = emptyTranscript(file)
  transcript.id = session.id ?? null
  transcript.title = session.title ?? null
  transcript.cwd = session.cwd ?? null
  transcript.model = session.model ?? null
  transcript.createdAt = session.createdAt ?? null
  transcript.updatedAt = session.updatedAt ?? null

  const messages = []
  const toolNames = new Map()
  let title = transcript.title
  let cwd = transcript.cwd
  let model = transcript.model
  let createdAtMs = null
  let updatedAtMs = null
  let truncated = false

  const push = (message) => {
    if (truncated) return false
    messages.push(message)
    if (messages.length >= maxMessages) truncated = true
    return true
  }

  const counted = forEachRecord(body.text, (record) => {
    // 到了条数上限就直接收工：剩下的行没必要再 JSON.parse（大会话能省一半时间）。
    if (truncated) return false
    if (!record || typeof record !== 'object') return
    const time = recordTime(record)
    if (time !== null && (updatedAtMs === null || time > updatedAtMs)) updatedAtMs = time
    const data = record.data ?? {}
    switch (record.type) {
      case 'session': {
        const header = data && Object.keys(data).length > 0 ? data : record
        if (typeof header.cwd === 'string' && header.cwd.trim()) cwd = header.cwd.trim()
        if (Number.isFinite(header.createdAt)) createdAtMs = header.createdAt
        return
      }
      case 'session/title': {
        const next = typeof data.title === 'string' ? data.title.trim() : ''
        if (next) title = next
        return
      }
      case 'request/header': {
        const config = data.header?.config ?? {}
        if (!model && typeof config.model === 'string') model = config.model
        return
      }
      case 'model/selection': {
        if (typeof data.model === 'string' && data.model.trim()) model = data.model.trim()
        return
      }
      case 'user/message': {
        if (isInjected(data)) return
        const text = clip(contentText(data.content), MAX_MESSAGE_CHARS)
        if (!text) return
        const relayed = data.source?.kind === 'agent-message'
        push({
          role: relayed ? 'agent' : 'user',
          kind: relayed ? 'agent_message' : 'message',
          ts: time === null ? null : localIso(time),
          name: relayed ? (data.source?.senderSessionId ?? 'agent') : null,
          text,
          truncated: contentText(data.content).length > MAX_MESSAGE_CHARS,
        })
        return
      }
      case 'assistant/message': {
        for (const part of data.message?.content ?? []) {
          if (part?.type === 'text') {
            const text = clip(part.text, MAX_MESSAGE_CHARS)
            if (text) {
              push({
                role: 'assistant',
                kind: 'message',
                ts: time === null ? null : localIso(time),
                name: null,
                text,
                truncated: String(part.text ?? '').length > MAX_MESSAGE_CHARS,
              })
            }
          } else if (part?.type === 'reasoning' && ctx.deep === true) {
            // 推理块默认不进正文：它比正文长一个量级，读会话的人基本是来看结论的。
            const text = clip(part.text, MAX_MESSAGE_CHARS)
            if (text) {
              push({
                role: 'assistant',
                kind: 'message',
                ts: time === null ? null : localIso(time),
                name: 'reasoning',
                text,
                truncated: String(part.text ?? '').length > MAX_MESSAGE_CHARS,
              })
            }
          } else if (part?.type === 'tool-call') {
            const name = typeof part.name === 'string' ? part.name : null
            if (name && typeof part.id === 'string') toolNames.set(part.id, name)
            const clamped = clampText(part.arguments ?? '', MAX_TOOL_CHARS)
            push({
              role: 'assistant',
              kind: 'tool_call',
              ts: time === null ? null : localIso(time),
              name,
              text: clamped.text,
              truncated: clamped.truncated,
            })
          }
          if (truncated) return false
        }
        return
      }
      case 'tool/result': {
        const callId = data.toolCallId ?? data.message?.source?.callId ?? null
        const name = callId ? (toolNames.get(callId) ?? null) : null
        const raw = contentText(data.message?.content)
        if (!raw.trim()) return
        const clamped = clampText(raw, MAX_TOOL_CHARS)
        const failed = data.message?.isError === true
        push({
          role: 'tool',
          kind: 'tool_output',
          ts: time === null ? null : localIso(time),
          name,
          text: failed ? `[错误] ${clamped.text}` : clamped.text,
          truncated: clamped.truncated,
        })
        return
      }
      case 'compaction/summary': {
        // 压缩检查点本身就是给后续对话看的摘要，正文里必须保留，否则读起来断层。
        const text = clip(contentText(data.summary), MAX_MESSAGE_CHARS)
        if (!text) return
        push({
          role: 'agent',
          kind: 'agent_message',
          ts: time === null ? null : localIso(time),
          name: 'compaction',
          text,
          truncated: contentText(data.summary).length > MAX_MESSAGE_CHARS,
        })
        return
      }
      default:
        // step/*、turn/*、job/*、system/message、developer/message、inbox splice、
        // sandbox/mode 等都是运行噪声或已在别处展开，跳过。
        return
    }
  })

  transcript.messages = messages
  transcript.messageCount = messages.length
  transcript.userPromptCount = messages.filter((message) => message.role === 'user').length
  transcript.hasToolCalls = messages.some(
    (message) => message.kind === 'tool_call' || message.kind === 'tool_output',
  )
  transcript.truncated = truncated
  transcript.badLines = counted.badLines
  transcript.title = title || transcript.title
  transcript.cwd = cwd
  transcript.model = model
  transcript.createdAt = localIso(createdAtMs ?? session.createdAt) ?? transcript.createdAt
  transcript.updatedAt = localIso(updatedAtMs ?? session.updatedAt) ?? transcript.updatedAt
  if (body.error) transcript.partial = true
  return transcript
}
