# Codex rollout format, index and API

Reference for the data layer under `lib/`. Everything here was read off real
files in `%USERPROFILE%\.codex\sessions` and
`%USERPROFILE%\Documents\.codex\sessions`; the numbers are the state of
`cache/index.json` generated on 2026-10-20 (after the three-session refresh).
Nothing is guessed.

## 1. Where the data lives

| Root | Role | Contents |
| --- | --- | --- |
| `%USERPROFILE%\.codex\sessions\YYYY\MM\DD\rollout-*.jsonl` | canonical (`CODEX_HOME`) | 75 files / ≈ 880.6 MB |
| `%USERPROFILE%\Documents\.codex\sessions\YYYY\MM\DD\rollout-*.jsonl` | mirror | 158 files / ≈ 1.82 GB |
| `rag_research:/home/oppoer/.codex/sessions` + `/home/oppoer/.codex/archived_sessions` | ssh host, **metadata only** | 119 files / ≈ 1.15 GB / 112 sessions |

Counts below are exact for the 2026-10-20 sample; **byte sizes drift** as live
sessions grow (that is why they are written as “≈”. Re-measure with
`node lib/cli.mjs stats --json`).

Both roots are always scanned (`defaultRoots()`, overridable with
`CODEX_SESSION_ROOTS`). 233 physical files map to **90 logical sessions**:
143 files are duplicates, 29 sessions have more than one file, and one session
(`01a0c1b9-f8c5-7703-8cfe-a3fef03ebfe5`) has 18 files. When a session exists in
both roots the **canonical** copy wins and every other path goes to
`session.duplicateFiles`; 64 of the 90 sessions exist *only* in the mirror, so
neither root can be dropped.

`%USERPROFILE%\.codex\session_index.jsonl` (`{id, thread_name, updated_at}`)
has 168 lines / **102 unique ids** / 0 unparseable. It only supplies titles. It
lists more sessions than exist on disk: 14 of its 102 ids have no rollout file
anywhere, so they are reported in `index.warnings` instead of being faked.
`%USERPROFILE%\.codex\archived_sessions` and
`%USERPROFILE%\.codex\rollout-migrations` **do not exist** (not “empty”), so
no deleted session is hidden there.

Do not trust `File.ReadAllText` / `Get-Content` on a rollout while Codex is
running: the file is open with `FileShare.ReadWrite` and plain readers throw
*“the process cannot access the file because it is being used by another
process”*. The Node `fs` streams used here are fine.

## 2. Rollout JSONL

One JSON object per line; `type` is the envelope:

```
{"timestamp":"2026-10-20T06:00:00.000Z","ordinal":1,"type":"session_meta","payload":{…}}
```

Census over the 90 unique files (177,777 lines, 28 unparseable):

| `type` | Meaning | Count |
| --- | --- | --- |
| `response_item` | model/user/tool content — the only source of transcript text | 82,991 |
| `event_msg` | lifecycle + token accounting | 77,716 |
| `token_usage_record` | usage records | 12,949 |
| `turn_context` | per-turn model/approval settings | 1,793 |
| `inter_agent_communication_metadata` | sub-agent traffic metadata | 1,066 |
| `world_state` | opaque snapshots | 910 |
| `compacted` | compaction record with `replacement_history` | 233 |
| `session_meta` | first line; identifies the session | 91 |
| *unparseable* | genuinely malformed line (whole-file scan) | 28 |

*Unparseable* lines are real: a whole-file scan of the 90 indexed rollouts
(177,777 lines) finds **28** lines that fail `JSON.parse`. The default index scan
only reads a 256 KB head window per file, so it can only report what it saw
inside that window (`stats.badLinesScope == "head"`, currently 0 genuine hits)
and it counts the 214 cut windows separately as `stats.windowTruncations`.
`node lib/cli.mjs stats --deep` (≈17 s) streams every file and reports
`badLinesScope == "full"` with the real 28. Before 2026-10-20 the index reported
those 214 cuts as `badLines` — every file larger than the window contributed one
phantom line while the real 28 stayed invisible.

### `session_meta`

```jsonc
{"session_id":"01a15804-…","id":"…","cwd":"D:\\…","timestamp":"…",
 "originator":"Codex Desktop","cli_version":"…","source":"vscode",
 "thread_source":"user","model_provider":"openai"}
```

`cwd` drives grouping; `session_id` (falling back to `id`) is the session id used
everywhere else.

### `response_item` payloads

Census over the same 90 files:

| `payload.type` | Count | Kept in transcript? |
| --- | --- | --- |
| `reasoning` | 24,760 | no — `encrypted_content` only |
| `custom_tool_call_output` | 19,324 | yes, as `tool/tool_output` |
| `custom_tool_call` | 19,248 | yes, as `tool/tool_call` |
| `message` | 8,433 | yes (roles below) |
| `function_call_output` | 5,089 | yes, as `tool/tool_output` |
| `function_call` | 5,058 | yes, as `tool/tool_call` |
| `agent_message` | 1,066 | yes, as `agent/agent_message` |
| `additional_tools` | 5 | no |
| `tool_search_call` / `tool_search_output` | 3 / 3 | no |
| `web_search_call` | 2 | yes, as `tool/tool_call` named `web_search` |

Message roles: `assistant` 5,451 · `user` 1,830 · `developer` 1,152.

```jsonc
// text turn
{"type":"message","id":"…","role":"user"|"assistant"|"developer",
 "content":[{"type":"input_text"|"output_text","text":"…"}]}

// sub-agent traffic; the readable body follows the last "Payload:" line,
// encrypted-only messages are dropped
{"type":"agent_message","id":"…","author":"/root/reviewer","recipient":"/root",
 "content":[{"type":"input_text","text":"Message Type: FINAL_ANSWER\n…\nPayload:\n…"},
            {"type":"encrypted_content","encrypted_content":"…"}]}

// tool traffic
{"type":"custom_tool_call","id":"…","call_id":"…","name":"apply_patch","status":"completed","input":"…"}
{"type":"custom_tool_call_output","id":"…","call_id":"…","output":[{"type":"input_text","text":"…"}]}
{"type":"function_call","id":"…","call_id":"…","name":"shell","arguments":"{\"command\":[…]}"}
{"type":"function_call_output","id":"…","call_id":"…","output":"…"}
{"type":"web_search_call","id":"…","status":"completed","action":{"type":"search","query":"…"}}
```

`event_msg` payload types: `item_completed` 45,841 · `token_count` 26,662 ·
`thread_settings_applied` 2,058 · `task_started` 1,592 · `task_complete` 1,508 ·
`turn_aborted` 55.

### Mapping into the transcript

| Source | Transcript entry | Note |
| --- | --- | --- |
| `message` role `user` | `role:"user", kind:"message"` | dropped when it is an injected context block |
| `message` role `assistant` | `role:"assistant", kind:"message"` | |
| `message` role `developer` | — | machine instructions; deliberately not shown (1,152 lines) |
| `agent_message` | `role:"agent", kind:"agent_message", name:author` | body after the last `Payload:` header; empty/encrypted-only dropped |
| `web_search_call` | `role:"tool", kind:"tool_call", name:"web_search"` | text is the query |
| `custom_tool_call` / `function_call` | `role:"tool", kind:"tool_call"` | `exec`/`shell` get the command extracted from the JSON arguments |
| `custom_tool_call_output` / `function_call_output` | `role:"tool", kind:"tool_output"` | |
| `reasoning`, `compacted`, `additional_tools`, `tool_search_*`, `session_meta`, `event_msg` | — | no displayable text |

Tool call/output text is clamped to `TOOL_OUTPUT_LIMIT` (4,000 chars) and
message text to `TEXT_LIMIT` (120,000 chars) before it reaches the UI.

### Injected context that is *not* a real turn

User/developer messages frequently begin with machine-generated blocks. They are
dropped by `isInjectionText()` so they never show up as “user” turns:

`<permissions instructions>`, `<environment_context>`, `<recommended_plugins>`,
`<collaboration_mode>`, `<multi_agent_mode>`.

## 3. `cache/index.json`

Written atomically (temp file + rename) by `lib/indexer.mjs`.

```jsonc
{
  "version": 3,
  "generatedAt": "2026-10-21T11:44:39+08:00",
  "roots": [
    { "path": "D:\\…\\.codex\\sessions", "files": 58, "bytes": 826869201, "exists": true },
    { "path": "D:\\…\\Documents\\.codex\\sessions", "files": 158, "bytes": 1820099148, "exists": true }
  ],
  "hosts": ["rag_research"],
  "stats": { "files": 216, "sessions": 200, "duplicates": 128, "unreadable": 0,
             "badLines": 0, "badLinesScope": "head", "windowTruncations": 199,
             "totalBytes": 2646968349, "groups": 65, "scanMs": 1888,
             "remoteSessions": 112, "remoteFiles": 119, "remoteBytes": 1150943753,
             "remoteShadowsLocal": 0, "withPrompts": 198, "promptTotal": 440 },
  "warnings": ["…"],
  "groups": [
    { "key": "D:\\…", "label": "new-chat", "cwd": "D:\\…", "count": 3,
      "updatedAt": "…", "sessions": [ { /* session */ } ] }
  ]
}
```

`roots[]` entries carry exactly `path`, `files`, `bytes`, `exists`. There is no
`kind` field: `roots[0]` is the canonical root and the per-session `sourceRoot`
(`canonical` \| `mirror`) records which copy won.

`stats` fields: `files` `sessions` `duplicates` `unreadable` `badLines`
`badLinesScope` (`head` \| `full`) `windowTruncations` `totalBytes` `groups`
`scanMs`, plus the remote counters `remoteSessions` `remoteFiles` `remoteBytes`
`remoteShadowsLocal` and the snippet counters `withPrompts` (sessions with at
least one indexed prompt) / `promptTotal` (indexed prompts). `windowTruncations`
counts files whose 256 KB **metadata** window ended mid-line — expected, not an
error.

Session record:

| Field | Notes |
| --- | --- |
| `id` | session UUID |
| `title` | from `session_index.jsonl` / first real user text, `null` if unknown |
| `cwd`, `createdAt`, `updatedAt` | `updatedAt` from the file tail |
| `sourceRoot` | `canonical`, `mirror`, or the ssh host for remote rows |
| `file`, `duplicateFiles[]` | absolute paths; every other physical copy of the same id is listed **once** |
| `originator`, `model`, `sizeBytes` | from `session_meta` / `thread_settings_applied` |
| `messageCount`, `userPromptCount`, `hasToolCalls` | **`null`** — the fast scan deliberately does not parse bodies; the UI must treat `null` as unknown |
| `remote`, `host` | `true` + ssh alias for sessions whose body lives on the server (see §8) |
| `prompts[]` | content snippets for search: real user prompts from a 1 MiB head window plus a 256 KiB tail window, de-duplicated, ≤200 chars each (ellipsis on truncation), ≤40 total; injected scaffolding is filtered out (see §9) |

`Σ session.duplicateFiles.length === stats.duplicates` (128 over the 2026-10-21
sample) and `stats.files - localSessions === stats.duplicates` (216 − 88); the
self-test asserts both over **local** rows only, because remote rows have no
local file. Copies can differ in size (the mirror may hold a continuation segment
of the same id), so sizes are never summed for the “same” session.

`warnings[]` currently reports (a) bad lines under the active scope, (b) the 14
`session_index` ids without a local **or remote** rollout, (c) a remote fragment
older than 48 h, and (d) an unreadable remote fragment.

`ensureIndex()` reuses a cached index younger than 10 minutes (`STALE_MS`,
defined at `index.js:27`; the indexer default is also 10 min);
`scan --out` / `ensureIndex({force:true})` forces a rebuild (~1.9-2.5 s end to
end, including the snippet windows).

The host half only serves an index whose `version` equals the running build's
`INDEX_VERSION`; a file written by an older build (for example by a host process
that still has the previous `lib/` modules cached) is rejected and rebuilt in the
background (`index.js` also cache-busts its `./lib/*.mjs` imports with the file
size+mtime so a plugin reload really loads the new data layer).

## 4. Transcript

`readTranscript(file, { meta, maxMessages })` streams the file and returns:

```jsonc
{ "id": "…", "title": "…", "cwd": "…", "updatedAt": "…", "model": "…",
  "messageCount": 63, "truncated": false,
  "messages": [
    { "role": "user"|"assistant"|"agent"|"tool",
      "kind": "message"|"agent_message"|"tool_call"|"tool_output",
      "text": "…", "ts": "2026-10-20T06:00:05.000Z", "name": "apply_patch" }
  ] }
```

`readTranscript` defaults to `maxMessages = 400`; the HTTP route accepts
`?maxMessages=` (default 400, clamped to 400); the CLI `show` defaults to 200.
`truncated: true` means that cap cut the transcript short. Missing ids,
unreadable files and `badLines` are surfaced as warnings rather than thrown.

## 5. CLI

```
node lib/cli.mjs scan  [--out cache/index.json] [--json] [--quiet] [--deep]
node lib/cli.mjs list  [--q keyword] [--limit 50] [--json] [--local|--remote]
node lib/cli.mjs show  --id <session_id> [--max-messages 200] [--json]
node lib/cli.mjs stats [--json] [--deep]
```

Exit codes: `0` ok · `1` failure/unknown command · `3` no sessions matched
(`scan` with zero sessions, `list` with no hits, `show` with an unknown id).
`--out` resolves against the current directory; relative paths elsewhere in the
CLI resolve against the package root.
Remote rows print as `[ssh:<host>]`; `show` streams them over ssh (§8).
`list --q` matches `title`, `cwd`, `id` **and** the indexed `prompts` snippets, so
a keyword that only appears inside a conversation still finds it; the matching
snippet is printed under the row as `    ↳ <snippet>`. `stats` prints
`withPrompts` / `promptTotal` for the snippet index.

## 6. HTTP API (host plugin `index.js`)

All routes are read-only `GET`s under `/codex-sessions/api`, served by the
Harness `webServer` service. It is a prefix route, so the Harness auth guard does
not cover this path and plain `curl` works:

| Route | Response |
| --- | --- |
| `/codex-sessions/api/ping` | `{ ok: true, at: "<ISO>" }` |
| `/codex-sessions/api/list` | cached index (`stale`/`scanning` flags, `hosts[]`, per-session `prompts[]`); `?refresh=1` forces a synchronous rescan and returns the fresh index (`stale:false`, ~1–2.5 s) |
| `/codex-sessions/api/stats` | `stats` + roots + warnings |
| `/codex-sessions/api/transcript?id=<session_id>[&maxMessages=N]` | transcript (400 `missing id` when absent, 404 when unknown, **502** when a remote read fails) |

A remote transcript adds `{ remote: true, host, fetchMs }`; failures carry the ssh
detail, e.g. `{"error":{"status":502,"message":"ssh rag_research exited 1: cat: /…: No such file or directory"}}`
and a 60 s read budget.

Without `refresh=1`, staleness is judged from the index's own `generatedAt`
(never from when the process loaded it into memory): an index older than
`STALE_MS` is returned immediately with `stale:true` while a background rescan
runs; the next call sees the new result. The client polls once more ~6 s later
when it sees `stale:true`. Warm-up also allows that background rescan, so a host
restart with a day-old index self-heals instead of reporting `stale:false` for
ten minutes (fixed 2026-10-20).

Errors are emitted as `{"error":{"status":…,"message":…}}`. The client builds
URLs as `pathname + search` (`client.js:apiUrl`), so query strings survive — a
regression there used to strip `?id=` (fixed 2026-10-20, covered by
`.verify-ui/mount-live.mjs`).

## 7. Self-test

```
node lib/test.mjs          # all 26 cases (local + remote + snippet windows)
node lib/test.mjs parser   # substring filter
CODEX_REMOTE_TEST_ID=<remote session id> node lib/test.mjs remote   # + 1 live ssh case
```

Depth of the bad-line scan is a CLI flag, not a silent default:

```
node lib/cli.mjs stats --deep   # whole-file bad lines (≈17 s, no cache write)
node lib/cli.mjs scan  --deep   # same, and persists the resulting index
```

Covers the synthetic parser fixtures (including `agent_message` and
`web_search_call`), index invariants on the real roots (unique ids,
`files - localSessions == duplicates`, `Σ duplicateFiles == duplicates`, `roots[]`
shape, canonical preference), the snippet windows (1 MiB metadata window and
256 KiB prompt window are read independently; prompt snippets appear in the
index), remote fragment merging (host fallback, local-wins shadowing, stale
warning, broken fragment, `shellQuote`), real-file reads and the CLI end to end.
Writes only to a temp directory; the live ssh case is opt-in so an offline
machine still passes.

## 8. Remote (ssh) sessions

Bodies of `rag_research` sessions never leave the server. The pipeline is:

1. `node scripts/sync-remote.mjs [--host rag_research] [--timeout 120] [--dry-run] [--quiet]`
   runs `python3` on the host over ssh, walks `/home/oppoer/.codex/sessions` and
   `/home/oppoer/.codex/archived_sessions`, and writes
   `cache/remote-<host>.json` (≈1.2 s warm, up to ≈2.3 s cold, for 119 files /
   1.15 GB — metadata only).
2. `scanSessions()` merges that fragment into `cache/index.json`: remote rows keep
   `remote:true`, `file` = remote path, `sourceRoot`/`host` = the ssh alias, and
   the group set gains whatever `cwd` values they carry. A local rollout with the
   same id always wins; losers are counted in `stats.remoteShadowsLocal`.
3. `lib/remote.mjs` streams a body on demand with
   `ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 <host> cat -- '<path>'`
   into `parser.collectTranscript`, so the same parsing/truncation rules apply
   (measured ≈0.6–0.9 s for a first 4–6 messages). Nothing is cached locally, and
   a failing host yields HTTP 502 with the ssh stderr instead of a 500.

The fragment shape:

```jsonc
{
  "host": "rag_research",
  "generatedAt": "2026-10-20T19:16:29+08:00",
  "files": 119, "bytes": 1150943753, "hostname": "…",
  "sessions": [ { "id": "01a08533-…", "title": "…", "cwd": "/home/oppoer/…",
                  "file": "/home/oppoer/.codex/sessions/2026/09/09/rollout-….jsonl",
                  "updatedAt": "2026-10-16T04:43:45.604Z", "host": "rag_research" } ]
}
```

`scripts/sync.ps1` refreshes the fragment **before** the local scan (one scan
indexes both), logs `remote sync | host=… | exit=… | elapsed=…s`, and treats a
remote failure as a WARN that keeps the previous fragment (`-SkipRemote` skips the
step, `-RemoteHost` / `-RemoteTimeoutSeconds` override the defaults).

## 9. Prompt snippets (content search)

Searching only `title` / `cwd` / `id` misses most questions, so every session row
also carries `prompts[]`:

- Local rows: `parser.readHeadInfo(file, { headBytes: 1 MiB, metaBytes: 256 KiB })`
  scans the first 1 MiB for real user messages, and `parser.readTailPrompts(file,
  { tailBytes: 256 KiB })` reads the last 256 KiB (the same tail read also yields
  `updatedAt`, so no extra I/O). Both runs are bounded, so a full scan stays fast
  (measured 1.9–2.5 s for 216 local files + 119 remote rows). Measured yield: a
  256 KiB head window finds ≈2.6 prompts per session, 1 MiB ≈4.2, hence the two
  windows.
- Remote rows: `scripts/sync-remote.mjs` (worker `HEAD = 262144`, `TAIL = 65536`)
  returns `prompts` directly: ≤12 head + ≤8 tail prompts, ≤20 total, each ≤200
  chars.
- Filters: `parser.isInjectionText()` drops scaffolding messages — permission /
  collaboration / environment / recommended-plugin tags, any message that is a
  single XML element, and the `# AGENTS.md instructions for …` / `<INSTRUCTIONS>`
  blocks. The same checks run inside the remote python worker.
- Merge rules: whitespace collapsed, de-duplicated case-insensitively, first-seen
  order preserved, each entry truncated to 200 chars with `…`, and at most
  `MAX_PROMPTS = 40` entries per session.

Both search paths use the snippets: `list --q` (and `stats`) in `lib/cli.mjs`, and
the panel's filter box (`client.js` builds its haystack from
`title + cwd + id + prompts` and renders up to two matched snippets under the
row). Verified live with `.verify-ui/probe-search.mjs`: a keyword that appears
only inside a conversation returns its session row plus the `↳` snippet.
