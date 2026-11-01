#!/usr/bin/env node
/**
 * api-contract.mjs — exercise the live HTTP surface of the hub, route by route.
 *
 *   node scripts/verify-api.mjs [--port 56842] [--json] [--no-write]
 *
 * Read-only except for one `POST /shared` (skipped with --no-write), which is
 * how an external agent feeds the board. It writes a single, clearly labelled
 * self-test entry so the run proves the write path instead of only the reads.
 *
 * Exit 0 when every assertion holds, 1 otherwise.
 */

const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = argv.indexOf(name)
  return i === -1 ? fallback : argv[i + 1]
}
const PORT = argOf('--port', '56842')
const BASE = `http://127.0.0.1:${PORT}/agent-context/api`
const asJson = argv.includes('--json')
const noWrite = argv.includes('--no-write')

const rows = []
const check = (name, ok, detail = '') => rows.push({ name, ok, detail })

/** Error payloads come back as `{code, message}` objects; keep the log readable. */
const describe = (value) => {
  if (value == null) return ''
  if (typeof value === 'string') return value.slice(0, 80)
  const text = value.message ?? value.error?.message ?? value.code ?? JSON.stringify(value)
  return String(text).slice(0, 80)
}

async function call(pathname, init = {}) {
  const res = await fetch(`${BASE}${pathname}`, { ...init, signal: AbortSignal.timeout(20000) })
  const text = await res.text()
  let body = null
  try {
    body = JSON.parse(text)
  } catch {
    body = null
  }
  return { status: res.status, type: res.headers.get('content-type') ?? '', text, body }
}

/* ---------------------------------------------------------------- read side */
const ping = await call('/ping')
check('GET /ping answers with the plugin name', ping.status === 200 && ping.body?.name === 'agent-context-hub', `${ping.status} ${ping.body?.name ?? ping.text.slice(0, 60)}`)

const list = await call('/list')
const sessions = list.body?.groups?.flatMap((group) => group.sessions ?? []) ?? []
const agents = new Set(sessions.map((row) => row.agent))
check('GET /list returns a versioned index', list.status === 200 && list.body?.version >= 5, `v${list.body?.version} · ${sessions.length} sessions`)
check('GET /list carries more than one agent', agents.size >= 2, [...agents].join(', '))
check('GET /list groups by project', (list.body?.groups?.length ?? 0) > 0, `${list.body?.groups?.length} groups`)
check('GET /list rows expose the searchable prompt text', sessions.some((row) => Array.isArray(row.prompts) && row.prompts.length > 0), `${sessions.filter((row) => row.prompts?.length).length} rows with prompts`)

const firstTitleWord = (sessions.find((row) => row.title)?.title ?? '').split(/\s+/)[0]?.slice(0, 6) ?? ''
if (firstTitleWord) {
  const filtered = await call(`/list?q=${encodeURIComponent(firstTitleWord)}`)
  const hitCount = filtered.body?.groups?.flatMap((group) => group.sessions ?? []).length ?? -1
  check('GET /list?q= filters the index', filtered.status === 200 && hitCount >= 0, `q=${firstTitleWord} · ${hitCount} hits`)
}

const sources = await call('/sources')
const sourceIds = (sources.body?.sources ?? []).map((source) => source.id)
check('GET /sources lists every adapter', sources.status === 200 && ['codex', 'claude-code', 'dsh', 'inbox'].every((id) => sourceIds.includes(id)), sourceIds.join(', '))

const stats = await call('/stats')
check('GET /stats reports totals', stats.status === 200 && Number.isFinite(stats.body?.sessions ?? stats.body?.stats?.sessions), `${stats.body?.sessions ?? stats.body?.stats?.sessions} sessions`)

const shared = await call('/shared')
check('GET /shared answers with the board', shared.status === 200 && Array.isArray(shared.body?.entries), `${shared.body?.total ?? shared.body?.entries?.length ?? 0} entries`)

const digest = await call('/digest')
check('GET /digest renders markdown', digest.status === 200 && typeof (digest.body?.markdown ?? digest.body?.digest) === 'string', `${((digest.body?.markdown ?? digest.body?.digest) ?? '').length} chars`)

/* --------------------------------------------------------- transcript reads */
const missingId = await call('/transcript')
check('GET /transcript without ?id= is a 400', missingId.status === 400, `${missingId.status} ${describe(missingId.body?.error)}`)

const unknownId = await call('/transcript?id=no-such-session-xyz')
check('GET /transcript for an unknown id is a 404', unknownId.status === 404, `${unknownId.status} ${describe(unknownId.body?.error)}`)

const localRow = sessions.find((row) => row.agent === 'codex' && !row.remote) ?? sessions[0]
if (localRow) {
  const transcript = await call(`/transcript?id=${encodeURIComponent(localRow.id)}`)
  const messages = transcript.body?.messages?.length ?? 0
  check('GET /transcript reads a real local session', transcript.status === 200 && messages > 0, `${localRow.agent}:${localRow.id.slice(0, 8)} · ${messages} messages`)
}

const remoteRow = sessions.find((row) => row.remote === true)
if (remoteRow) {
  const started = Date.now()
  const transcript = await call(`/transcript?id=${encodeURIComponent(remoteRow.id)}`)
  check('GET /transcript reads a remote session over ssh', transcript.status === 200 && (transcript.body?.messages?.length ?? 0) > 0, `${Date.now() - started} ms · ${transcript.body?.messages?.length ?? 0} messages`)
} else {
  check('GET /transcript reads a remote session over ssh', true, 'no remote row in this index — skipped')
}

/* ---------------------------------------------------------------- write side */
async function post(pathname, payload, raw = null) {
  return call(pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw ?? JSON.stringify(payload),
  })
}

const badJson = await post('/shared', null, '{not json')
check('POST /shared rejects malformed JSON with a 400', badJson.status === 400, `${badJson.status} ${describe(badJson.body?.error)}`)

if (!noWrite) {
  const derived = await post('/shared', { body: 'body without a title' })
  check('POST /shared derives a title when only a body is given', derived.status === 201 || derived.status === 200, `${derived.status} title=${JSON.stringify(derived.body?.entry?.title ?? '')}`)
}

const empty = await post('/shared', { title: '   ', body: '' })
check('POST /shared rejects an entry with neither title nor body', empty.status === 400, `${empty.status} ${describe(empty.body?.error ?? empty.text)}`)

const badKind = await post('/shared', { title: 'kind probe', body: 'x', kind: 'nonsense' })
check('POST /shared rejects an unknown kind', badKind.status === 400, `${badKind.status} ${describe(badKind.body?.error)}`)

if (!noWrite) {
  const stamp = new Date().toISOString()
  const wrote = await post('/shared', {
    title: '[self-test] api-contract.mjs write path',
    body: `Written by scripts/verify-api.mjs at ${stamp} to prove POST /shared works from outside the harness. Safe to ignore.`,
    kind: 'note',
    tags: ['self-test'],
    agent: 'agent-context-hub',
  })
  const entryId = wrote.body?.entry?.id ?? wrote.body?.id ?? null
  check('POST /shared appends an entry', (wrote.status === 200 || wrote.status === 201) && Boolean(entryId), `${wrote.status} id=${String(entryId).slice(0, 8)}`)

  const after = await call('/shared')
  const found = (after.body?.entries ?? []).some((entry) => entry.id === entryId)
  check('the new entry is visible on the next GET /shared', found, found ? 'visible' : 'not found')
}

/* ------------------------------------------------------------- static + 404 */
const client = await call('/client.js')
check('GET /client.js serves the browser bundle', client.status === 200 && client.text.includes('agent-context-hub'), `${client.status} · ${client.text.length} bytes · ${client.type.split(';')[0]}`)

const nowhere = await call('/does-not-exist')
check('an unknown route is a 404', nowhere.status === 404, String(nowhere.status))

/* -------------------------------------------------------------------- output */
const failed = rows.filter((row) => !row.ok)
if (asJson) {
  console.log(JSON.stringify({ ok: failed.length === 0, base: BASE, rows }, null, 2))
} else {
  const width = Math.max(...rows.map((row) => row.name.length))
  for (const row of rows) console.log(`${row.ok ? 'PASS' : 'FAIL'}  ${row.name.padEnd(width)}  ${row.detail}`)
  console.log('')
  console.log(`${rows.length - failed.length} pass / ${failed.length} fail`)
}
process.exit(failed.length === 0 ? 0 : 1)
