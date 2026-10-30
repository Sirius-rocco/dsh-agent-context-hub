#!/usr/bin/env node
/**
 * Build the metadata-only index of Codex sessions that live on the ssh host.
 *
 * The remote rollouts (rag_research by default) are visible in the local Codex
 * app, but their files are on the server: ~1.2 GB of jsonl. This script copies
 * *no* session body — it asks one remote python3 worker for per-file head/tail
 * metadata (id, cwd, timestamps, first user text, plus the user prompts found in
 * a bounded head/tail window, so search can match session content) and writes
 * `cache/remote-<host>.json`, which `lib/indexer.mjs` merges into the index.
 * Transcripts are fetched over ssh on demand by `index.js`.
 *
 * Usage:
 *   node scripts/sync-remote.mjs [--host rag_research] [--out cache/remote-rag_research.json]
 *                                [--timeout 180] [--dry-run] [--strict] [--json] [--quiet]
 *
 * Exit codes: 0 ok (also when ssh is unavailable and a previous fragment is
 * kept, unless --strict), 1 failure, 3 nothing found.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { titleFromText } from '../lib/parser.mjs'

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_ROOTS = ['/home/oppoer/.codex/sessions', '/home/oppoer/.codex/archived_sessions']

const REMOTE_WORKER = String.raw`
import datetime, glob, json, os, re, sys

roots = sys.argv[1:] or ["/home/oppoer/.codex/sessions", "/home/oppoer/.codex/archived_sessions"]
HEAD = 262144   # 256 KiB read from the top of each rollout
TAIL = 65536    # 64 KiB read from the end of each rollout
PROMPT_LIMIT = 200
HEAD_PROMPT_LIMIT = 12
TAIL_PROMPT_LIMIT = 8
PROMPT_TOTAL_LIMIT = 20
INJECT_MARKERS = (
    "<permissions instructions>",
    "<collaboration_mode>",
    "<environment_context>",
    "<recommended_plugins>",
    "<multi_agent_mode>",
    "# AGENTS.md instructions for",
    "<INSTRUCTIONS>",
)
# A payload that is nothing but one wrapper tag (for example
# <external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>)
# is scaffolding too. Kept in sync with isInjectionText() in lib/parser.mjs.
INJECT_TAG = re.compile(r"^<([A-Za-z_][\w.-]*)(\s[^>]*)?>[\s\S]*</\1>\s*$")

def window(path, offset, size):
    with open(path, "rb") as handle:
        if offset is None:
            handle.seek(0, 2)
            start = max(0, handle.tell() - size)
        else:
            start = offset
        handle.seek(start)
        return handle.read(size)

def message_text(payload):
    """Join the input_text/text parts of a user message payload."""
    parts = []
    for item in (payload.get("content") or []):
        if not isinstance(item, dict):
            continue
        value = item.get("input_text")
        if not isinstance(value, str):
            value = item.get("text")
        if isinstance(value, str) and value.strip():
            parts.append(value)
    return " ".join(parts)

def normalize_prompt(text):
    """Collapse whitespace, drop injected scaffolding, cap at PROMPT_LIMIT."""
    text = " ".join(text.split())
    if not text:
        return None
    for marker in INJECT_MARKERS:
        if marker in text:
            return None
    if INJECT_TAG.match(text):
        return None
    if len(text) > PROMPT_LIMIT:
        text = text[: PROMPT_LIMIT - 1] + "\u2026"
    return text

def scan(text):
    """One pass over a raw window: session meta, first user text, user prompts."""
    meta = {}
    first_user = None
    prompts = []
    for line in text.split("\n"):
        if not line.strip():
            continue
        try:
            entry = json.loads(line)
        except Exception:
            continue
        kind = entry.get("type")
        if kind == "session_meta":
            if not meta:
                payload = entry.get("payload") or {}
                meta = {
                    "id": payload.get("session_id") or payload.get("id"),
                    "cwd": payload.get("cwd"),
                    "createdAt": payload.get("timestamp") or entry.get("timestamp"),
                    "originator": payload.get("originator"),
                    "source": payload.get("source"),
                }
            continue
        if kind != "response_item":
            continue
        payload = entry.get("payload") or {}
        if payload.get("type") != "message" or payload.get("role") != "user":
            continue
        raw = message_text(payload).strip()
        if first_user is None and raw:
            first_user = raw[:400]
        prompt = normalize_prompt(raw)
        if prompt and prompt not in prompts:
            prompts.append(prompt)
    return meta, first_user, prompts

def merge_prompts(head_prompts, tail_prompts):
    """Head-window prompts in order, then the most recent tail-window prompts."""
    merged = []
    for prompt in list(head_prompts[:HEAD_PROMPT_LIMIT]) + list(tail_prompts[-TAIL_PROMPT_LIMIT:]):
        if prompt in merged:
            continue
        merged.append(prompt)
        if len(merged) >= PROMPT_TOTAL_LIMIT:
            break
    return merged

files = []
for root in roots:
    if not os.path.isdir(root):
        continue
    for path in sorted(glob.glob(os.path.join(root, "**", "*.jsonl"), recursive=True)):
        try:
            stat = os.stat(path)
        except OSError:
            continue
        head = window(path, 0, HEAD).decode("utf-8", "ignore")
        meta, first_user, head_prompts = scan(head)
        updated = None
        tail = window(path, None, TAIL).decode("utf-8", "ignore")
        for line in reversed([row for row in tail.split("\n") if row.strip()]):
            try:
                entry = json.loads(line)
            except Exception:
                continue
            if entry.get("timestamp"):
                updated = entry["timestamp"]
                break
        tail_prompts = scan(tail)[2]
        files.append({
            "path": path,
            "size": stat.st_size,
            "mtime": int(stat.st_mtime * 1000),
            "id": meta.get("id"),
            "cwd": meta.get("cwd"),
            "createdAt": meta.get("createdAt"),
            "updatedAt": updated or meta.get("createdAt"),
            "originator": meta.get("originator"),
            "source": meta.get("source"),
            "firstUserText": first_user,
            "prompts": merge_prompts(head_prompts, tail_prompts),
        })

index = []
index_path = "/home/oppoer/.codex/session_index.jsonl"
if os.path.isfile(index_path):
    with open(index_path, "r", encoding="utf-8", errors="ignore") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                index.append(json.loads(line))
            except Exception:
                continue

print(json.dumps({
    "hostname": os.uname().nodename,
    "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "files": files,
    "index": index,
}, ensure_ascii=False))
`

function parseArgs(argv) {
  const options = { json: false, quiet: false, strict: false, dryRun: false, timeoutMs: 180000 }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--json') options.json = true
    else if (arg === '--quiet') options.quiet = true
    else if (arg === '--strict') options.strict = true
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--host') options.host = argv[++i]
    else if (arg.startsWith('--host=')) options.host = arg.slice('--host='.length)
    else if (arg === '--out') options.out = argv[++i]
    else if (arg.startsWith('--out=')) options.out = arg.slice('--out='.length)
    else if (arg === '--timeout') options.timeoutMs = Number(argv[++i]) * 1000
    else if (arg.startsWith('--timeout=')) options.timeoutMs = Number(arg.slice('--timeout='.length)) * 1000
    else throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

function localIso(date) {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60000)
  return `${shifted.toISOString().slice(0, 19)}+08:00`
}

function readableName(value) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text || text.includes('\uFFFD')) return null
  let meaningful = 0
  for (const char of text) if (/[\p{L}\p{N}]/u.test(char)) meaningful += 1
  return meaningful > 0 ? text : null
}

function runWorker({ host, roots, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', host, 'python3', '-', ...roots]
    const child = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    const stdout = []
    const stderr = []
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(new Error(`ssh timed out after ${Math.round(timeoutMs / 1000)}s`))
    }, timeoutMs)
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const out = Buffer.concat(stdout).toString('utf8')
      const err = Buffer.concat(stderr).toString('utf8').trim()
      if (code !== 0) return reject(new Error(`ssh ${host} exited ${code}${err ? `: ${err.slice(0, 400)}` : ''}`))
      try {
        resolve(JSON.parse(out))
      } catch (error) {
        reject(new Error(`cannot parse remote worker output: ${error.message}`))
      }
    })
    child.stdin.on('error', () => {})
    child.stdin.end(REMOTE_WORKER)
  })
}

function buildFragment(payload, host) {
  const names = new Map()
  for (const row of payload.index ?? []) {
    const id = row?.id ?? row?.session_id
    const name = readableName(row?.thread_name ?? row?.title)
    if (typeof id === 'string' && name) names.set(id, name)
  }
  const byId = new Map()
  for (const file of payload.files ?? []) {
    if (typeof file.id !== 'string' || !file.id) continue
    if (typeof file.path !== 'string' || !file.path.startsWith('/')) continue
    const previous = byId.get(file.id)
    const archived = file.path.includes('/archived_sessions/')
    const better =
      !previous ||
      file.size > previous.sizeBytes ||
      (file.size === previous.sizeBytes && previous.archived && !archived)
    if (!better) continue
    const prompts = Array.isArray(file.prompts)
      ? file.prompts.filter((prompt) => typeof prompt === 'string' && prompt.length > 0).slice(0, 20)
      : []
    byId.set(file.id, {
      id: file.id,
      title: names.get(file.id) ?? titleFromText(file.firstUserText) ?? file.id,
      cwd: file.cwd ?? null,
      createdAt: file.createdAt ?? null,
      updatedAt: file.updatedAt ?? file.createdAt ?? null,
      originator: file.originator ?? null,
      model: null,
      sizeBytes: file.size ?? null,
      file: file.path,
      host,
      remote: true,
      sourceRoot: host,
      archived,
      prompts,
    })
  }
  const sessions = [...byId.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
  const bytes = (payload.files ?? []).reduce((sum, file) => sum + (file.size ?? 0), 0)
  return {
    version: 1,
    host,
    remoteHostName: payload.hostname ?? null,
    generatedAt: localIso(new Date()),
    files: (payload.files ?? []).length,
    bytes,
    sessions,
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const host = options.host ?? process.env.CODEX_REMOTE_HOST ?? 'rag_research'
  const roots = (process.env.CODEX_REMOTE_ROOTS ?? DEFAULT_ROOTS.join(':')).split(':').filter(Boolean)
  // Default: the data directory the hub reads (lib/paths.mjs remoteDir()), so the
  // scheduled task and the panel always agree on where the fragment lives.
  const { remoteDir } = await import('../lib/paths.mjs')
  const outFile = options.out ? path.resolve(PKG_ROOT, options.out) : path.join(remoteDir(), `remote-${host}.json`)

  const started = Date.now()
  const report = (message) => {
    if (!options.quiet && !options.json) process.stdout.write(`${message}\n`)
  }

  let payload
  try {
    payload = await runWorker({ host, roots, timeoutMs: options.timeoutMs })
  } catch (error) {
    const kept = await fs
      .readFile(outFile, 'utf8')
      .then((text) => JSON.parse(text))
      .catch(() => null)
    const result = {
      host,
      ok: false,
      error: error.message,
      keptPrevious: Boolean(kept),
      sessions: kept?.sessions?.length ?? 0,
      generatedAt: kept?.generatedAt ?? null,
    }
    if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`)
    else process.stdout.write(`remote sync skipped (${host}): ${error.message}${kept ? `; kept previous fragment (${kept.sessions?.length ?? 0} sessions, ${kept.generatedAt})` : '; no previous fragment'}\n`)
    process.exitCode = options.strict ? 1 : 0
    return
  }

  const fragment = buildFragment(payload, host)
  const durationMs = Date.now() - started
  fragment.durationMs = durationMs

  if (fragment.sessions.length === 0) {
    report(`remote sync: ${host} listed ${fragment.files} files but no session metadata was readable`)
    process.exitCode = 3
    return
  }

  if (options.dryRun) {
    report(`remote sync (dry run): ${host} → ${fragment.sessions.length} sessions from ${fragment.files} files / ${fragment.bytes} bytes in ${durationMs}ms`)
    if (options.json) process.stdout.write(`${JSON.stringify({ ...fragment, dryRun: true })}\n`)
    return
  }

  await fs.mkdir(path.dirname(outFile), { recursive: true })
  const temporary = `${outFile}.tmp`
  await fs.writeFile(temporary, `${JSON.stringify(fragment, null, 2)}\n`, 'utf8')
  await fs.rename(temporary, outFile)

  report(
    `remote sync: ${host} → ${fragment.sessions.length} sessions from ${fragment.files} files / ${fragment.bytes} bytes in ${durationMs}ms → ${path.relative(PKG_ROOT, outFile)}`,
  )
  if (options.json) process.stdout.write(`${JSON.stringify(fragment)}\n`)
}

main().catch((error) => {
  process.stderr.write(`remote sync failed: ${error?.stack ?? error}\n`)
  process.exitCode = 1
})