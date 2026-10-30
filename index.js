/**
 * agent-context-hub — host half.
 *
 * One panel for every coding agent on this machine: it indexes the history of
 * Codex (local + ssh remote), Claude Code, DSH itself and any agent that drops
 * JSONL into the inbox, and serves both the session archive and a shared
 * context log every agent can append to.
 *
 * Routes (private prefix, so they never collide with the Harness API fence):
 *   GET  /agent-context/api/ping                        -> liveness probe
 *   GET  /agent-context/api/list?refresh=0|1            -> index.json (or a fresh scan)
 *   GET  /agent-context/api/stats                       -> scan stats + warnings + sources
 *   GET  /agent-context/api/sources                     -> per-source counts/health
 *   GET  /agent-context/api/transcript?id=<agent>:<id>  -> transcript of one session
 *   GET  /agent-context/api/shared?q=&agent=&kind=      -> shared context entries
 *   POST /agent-context/api/shared                      -> append a shared context entry
 *   GET  /agent-context/api/digest?cwd=                 -> markdown digest for one project
 *   GET  /agent-context/api/client.js                   -> our own client bundle
 *
 * The heavy lifting lives in ./lib (pure Node, no Harness imports) so the same
 * code is reusable from the scheduled task, the CLI and any other agent.
 */

import path from 'node:path'
import fs from 'node:fs'
import { stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

export const name = 'agent-context-hub'

const PKG_ROOT = path.dirname(fileURLToPath(import.meta.url))
const ROUTE_PREFIX = '/agent-context/api'
/** Our own copy of the client bundle, served so the panel never depends on the boot graph. */
const CLIENT_FILE = path.join(PKG_ROOT, 'client.js')
const CLIENT_SRC = `${ROUTE_PREFIX}/client.js`
const CLIENT_ID = 'agent-context-hub'

/** An index older than this triggers a background rescan (the client is told). */
const STALE_MS = 10 * 60 * 1000
/** Upper bound of messages returned by one transcript request. */
const MAX_MESSAGES = 400
/** Shared-context POST body limit. */
const MAX_BODY_BYTES = 256 * 1024

let libPromise = null
let libLoadedQuery = null

/**
 * Bust the ESM module cache for ./lib.
 *
 * A plugin reload re-evaluates this file, but a plain `import('./lib/x.mjs')`
 * resolves to the SAME module instance the host process imported earlier — the
 * reload would keep running the old data layer. That is not theoretical: an old
 * in-memory indexer kept rescanning and rewrote the index with a previous
 * format. Hashing every lib file's size/mtime makes a reload import current code.
 */
function libQuery() {
  const files = []
  const stack = [path.join(PKG_ROOT, 'lib')]
  while (stack.length > 0) {
    const dir = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.isFile() && entry.name.endsWith('.mjs')) files.push(full)
    }
  }
  let token = ''
  for (const file of files.sort()) {
    try {
      const info = fs.statSync(file)
      token += `${path.basename(file)}:${info.size}-${Math.floor(info.mtimeMs)}.`
    } catch {
      token += `${path.basename(file)}:missing.`
    }
  }
  return `v=${encodeURIComponent(token)}`
}

function loadLib() {
  const query = libQuery()
  // Editing a lib file while the host runs must take effect on the next
  // request, not only after a plugin reload: compare the token each time.
  if (libPromise && libLoadedQuery === query) return libPromise
  libPromise = Promise.all([
    import(`./lib/hub.mjs?${query}`),
    import(`./lib/paths.mjs?${query}`),
    import(`./lib/shared.mjs?${query}`),
    import(`./lib/transcript.mjs?${query}`),
  ])
    .then(([hub, paths, shared, transcript]) => {
      libLoadedQuery = query
      return { hub, paths, shared, transcript }
    })
    // A missing or broken data layer must not poison every later request: the
    // files arrive after a first install, while the plugin stays mounted.
    .catch((error) => {
      libPromise = null
      libLoadedQuery = null
      throw error
    })
  return libPromise
}

function log(ctx, level, message) {
  const logger = ctx?.logger
  const sink = logger ? logger[level] : undefined
  if (typeof sink === 'function') sink.call(logger, `agent-context-hub: ${message}`)
  else if (level === 'error') console.error(`agent-context-hub: ${message}`)
  else console.warn(`agent-context-hub: ${message}`)
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

function sendError(response, status, message, extra) {
  sendJson(response, status, { error: { status, message: String(message ?? ''), ...extra } })
}

async function safeCall(fn, fallback = null) {
  try {
    return await fn()
  } catch {
    return fallback
  }
}

/** Read `sources.json` (extra roots per machine). A broken file is not fatal. */
async function readSourceConfig(paths) {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(paths.sourcesFile(), 'utf8'))
    const roots = Array.isArray(parsed?.codexRoots) ? parsed.codexRoots.filter((root) => typeof root === 'string') : undefined
    return { codexRoots: roots && roots.length > 0 ? roots : undefined }
  } catch {
    return {}
  }
}

/**
 * In-memory index cache with single-flight scanning.
 * Disk cache is the source of truth across restarts; a scan reuses it.
 */
function createIndexStore(ctx) {
  let index = null
  let loadedAt = 0
  let loadedFileMtime = 0
  let scanning = null
  let lastError = null
  /** Version of the index format THIS build of ./lib writes (filled on load). */
  let requiredVersion = null
  let indexFile = null

  const noteVersion = (hub) => {
    if (Number.isFinite(hub?.INDEX_VERSION)) requiredVersion = hub.INDEX_VERSION
  }

  // A candidate from disk or memory is only served when it was written by the
  // same indexer generation. An older host process (whose ESM modules are still
  // cached) can rescan and overwrite index.json with the previous format;
  // serving that would silently drop newer fields from the panel.
  const compatible = (candidate) =>
    Boolean(candidate) && (requiredVersion === null || candidate.version === requiredVersion)

  const ageOf = (candidate) => {
    const generated = Date.parse(candidate?.generatedAt ?? '')
    return Number.isFinite(generated) ? Date.now() - generated : Number.POSITIVE_INFINITY
  }

  // Freshness is the age of the DATA (index.generatedAt), not the age of the
  // in-memory copy: warm-up loads the on-disk index right after a host restart,
  // so a loadedAt-based check would report a day-old index as fresh and never
  // trigger the rescan the client waits for.
  const isFresh = (candidate) => ageOf(candidate) <= STALE_MS

  const resolveIndexFile = async () => {
    if (!indexFile) {
      const { paths } = await loadLib()
      indexFile = paths.indexFile()
    }
    return indexFile
  }

  async function diskMtime() {
    try {
      const info = await stat(await resolveIndexFile())
      return info.mtimeMs
    } catch {
      return 0
    }
  }

  async function readDisk() {
    const { hub } = await loadLib()
    noteVersion(hub)
    const fromDisk = await hub.readIndex(await resolveIndexFile())
    if (!fromDisk) return null
    if (!compatible(fromDisk)) {
      log(ctx, 'warn', `disk index version ${fromDisk.version ?? 'unknown'} != ${requiredVersion}; rebuilding instead of serving it`)
      return null
    }
    return fromDisk
  }

  async function runScan() {
    const { hub, paths } = await loadLib()
    noteVersion(hub)
    const config = await readSourceConfig(paths)
    const scanned = await hub.scanAll({
      codexRoots: config.codexRoots,
      remoteDir: paths.remoteDir(),
    })
    index = scanned
    loadedAt = Date.now()
    lastError = null
    await safeCall(() => hub.writeIndex(scanned, paths.indexFile()))
    loadedFileMtime = await diskMtime()
    return scanned
  }

  function startScan() {
    if (!scanning) {
      scanning = runScan()
        .catch((error) => {
          lastError = error instanceof Error ? error.message : String(error)
          log(ctx, 'error', `scan failed: ${lastError}`)
          throw error
        })
        .finally(() => {
          scanning = null
        })
    }
    return scanning
  }

  return {
    /** Fresh in-memory value when available, otherwise disk, otherwise scan. */
    async get({ force = false, allowBackgroundScan = true } = {}) {
      if (!force && index && compatible(index) && isFresh(index)) {
        // The scheduled task or an external `cli.mjs scan` can rewrite the disk
        // index while this process keeps an in-memory copy: with a pure
        // generatedAt check the panel would keep showing the old data until the
        // 10-minute stale window. One stat plus a ~200 KB re-parse makes a
        // finished sync visible on the next request instead.
        const mtime = await diskMtime()
        if (mtime > loadedFileMtime) {
          const fromDisk = await safeCall(readDisk)
          if (fromDisk) {
            index = fromDisk
            loadedAt = Date.now()
            loadedFileMtime = mtime
            const stale = !isFresh(fromDisk)
            if (stale && allowBackgroundScan) startScan().catch(() => {})
            return { index, stale, scanning: stale }
          }
          if (allowBackgroundScan) startScan().catch(() => {})
          return { index, stale: true, scanning: scanning !== null }
        }
        return { index, stale: false, scanning: scanning !== null }
      }
      if (!force) {
        const fromDisk = await safeCall(readDisk)
        if (compatible(fromDisk)) {
          index = fromDisk
          loadedAt = Date.now()
          loadedFileMtime = await diskMtime()
          const stale = !isFresh(fromDisk)
          if (stale && allowBackgroundScan) startScan().catch(() => {})
          return { index, stale, scanning: stale }
        }
      }
      const scanned = await startScan()
      return { index: scanned, stale: false, scanning: false }
    },
    lastError: () => lastError,
    isScanning: () => scanning !== null,
  }
}

/**
 * Diagnostic view of the Web client half: whether the shell's boot graph lists
 * this plugin's bundle, which URL that graph advertises, and whether our own
 * index-injection row and bundle route have been exercised.
 */
const clientTelemetry = { injections: 0, lastInjectionAt: null, clientServes: 0, lastClientServeAt: null }
/** Last page beacons, newest last (see `client.js` `hubBeacon`). */
const pageBeacons = []
const BEACON_LIMIT = 30

function recordBeacon(entry) {
  pageBeacons.push(entry)
  while (pageBeacons.length > BEACON_LIMIT) pageBeacons.shift()
}

function clientStatus(registry) {
  const telemetry = { ...clientTelemetry }
  if (!registry || typeof registry.graph !== 'function') return { registry: false, inBootGraph: null, rev: null, ...telemetry }
  try {
    const graph = registry.graph()
    const entries = Array.isArray(graph?.entries) ? graph.entries : []
    const row = entries.find((entry) => entry?.id === CLIENT_ID || entry?.id === `${CLIENT_ID}/client`)
    return {
      registry: true,
      inBootGraph: Boolean(row),
      rev: graph?.rev ?? null,
      entries: entries.length,
      clientPath: typeof registry.clientPath === 'function' ? registry.clientPath(CLIENT_ID) ?? null : null,
      row: row ? { id: row.id ?? null, rev: row.rev ?? null, url: row.url ?? null } : null,
      ...telemetry,
      beacons: pageBeacons.slice(-12),
    }
  } catch (error) {
    return { registry: true, inBootGraph: null, error: error instanceof Error ? error.message : String(error), ...telemetry }
  }
}

async function readBody(request, limit) {
  let raw = ''
  for await (const chunk of request) {
    raw += chunk
    if (raw.length > limit) {
      const error = new Error('请求体过大')
      error.code = 'E_TOO_LARGE'
      throw error
    }
  }
  return raw
}

export function apply(ctx) {
  const store = createIndexStore(ctx)
  /** Client-module registry, captured through an optional inject (may be absent). */
  let clientRegistry = null

  ctx.inject(['clientModules'], (registryCtx) => {
    clientRegistry = registryCtx.clientModules ?? null
    // The Web shell renders its document while the profile's own plugin entries
    // are still being activated, so a page opened during host start carries a
    // boot graph composed before this bundle existed — the sidebar icon is then
    // missing until the page is reloaded by hand. Pushing one graph notification
    // makes every connected page run `entries.sync(graph)` and pick the bundle
    // up live (the same path `dsh-client-hmr` uses for new entries).
    const pushGraph = () => {
      try {
        clientRegistry?.notifyGraphChanged?.()
      } catch (error) {
        log(ctx, 'warn', `graph notification failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const timer = setTimeout(pushGraph, 1200)
    const retry = setTimeout(pushGraph, 4000)
    registryCtx.effect(() => () => {
      clearTimeout(timer)
      clearTimeout(retry)
      clientRegistry = null
    })
  })

  ctx.inject(['webServer'], (hostCtx) => {
    hostCtx.effect(() => {
      const dispose = hostCtx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (request, response) => {
          const method = (request.method ?? 'GET').toUpperCase()
          const url = new URL(request.url ?? '/', 'http://localhost')
          const action = url.pathname.slice(ROUTE_PREFIX.length).replace(/^\/+/, '').replace(/\/+$/, '')
          const isBeacon = action === 'beacon'
          const isSharedPost = action === 'shared' && method === 'POST'
          if (method !== 'GET' && method !== 'HEAD' && !isBeacon && !isSharedPost) {
            response.writeHead(405, { allow: 'GET, HEAD, POST' })
            response.end()
            return
          }
          try {
            if (action === 'ping') {
              sendJson(response, 200, { ok: true, at: new Date().toISOString(), name })
              return
            }
            if (action === 'list') {
              const force = url.searchParams.get('refresh') === '1'
              const { index: data, stale, scanning } = await store.get({ force })
              sendJson(response, 200, { ...data, hosts: data.hosts ?? [], stale, scanning })
              return
            }
            if (action === 'sources') {
              const { index: data } = await store.get({ allowBackgroundScan: false })
              sendJson(response, 200, { generatedAt: data.generatedAt, sources: data.sources ?? [], byAgent: data.stats?.byAgent ?? {} })
              return
            }
            if (action === 'beacon') {
              const raw = await readBody(request, 8192).catch(() => '')
              let body = null
              try {
                body = raw ? JSON.parse(raw) : null
              } catch {
                body = { stage: 'invalid-json', detail: raw.slice(0, 200) }
              }
              const entry = {
                at: new Date().toISOString(),
                stage: String(body?.stage ?? '(none)').slice(0, 60),
                detail: body?.detail === null || body?.detail === undefined ? null : String(body.detail).slice(0, 200),
              }
              recordBeacon(entry)
              log(ctx, 'info', `page beacon ${entry.stage}${entry.detail ? ` (${entry.detail})` : ''}`)
              response.writeHead(204, { 'cache-control': 'no-store' })
              response.end()
              return
            }
            if (action === 'client.js') {
              // Self-registration fallback: the Web shell normally preloads every
              // `dsh.client` bundle from its boot graph, but that composition runs
              // once during host start and this plugin has been observed missing
              // from it on a cold start. Serving the bundle ourselves plus the
              // index-inject row below makes the panel independent of it.
              const body = await fs.promises.readFile(CLIENT_FILE)
              clientTelemetry.clientServes += 1
              clientTelemetry.lastClientServeAt = new Date().toISOString()
              response.writeHead(200, {
                'content-type': 'text/javascript; charset=utf-8',
                'content-length': String(body.length),
                'cache-control': 'no-store',
              })
              response.end(method === 'HEAD' ? undefined : body)
              return
            }
            if (action === 'stats') {
              const { index: data } = await store.get({ allowBackgroundScan: false })
              sendJson(response, 200, {
                generatedAt: data.generatedAt,
                stats: data.stats,
                warnings: data.warnings ?? [],
                sources: (data.sources ?? []).map((source) => ({
                  id: source.id,
                  label: source.label,
                  detected: source.detected,
                  sessions: source.sessions,
                  ms: source.ms,
                  error: source.error,
                  warnings: source.warnings ?? 0,
                })),
                hosts: data.hosts ?? [],
                scanning: store.isScanning(),
                lastError: store.lastError(),
                client: clientStatus(clientRegistry),
              })
              return
            }
            if (action === 'shared') {
              const { shared } = await loadLib()
              if (method === 'POST') {
                let payload
                try {
                  const raw = await readBody(request, MAX_BODY_BYTES)
                  payload = raw ? JSON.parse(raw) : {}
                } catch (error) {
                  const tooLarge = error?.code === 'E_TOO_LARGE'
                  sendError(response, tooLarge ? 413 : 400, tooLarge ? '请求体过大' : '正文不是合法 JSON')
                  return
                }
                try {
                  const entry = shared.appendShared({ ...payload, agent: payload?.agent ?? 'dsh' })
                  log(ctx, 'info', `shared +${entry.kind} ${entry.title.slice(0, 40)}`)
                  sendJson(response, 201, { entry })
                } catch (error) {
                  sendError(response, 400, error instanceof Error ? error.message : String(error))
                }
                return
              }
              const result = shared.listShared({
                q: url.searchParams.get('q') ?? '',
                agent: url.searchParams.get('agent') ?? '',
                kind: url.searchParams.get('kind') ?? '',
                cwd: url.searchParams.get('cwd') ?? '',
                limit: Number(url.searchParams.get('limit') ?? 50),
              })
              sendJson(response, 200, result)
              return
            }
            if (action === 'digest') {
              const { shared } = await loadLib()
              sendJson(
                response,
                200,
                shared.digestShared({ cwd: url.searchParams.get('cwd') ?? '', limit: Number(url.searchParams.get('limit') ?? 20) }),
              )
              return
            }
            if (action === 'transcript') {
              const id = url.searchParams.get('id')
              if (!id) {
                sendError(response, 400, 'missing id')
                return
              }
              const { index: data, stale } = await store.get({ allowBackgroundScan: false })
              const { hub, transcript } = await loadLib()
              const hit = hub.findSession(data, id)
              if (!hit) {
                sendError(response, 404, `session not found: ${id}`, { stale })
                return
              }
              const requested = Number(url.searchParams.get('maxMessages') ?? url.searchParams.get('max-messages'))
              const maxMessages = Number.isFinite(requested) && requested > 0 ? Math.min(Math.floor(requested), MAX_MESSAGES) : MAX_MESSAGES
              try {
                const body = await transcript.readSessionTranscript(hit.session, { maxMessages })
                sendJson(response, 200, { ...body, agent: hit.session.agent, stale })
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                const status = error?.code === 'ENOENT' ? 404 : 502
                log(ctx, 'warn', `transcript ${id} failed: ${message}`)
                sendError(response, status, message, { agent: hit.session.agent ?? null, host: hit.session.host ?? null, stale })
              }
              return
            }
            sendError(response, 404, `unknown action: ${action || '(root)'}`)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            log(ctx, 'error', `request ${action} failed: ${message}`)
            sendError(response, 500, message, { lastError: store.lastError() })
          }
        },
      })
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    }, 'agent-context-hub: http api')

    // The Web shell normally preloads the client half from its boot graph, but
    // that graph is composed once at host start and this plugin has been missing
    // from it on cold starts. Injecting the bundle into the page shell makes the
    // panel independent of that composition; `client.js` ignores a second load.
    hostCtx.effect(() => {
      const on = typeof hostCtx.on === 'function' ? hostCtx.on.bind(hostCtx) : null
      if (!on) return () => {}
      const off = on('webserver/index-inject', (table) => {
        if (!Array.isArray(table)) return
        clientTelemetry.injections += 1
        clientTelemetry.lastInjectionAt = new Date().toISOString()
        if (table.some((row) => row && row.kind === 'script-src' && row.src === CLIENT_SRC)) return
        table.push({ kind: 'script-src', placement: 'head', src: CLIENT_SRC })
      })
      return () => {
        if (typeof off === 'function') off()
      }
    }, 'agent-context-hub: client bundle injection')

    // Warm the index as soon as the host is up, so the panel opens instantly.
    hostCtx.effect(() => {
      let cancelled = false
      Promise.resolve()
        .then(() => store.get({ allowBackgroundScan: true }))
        .then(({ index: data, stale }) => {
          if (cancelled) return
          log(ctx, 'info', `ready: ${data?.stats?.sessions ?? 0} sessions from ${data?.sources?.length ?? 0} sources, stale=${stale}`)
        })
        .catch((error) => log(ctx, 'warn', `warm-up failed: ${error instanceof Error ? error.message : String(error)}`))
      return () => {
        cancelled = true
      }
    }, 'agent-context-hub: warm-up')
  })
}
