#!/usr/bin/env node
/**
 * cli.mjs — the data layer's command surface, reused by the scheduled sync, the
 * HTTP API and any agent that wants this machine's context without the Web UI.
 *
 *   node lib/cli.mjs scan    [--out <index.json>] [--json] [--quiet] [--deep]
 *   node lib/cli.mjs list    [--q <keyword>] [--limit 50] [--agent codex] [--json] [--local|--remote]
 *   node lib/cli.mjs show    --id <agent:id | id> [--json] [--max-messages 200]
 *   node lib/cli.mjs stats   [--json]
 *   node lib/cli.mjs share   --title <t> [--body <b>] [--kind decision|handoff|note|task]
 *                            [--tags a,b] [--refs m00123,PR#42] [--agent <id>] [--cwd <path>]
 *                            [--tags a,b] [--agent <id>] [--cwd <path>]
 *   node lib/cli.mjs context [--q <keyword>] [--agent <id>] [--kind <kind>] [--limit 30] [--json]
 *   node lib/cli.mjs digest  [--cwd <path>] [--limit 20] [--json]
 *   node lib/cli.mjs paths   [--json]          # where the data lives (for scripts)
 *
 * `list --q` matches title, cwd, id and the indexed content snippets
 * (`prompts`), so a keyword that only appears inside a conversation still finds
 * that conversation; the matching snippet is printed under the row.
 *
 * `--deep` streams every session file to count genuinely unparseable lines; the
 * default scan reads only a head window per file (`stats.badLinesScope` says
 * which one you got).
 *
 * `share` / `context` / `digest` are the cross-agent shared context: any agent
 * can append with one command (or one HTTP POST) and every agent reads the same
 * file. `digest` renders a short markdown block for a project.
 *
 * Exit codes: 0 ok · 1 failure · 3 nothing found.
 */

import path from 'node:path'
import { scanAll, writeIndex, readIndex, findSession as findHubSession } from './hub.mjs'
import * as paths from './paths.mjs'

const defaultIndexFile = paths.indexFile
import { readSessionTranscript } from './transcript.mjs'
import { appendShared, listShared, digestShared } from './shared.mjs'

function parseArgs(argv) {
  const args = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      args._.push(token)
      continue
    }
    const [rawKey, inlineValue] = token.slice(2).split('=')
    const key = rawKey.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
    if (inlineValue !== undefined) args[key] = inlineValue
    else if (argv[index + 1] && !argv[index + 1].startsWith('--')) {
      args[key] = argv[index + 1]
      index += 1
    } else args[key] = true
  }
  return args
}

function resolveOut(value) {
  if (!value || value === true) return defaultIndexFile()
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value)
}

function flatSessions(index) {
  return (index?.groups ?? []).flatMap((group) => (group.sessions ?? []).map((session) => ({ group, session })))
}

function matches(entry, keyword) {
  const { session } = entry
  const haystack = `${session.title ?? ''}\n${session.cwd ?? ''}\n${session.id ?? ''}\n${session.agent ?? ''}\n${(session.prompts ?? []).join('\n')}`.toLowerCase()
  return haystack.includes(keyword)
}

/** First indexed snippet that matched the keyword, trimmed for one console line. */
function matchingPrompt(session, keyword) {
  if (!keyword) return null
  const hit = (session.prompts ?? []).find((prompt) => String(prompt).toLowerCase().includes(keyword))
  if (!hit) return null
  const flat = String(hit).replace(/\s+/g, ' ').trim()
  return flat.length > 100 ? `${flat.slice(0, 100)}…` : flat
}

function formatSession(entry, keyword) {
  const { group, session } = entry
  const where = session.remote ? `ssh:${session.host ?? '?'}` : group.label
  const agent = String(session.agent ?? '?').padEnd(11)
  const date = (session.updatedAt ?? session.createdAt ?? '').slice(0, 16).replace('T', ' ')
  const lines = [`[${agent}] ${date}  ${where}`]
  lines.push(`    ${session.title ?? '(无标题)'}`)
  const snippet = matchingPrompt(session, keyword)
  if (snippet) lines.push(`    ↳ ${snippet}`)
  lines.push(`    id=${session.agent ?? '?'}:${session.id}`)
  return lines.join('\n')
}

const LABEL_WIDTH = 11
const AGENT_LABELS = {}

async function loadAdapters() {
  try {
    const { ADAPTERS } = await import('./sources/index.mjs')
    for (const adapter of ADAPTERS) AGENT_LABELS[adapter.meta.id] = adapter.meta.label
    return ADAPTERS
  } catch {
    return []
  }
}

async function cmdScan(args) {
  const out = resolveOut(args.out)
  const index = await scanAll({ deep: args.deep === true })
  await writeIndex(index, out)
  if (args.json) {
    process.stdout.write(`${JSON.stringify(index, null, 2)}\n`)
    return 0
  }
  if (!args.quiet) {
    for (const source of index.sources ?? []) {
      if (!source.detected) {
        console.log(`${source.label.padEnd(LABEL_WIDTH)} 未启用（本机没有数据）`)
        continue
      }
      const status = source.error ? `ERROR ${source.error}` : `${source.sessions} 会话 · ${source.files} 文件 · ${source.ms} ms`
      console.log(`${source.label.padEnd(LABEL_WIDTH)} ${status}`)
    }
    const stats = index.stats ?? {}
    console.log(
      `合计 ${stats.sessions ?? 0} 会话 / ${stats.groups ?? 0} 项目 / ${Math.round((stats.totalBytes ?? 0) / 1048576)} MB · ` +
        `远程 ${stats.remoteSessions ?? 0} · 可搜索 ${stats.withPrompts ?? 0} 会话（${stats.promptTotal ?? 0} 条摘要） · ${stats.scanMs ?? 0} ms`,
    )
    for (const warning of index.warnings ?? []) console.log(`! ${warning}`)
    console.log(`索引已写入 ${out}`)
  }
  return 0
}

async function cmdList(args) {
  const index = (await readIndex()) ?? (await scanAll({}).then(async (scanned) => {
    await writeIndex(scanned)
    return scanned
  }))
  await loadAdapters()
  const keyword = typeof args.q === 'string' ? args.q.trim().toLowerCase() : ''
  const limit = Number(args.limit ?? 50)
  const agentFilter = typeof args.agent === 'string' ? args.agent.toLowerCase() : ''
  let rows = flatSessions(index)
  if (args.local) rows = rows.filter((row) => !row.session.remote)
  if (args.remote) rows = rows.filter((row) => row.session.remote)
  // `--agent cursor` must find inbox sessions that came from cursor, not only
  // sessions whose adapter id is literally "cursor".
  if (agentFilter) {
    rows = rows.filter((row) => {
      const id = String(row.session.agent ?? '').toLowerCase()
      const actor = String(row.session.actor ?? '').toLowerCase()
      return id === agentFilter || actor === agentFilter
    })
  }
  if (keyword) rows = rows.filter((row) => matches(row, keyword))
  rows.sort((a, b) => Date.parse(b.session.updatedAt ?? 0) - Date.parse(a.session.updatedAt ?? 0))
  const shown = rows.slice(0, Number.isFinite(limit) && limit > 0 ? limit : 50)
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ total: rows.length, sessions: shown.map((row) => row.session) }, null, 2)}\n`)
    return rows.length === 0 ? 3 : 0
  }
  if (shown.length === 0) {
    console.log(keyword ? `没有匹配 “${args.q}” 的会话` : '没有会话')
    return 3
  }
  for (const row of shown) console.log(formatSession(row, keyword))
  console.log(`\n共 ${rows.length} 条${keyword ? `（关键词 ${args.q}）` : ''}，显示 ${shown.length} 条`)
  return 0
}

async function cmdShow(args) {
  const id = typeof args.id === 'string' ? args.id : ''
  if (!id) {
    console.error('需要 --id <agent:id | id>')
    return 1
  }
  const index = (await readIndex()) ?? (await scanAll({}))
  const hit = findHubSession(index, id)
  if (!hit) {
    console.error(`找不到会话: ${id}`)
    return 3
  }
  const maxMessages = Number(args.maxMessages ?? 200)
  const transcript = await readSessionTranscript(hit.session, { maxMessages })
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ ...transcript, agent: hit.session.agent }, null, 2)}\n`)
    return 0
  }
  console.log(`# ${hit.session.title ?? '(无标题)'}`)
  console.log(`agent=${hit.session.agent} id=${hit.session.id} cwd=${hit.session.cwd ?? '-'}`)
  if (hit.session.remote) console.log(`remote=ssh:${hit.session.host ?? '?'}`)
  console.log('')
  for (const message of transcript.messages) {
    const who = message.role === 'tool' ? `tool:${message.name ?? '?'}` : message.role
    console.log(`--- ${who} ${message.ts ?? ''}`.trim())
    console.log(message.text)
    console.log('')
  }
  console.log(`${transcript.messageCount} 条消息${transcript.truncated ? '（已截断）' : ''}`)
  return 0
}

async function cmdStats(args) {
  const index = (await readIndex()) ?? (await scanAll({}).then(async (scanned) => {
    await writeIndex(scanned)
    return scanned
  }))
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ generatedAt: index.generatedAt, version: index.version, stats: index.stats, sources: index.sources, warnings: index.warnings }, null, 2)}\n`)
    return 0
  }
  console.log(`索引 ${index.generatedAt} · version ${index.version}`)
  for (const source of index.sources ?? []) {
    const status = source.detected ? `${source.sessions} 会话 / ${source.files} 文件 / ${source.ms} ms` : '未启用'
    console.log(`  ${String(source.label).padEnd(LABEL_WIDTH)} ${status}${source.error ? ` · ${source.error}` : ''}`)
  }
  const stats = index.stats ?? {}
  console.log(
    `\n会话 ${stats.sessions ?? 0} · 项目 ${stats.groups ?? 0} · 文件 ${stats.files ?? 0} · 重复 ${stats.duplicates ?? 0} · ` +
      `字节 ${stats.totalBytes ?? 0} · 可搜索 ${stats.withPrompts ?? 0}/${stats.sessions ?? 0} · 耗时 ${stats.scanMs ?? 0} ms`,
  )
  for (const warning of index.warnings ?? []) console.log(`! ${warning}`)
  return 0
}

async function cmdShare(args) {
  const tags = typeof args.tags === 'string' ? args.tags : []
  const refs = typeof args.refs === 'string' ? args.refs : []
  const entry = appendShared({
    title: args.title === true ? '' : args.title,
    body: args.body === true ? '' : args.body,
    kind: args.kind === true ? undefined : args.kind,
    tags,
    refs,
    agent: args.agent === true ? undefined : args.agent,
    cwd: args.cwd === true ? undefined : args.cwd,
  })
  console.log(`已写入共享上下文：${entry.kind} · ${entry.title}`)
  console.log(`id=${entry.id} at=${entry.at}`)
  return 0
}

async function cmdContext(args) {
  const result = listShared({
    q: typeof args.q === 'string' ? args.q : '',
    agent: typeof args.agent === 'string' ? args.agent : '',
    kind: typeof args.kind === 'string' ? args.kind : '',
    cwd: typeof args.cwd === 'string' ? args.cwd : '',
    limit: Number(args.limit ?? 30),
  })
  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return result.total === 0 ? 3 : 0
  }
  if (result.entries.length === 0) {
    console.log('共享上下文还是空的（用 share 写入第一条）')
    return 3
  }
  for (const entry of result.entries) {
    console.log(`[${entry.kind}] ${entry.at} ${entry.agent}  ${entry.title}`)
    if (entry.body) console.log(`    ${String(entry.body).split('\n').slice(0, 4).join('\n    ')}`)
    if ((entry.tags ?? []).length > 0) console.log(`    tags: ${(entry.tags ?? []).join(',')}`)
  }
  console.log(`\n共 ${result.total} 条（总库 ${result.all} 条）`)
  return 0
}

async function cmdDigest(args) {
  const result = digestShared({ cwd: typeof args.cwd === 'string' ? args.cwd : '', limit: Number(args.limit ?? 20) })
  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return result.count === 0 ? 3 : 0
  }
  if (result.count === 0) {
    console.log('这个项目还没有共享上下文条目')
    return 3
  }
  console.log(result.markdown)
  return 0
}

async function cmdPaths(args) {
  const info = {
    dataHome: paths.dataHome(),
    indexPath: paths.indexFile(),
    remoteDir: paths.remoteDir(),
    sharedFile: paths.sharedFile(),
    inboxDir: paths.inboxDir(),
    sourcesFile: paths.sourcesFile(),
  }
  if (args.json) process.stdout.write(`${JSON.stringify(info, null, 2)}\n`)
  else for (const [key, value] of Object.entries(info)) console.log(key.padEnd(12) + value)
  return 0
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const command = String(args._[0] ?? 'list')
  try {
    switch (command) {
      case 'scan':
        return await cmdScan(args)
      case 'list':
        return await cmdList(args)
      case 'show':
        return await cmdShow(args)
      case 'stats':
        return await cmdStats(args)
      case 'share':
        return await cmdShare(args)
      case 'context':
        return await cmdContext(args)
      case 'digest':
        return await cmdDigest(args)
      case 'paths':
        return await cmdPaths(args)
      default:
        console.error(`未知命令: ${command}`)
        console.error('可用: scan | list | show | stats | share | context | digest')
        return 1
    }
  } catch (error) {
    console.error(`失败: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

main().then((code) => {
  process.exitCode = code
})
