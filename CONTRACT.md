# dsh-agent-context-hub 数据契约

本文件是 `dsh-agent-context-hub` 与外部（其他 agent、脚本、第三方面板）之间的**稳定契约**：磁盘上放什么、HTTP 上收发什么、什么情况算不兼容。

- 索引版本常量：`INDEX_VERSION = 4`（`lib/hub.mjs`）
- 契约状态：`1.0.0` 起冻结；破坏性变更必须提升 `INDEX_VERSION` 并在 [CHANGELOG.md](CHANGELOG.md) 说明
- 一切路径都是本机绝对路径；时间一律是带时区偏移的 ISO 8601（`2026-10-30T16:52:49+08:00`），不是 UTC `Z`

## 1. 磁盘布局

数据根目录（`lib/paths.mjs`）：

| 项 | 值 |
| --- | --- |
| 默认 | `~/.dsh/agent-context` |
| 覆盖变量 | `DSH_AGENT_CONTEXT_HOME`（取 trim 后 `path.resolve`） |

| 文件 | 生成方 | 可重建 | 说明 |
| --- | --- | --- | --- |
| `index.json` | `lib/hub.mjs` `writeIndex()` | 是 | 唯一权威索引，原子写（临时文件 + rename） |
| `remote/remote-<host>.json` | `scripts/sync-remote.mjs` | 是 | SSH 远程元数据片段，`<host>` 默认 `rag_research` |
| `shared.jsonl` | `lib/shared.mjs` `appendShared()` | **否** | 共享上下文，只追加，一行一条 JSON |
| `inbox/*.jsonl` | 外部 agent | 否 | 通用接入事件流，一行一条 JSON |
| `sources.json` | 人 / 外部工具 | 否 | 额外 `inbox` glob 来源登记 |
| `sync.log` | `scripts/sync.ps1` | 是 | 定时任务日志，按 1 MB 轮转、保留尾部 256 KB |

索引文件之外的所有内容都由插件自己创建；插件**从不写** `~/.codex`、`~/.claude`、`~/.dsh/sessions`。

## 2. `index.json`

### 2.1 顶层结构

```json
{
  "version": 4,
  "generatedAt": "2026-10-30T16:52:49+08:00",
  "sources": [],
  "hosts": ["rag_research"],
  "stats": {},
  "warnings": [],
  "groups": []
}
```

| 字段 | 类型 | 必有 | 说明 |
| --- | --- | --- | --- |
| `version` | number | 是 | 索引结构版本，当前恒为 `4`。读取方必须校验（见 §7） |
| `generatedAt` | string | 是 | 本次扫描完成时间，本地时区偏移 |
| `sources` | array | 是 | 每个适配器一条，含探测结果与统计，顺序按 `order` |
| `hosts` | array\<string\> | 是 | 去重排序后的远程 host 列表；无远程时 `[]` |
| `stats` | object | 是 | 全局统计（§2.3） |
| `warnings` | array\<string\> | 是 | 人类可读告警，可直接展示；无告警时 `[]` |
| `groups` | array | 是 | 按项目分组后的会话（§2.4） |

顶层**没有** `sessions` 字段：会话一律挂在 `groups[].sessions[]` 下，避免同一会话出现两次。

### 2.2 `sources[]` —— 每个适配器一条

```json
{
  "id": "codex",
  "label": "Codex",
  "order": 10,
  "detected": true,
  "sessions": 197,
  "files": 193,
  "bytes": 2353373981,
  "ms": 1505,
  "error": null,
  "warnings": 1,
  "stats": {
    "files": 193,
    "sessions": 197,
    "duplicates": 108,
    "unreadable": 0,
    "badLines": 0,
    "badLinesScope": "head",
    "windowTruncations": 176,
    "totalBytes": 2353373981,
    "groups": 59,
    "remoteSessions": 112,
    "remoteFiles": 119,
    "remoteBytes": 1150943753,
    "remoteShadowsLocal": 0,
    "withPrompts": 194,
    "promptTotal": 433,
    "scanMs": 1501,
    "indexVersion": 3,
    "roots": [
      { "path": "D:\\Users\\80407921\\.codex\\sessions", "files": 35, "bytes": 533274833, "exists": true },
      { "path": "D:\\Users\\80407921\\Documents\\.codex\\sessions", "files": 158, "bytes": 1820099148, "exists": true }
    ],
    "hosts": ["rag_research"]
  }
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | `codex` / `claude-code` / `dsh` / `inbox`，也是会话 id 前缀 |
| `label` | string | 展示名，`通用接入` 用于 `inbox` |
| `order` | number | 展示排序：Codex 10、Claude Code 20、DSH 30、inbox 90 |
| `detected` | boolean | 数据源是否存在；`false` 时后面计数为 0，面板显示「未启用」 |
| `sessions` / `files` / `bytes` | number | 会话数 / 文件数 / 原始字节数 |
| `ms` | number | 该适配器扫描耗时 |
| `error` | string \| null | 探测或扫描的致命错误；局部问题进 `warnings` |
| `warnings` | number | 该适配器的告警条数（字符串在顶层 `warnings[]` 里） |
| `stats` | object \| 缺省 | 适配器自定义统计，**字段随适配器不同，不应被通用代码依赖** |

`stats` 里已观测到的适配器私有字段：

- `codex`：`duplicates`、`unreadable`、`badLines`、`badLinesScope`（`head` 表示只扫了头尾窗口）、`windowTruncations`、`remoteSessions`、`remoteFiles`、`remoteBytes`、`remoteShadowsLocal`、`withPrompts`、`promptTotal`、`indexVersion`（内部索引版本，当前 3）、`roots[]`（`path`/`files`/`bytes`/`exists`）、`hosts[]`
- `dsh`：`compressedBytes`、`decompressedBytes`、`frames`、`records`、`badLines`、`duplicates`、`unreadable`、`decompressMs`

### 2.3 `stats` —— 全局统计

```json
{
  "files": 246,
  "sessions": 250,
  "duplicates": 108,
  "unreadable": 0,
  "badLines": 0,
  "badLinesScope": "head",
  "windowTruncations": 176,
  "totalBytes": 2353373981,
  "groups": 62,
  "remoteSessions": 112,
  "remoteFiles": 119,
  "remoteBytes": 1150943753,
  "remoteShadowsLocal": 0,
  "withPrompts": 240,
  "promptTotal": 540,
  "scanMs": 4730,
  "byAgent": {
    "codex": { "sessions": 197, "remote": 112, "withPrompts": 194 },
    "dsh": { "sessions": 53, "remote": 0, "withPrompts": 46 }
  }
}
```

| 字段 | 说明 |
| --- | --- |
| `files` / `sessions` | 去重后的文件数与会话数（重复文件已在合并阶段折叠） |
| `duplicates` | 被折叠掉的重复文件数（同一会话被多个路径命中） |
| `unreadable` | 读失败的文件数 |
| `badLines` | 解析时跳过的坏行数；`badLinesScope` 说明统计范围 |
| `windowTruncations` | 因只读头尾窗口而被截断的文件数 |
| `totalBytes` | 源文件原始字节总和 |
| `groups` | 项目分组数 |
| `remote*` | 远程会话计数、远程文件数、远程字节数；`remoteShadowsLocal` 表示同名会话同时存在于本地与远程 |
| `withPrompts` / `promptTotal` | 有可搜索摘要的会话数 / 摘要总条数 |
| `scanMs` | 总扫描耗时 |
| `byAgent` | **按 agent 的统计**，键是适配器 id；每个值是 `{sessions, remote, withPrompts}` |

`byAgent` 是唯一稳定的「按 agent 汇总」入口；`sources[].stats` 只用于诊断。

### 2.4 `groups[]` —— 项目分组

```json
{
  "key": "d:\\users\\80407921\\documents\\codex\\2026-09-29\\new-chat",
  "label": "new-chat",
  "cwd": "D:\\Users\\80407921\\Documents\\Codex\\2026-09-29\\new-chat",
  "sessions": [],
  "agents": { "dsh": 49 },
  "updatedAt": "2026-10-30T16:52:47+08:00",
  "count": 49
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `key` | string | 分组键：`cwd` 转小写、去掉结尾斜杠；`cwd` 为空时是 `__unknown__` |
| `label` | string | 展示名：`cwd` 最后一段；为空时 `未知项目` |
| `cwd` | string | 该组的原始工作目录（保留大小写） |
| `sessions` | array | 该组会话，按 `updatedAt` 倒序 |
| `agents` | object | `{agentId: 会话数}`，用于徽标与筛选 |
| `updatedAt` | string | 组内最新会话时间 |
| `count` | number | 等于 `sessions.length`，方便列表页只读计数 |

分组跨 agent：同一 `cwd` 下 Codex、Claude Code、DSH 的会话进同一个 group，这正是「按项目看历史」的来源。

### 2.5 `groups[].sessions[]` —— 会话

```json
{
  "id": "ca46840b-dc63-4011-8483-2a9d059986ff",
  "agent": "dsh",
  "title": "将codex中所有的会话都复制到 t",
  "cwd": "D:\\Users\\80407921\\Documents\\Codex\\2026-09-29\\new-chat",
  "file": "D:\\Users\\80407921\\.dsh\\sessions\\--D-Users-80407921-Documents-Codex-2026-09-29-new-chat--\\session-ca46840b-dc63-4011-8483-2a9d059986ff\\session.v4.jsonl.zstd",
  "createdAt": "2026-10-20T16:12:47+08:00",
  "updatedAt": "2026-10-30T16:52:47+08:00",
  "originator": null,
  "model": "deepseek-v4.1-flash",
  "sizeBytes": 6112419,
  "remote": false,
  "host": null,
  "messageCount": 1303,
  "userPromptCount": 26,
  "hasToolCalls": true,
  "duplicateFiles": [],
  "prompts": ["将codex中所有的会话都复制到 trae中 …"],
  "extra": {
    "workspace": "D:\\Users\\80407921\\Documents\\Codex\\2026-09-29\\new-chat",
    "provider": "deepseek",
    "origin": "user",
    "parentSession": null,
    "delegationDepth": 0,
    "agentPreset": null,
    "records": 39466,
    "frames": 21062,
    "compactions": 0,
    "images": 0,
    "badLines": 0
  }
}
```

| 字段 | 类型 | 必有 | 说明 |
| --- | --- | --- | --- |
| `id` | string | 是 | 适配器内的会话 id（UUID 或 rollout 文件名去后缀） |
| `agent` | string | 是 | 适配器 id；**会话的唯一标识是 `agent` + `id`**，对外写作 `agent:id` |
| `title` | string | 是 | 标题：会话自带标题 → 首条人类提问前 80 字 + `…` → `${agent} · ${updatedAt.slice(5,16)}` |
| `cwd` | string \| null | 是 | 会话工作目录；`null` 时进 `__unknown__` 组 |
| `file` | string | 是 | 源文件绝对路径；远程会话是远端路径 |
| `createdAt` / `updatedAt` | string | 是 | 本地时区 ISO 时间；`updatedAt` 决定组内排序 |
| `originator` | string \| null | 是 | 来源标记（如 Codex 的 originator），可为 `null` |
| `model` | string \| null | 是 | 模型名，未知为 `null` |
| `sizeBytes` | number | 是 | 源文件大小；去重时保留较大者 |
| `remote` | boolean | 是 | 是否远程（SSH）会话 |
| `host` | string \| null | 是 | 远程 host；本地为 `null` |
| `messageCount` | number | 是 | 消息条数（扫描时已知的计数，非全量精确值） |
| `userPromptCount` | number | 是 | 人类发言条数 |
| `hasToolCalls` | boolean | 是 | 是否含工具调用 |
| `duplicateFiles` | array\<string\> | 是 | 被折叠掉的同会话其它文件路径 |
| `prompts` | array\<string\> | 是 | 最多 20 条人类提问摘要，用于搜索与列表片段；可能为空数组 |
| `extra` | object | 是 | 适配器私有字段，**通用代码不得依赖具体键**；已知键见上例 |

`extra` 已知字段：

- `dsh`：`workspace`、`provider`、`origin`、`parentSession`、`delegationDepth`、`agentPreset`、`records`、`frames`、`compactions`、`images`、`badLines`
- `codex`（远程）：`sourceRoot`、`archived`
- `inbox`：`agent`（原始 agent 名，用于 `agent/session` 前缀）、`events`（事件条数）

### 2.6 合并与去重规则

1. 每个适配器先 `detect()` 再 `scan()`；`detect() === false` 的适配器跳过，但仍出现在 `sources[]`（`detected: false`）。
2. 去重键是 `${agent}\u0000${id.toLowerCase()}`；命中时保留 `sizeBytes` 较大的一份，另一份路径进 `duplicateFiles`。
3. 组按 `groupKey(cwd)` 合并；`stats.duplicates` 是全局被折叠计数。
4. 写盘是「临时文件 + rename」，读取方永远看到完整的 JSON，不会读到半个文件。

## 3. `remote/remote-<host>.json`（远程元数据片段）

```json
{
  "version": 1,
  "host": "rag_research",
  "remoteHostName": "rag_research",
  "generatedAt": "2026-10-30T09:45:12+08:00",
  "files": 119,
  "bytes": 1150943753,
  "durationMs": 18342,
  "sessions": [
    {
      "id": "rollout-2026-10-28T10-11-02-0199f0c1",
      "title": "整理 handoff 库",
      "cwd": "/home/oppoer/work/handoff",
      "createdAt": "2026-10-28T10:11:02+08:00",
      "updatedAt": "2026-10-28T15:40:11+08:00",
      "originator": "cli",
      "model": "gpt-5-codex",
      "sizeBytes": 8123456,
      "file": "/home/oppoer/.codex/sessions/2026/10/28/rollout-....jsonl",
      "host": "rag_research",
      "sourceRoot": "/home/oppoer/.codex/sessions",
      "archived": false,
      "remote": true,
      "prompts": ["帮我看看 handoff 库里 10 月的记录"]
    }
  ]
}
```

- 只存元数据：每个文件只读头 262144 B、尾 65536 B，最多 20 条摘要 × 200 字。
- `version` 独立于索引版本，当前 `1`。
- `ssh` 失败时**保留上一份片段**并以 `0` 退出（`--strict` 时 `1`）；目录里没有可读会话时退出 `3`。
- 片段按 host 分文件，多 host 并存；索引只合并 `remote/` 下所有 `remote-*.json`。

## 4. `shared.jsonl` 条目

一行一条 JSON，只追加、不重写；读的时候跳过残行（写到一半的行）并计入 `badLines`。

```json
{"id":"c8b77f84-0725-4ae3-b2d3-3a0dce4f4de2","at":"2026-10-30T16:40:45+08:00","agent":"dsh","kind":"decision","title":"上下文中枢插件开工","body":"把 codex-sessions 泛化成多 agent 上下文中枢：Codex/Claude Code/DSH 适配器 + 共享上下文。","tags":["plugin","context"],"refs":[],"cwd":"D:/Users/80407921/Documents/Codex/2026-09-29/new-chat"}
```

| 字段 | 类型 | 必有 | 规则 |
| --- | --- | --- | --- |
| `id` | string | 是 | 写入时生成的 UUID v4 |
| `at` | string | 是 | 写入时间，本地时区 ISO |
| `agent` | string | 是 | 写入方，默认 `unknown`，最长 60 |
| `kind` | string | 是 | `decision` / `handoff` / `task` / `note`；非法值**拒绝**（`400` / CLI 退出 1），不静默降级 |
| `title` | string | 是 | 最长 200 字；为空时取 `body` 第一行 |
| `body` | string | 是 | 最长 20000 字；可为空串 |
| `tags` | array\<string\> | 是 | 最多 12 个，每个最长 40 字；不传为 `[]` |
| `refs` | array\<string\> | 是 | 最多 20 条，每条最长 400 字；建议放 `agent:id`、文件路径、URL |
| `cwd` | string \| null | 是 | 归属项目路径；`null` / 空串表示**全局条目**，任何项目都能看到 |

约束：

- `title` 与 `body` **不能同时为空**，否则写入报错 `标题和正文至少要有一个`。
- 写入用 `appendFileSync`（`O_APPEND`），单行原子；并发写不会互相破坏。
- 半行（进程被杀）在下一次读取时被跳过，不阻塞后续条目。
- 条目**不可修改、不可删除**：改结论就再写一条，用 `refs` 指向前一条。

读取视图（`listShared`）：

```json
{"entries":[],"total":1,"all":1,"counts":{"decision":1},"agents":{"dsh":1},"badLines":0}
```

| 字段 | 说明 |
| --- | --- |
| `entries` | 过滤后的条目，最新在前；`limit` 取 1..500，默认 50 |
| `total` | 过滤后条数 |
| `all` | 全库条数 |
| `counts` | 按 `kind` 计数（只统计过滤后的结果） |
| `agents` | 按 `agent` 计数（同上） |
| `badLines` | 跳过的残行数 |

过滤参数：`q`（在 `title + body + tags + refs + agent + kind` 里子串匹配，不区分大小写）、`agent`、`kind`、`cwd`、`limit`。

摘要视图（`digestShared`）：

```json
{
  "count": 1,
  "markdown": "- **decision** 上下文中枢插件开工 — dsh · 2026-10-30T16:40:45+08:00 _plugin,context_\n  把 codex-sessions 泛化成多 agent 上下文中枢：…",
  "entries": []
}
```

- `limit` 取 1..200，默认 20；类型顺序固定 `decision` → `handoff` → `task` → `note`。
- 无 `cwd` 的全局条目在任何项目下都会出现；带 `cwd` 的只在该项目下出现。
- `markdown` 每条形如 `- **kind** 标题 — agent · 时间 _tags_`，正文最多取前 6 行、整体缩进 2 空格，可直接整段贴进模型上下文。

## 5. `inbox` 事件与 `sources.json`

任何 agent 都能接入：往 `<dataHome>/inbox/*.jsonl` 追加一行，或在 `sources.json` 里登记额外的 glob。

### 5.1 事件行

```json
{"agent":"trae","session":"9f1c2a","cwd":"D:/work/hub","title":"迁移脚本初稿","ts":"2026-10-30T15:02:11+08:00","role":"user","text":"把 codex 的历史也接进来","model":"claude-sonnet"}
```

| 字段 | 类型 | 必有 | 规则 |
| --- | --- | --- | --- |
| `agent` | string | 否 | 来源 agent 名，缺省 `inbox`；它构成对外会话 id 的前缀 |
| `session` | string | 否 | 该 agent 内的会话 id；缺省取 `sessionId`，再缺省取文件名去 `.jsonl`。对外 id 为 `${agent}/${session}`，但索引里的 `agent` 字段仍是 `inbox`（面板徽标显示「接入」） |
| `cwd` | string | 否 | 决定项目分组；缺省进 `__unknown__` |
| `title` | string | 否 | 缺省取首条 `user`/`note` 文本 |
| `ts` | string | 否 | 本地时区 ISO；缺省用文件 mtime |
| `role` | string | 否 | `user` / `assistant` / `tool` / `note`；缺省 `note` |
| `text` | string | 否 | 正文，截断到 4000 字 |
| `model` | string | 否 | 模型名 |

- 只有 `role` 为 `user` 或 `note` 的事件进入可搜索摘要（`prompts`）；`assistant` / `tool` 只计数，不进列表片段。
- 同一 `agent/session` 的多个事件合并成一个会话，`updatedAt` 取最大 `ts`。

### 5.2 `sources.json`

```json
{
  "sources": [
    { "id": "trae", "kind": "inbox", "glob": "D:/trae/exports/*.jsonl" },
    { "id": "zed", "kind": "inbox", "glob": ["D:/zed/chat/*.jsonl", "D:/zed/archive/**/*.jsonl"] }
  ]
}
```

| 字段 | 说明 |
| --- | --- |
| `id` | 来源标识；文件里没写 `agent` 的事件用它当前缀 |
| `kind` | 目前只支持 `inbox`；省略视同 `inbox` |
| `glob` | 字符串或字符串数组；只支持 `*` 与 `**` 两种通配 |

`id` / `kind` / `glob` 之外的多余字段（例如 `label`）不会被读取——面板对所有通用接入来源统一显示「接入」。

坏 glob、缺失 `glob`、未知 `kind` 的来源被忽略并在 `warnings[]` 里记一条，不影响其它来源。

## 6. 会话正文（transcript）

`GET /agent-context/api/transcript?id=<agent:id>` 与 `cli show --id` 返回同一结构：

```json
{
  "id": "7f8730e6-82cd-4f06-b046-0e03bd037ec1",
  "agent": "dsh",
  "title": "You are writing documentation for",
  "cwd": "D:\\Users\\80407921\\Documents\\Codex\\2026-09-29\\new-chat",
  "model": "deepseek-v4.1-flash",
  "createdAt": "2026-10-30T16:46:36+08:00",
  "updatedAt": "2026-10-30T16:46:40+08:00",
  "file": "D:\\Users\\80407921\\.dsh\\sessions\\…\\session.v4.jsonl.zstd",
  "messages": [
    {
      "role": "user",
      "kind": "message",
      "ts": "2026-10-30T16:46:40+08:00",
      "name": null,
      "text": "You are writing documentation for a DSH (DeepSeek Harness) plugin. …",
      "truncated": false
    }
  ],
  "messageCount": 1,
  "userPromptCount": 26,
  "hasToolCalls": true,
  "truncated": true,
  "badLines": 0,
  "stale": false
}
```

### 6.1 响应字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` / `agent` / `title` / `cwd` / `model` | — | 与索引里的会话一致（`id` 不带 agent 前缀） |
| `file` | string | 源文件绝对路径 |
| `messages` | array | 消息数组，按时间正序 |
| `messageCount` | number | **本次响应里**的消息条数（受 `maxMessages` 限制） |
| `userPromptCount` | number | 人类发言条数（全量计数） |
| `hasToolCalls` | boolean | 是否含工具调用 |
| `truncated` | boolean | 是否因 `maxMessages` 丢掉了更早/更多的消息 |
| `badLines` | number | 解析时跳过的坏行 |
| `stale` | boolean | 读取的是否为「正在写入」的文件的较早快照 |
| `remote` / `host` / `fetchMs` | — | 仅远程会话出现：`remote: true`、host 名、本次 SSH 耗时 |

### 6.2 消息对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `role` | `user` \| `assistant` \| `tool` \| `agent` | 说话者；`agent` 用于子代理消息 |
| `kind` | `message` \| `tool_call` \| `tool_output` \| `agent_message` | 消息细分类型 |
| `ts` | string \| null | 本地时区 ISO |
| `name` | string \| null | 工具名（`tool` 角色时） |
| `text` | string | 正文；工具输出截断到 4000 字，普通消息上限 120000 字 |
| `truncated` | boolean | 该条是否被截断 |

正文读取是**只读窗口式**：Claude Code 只读头 262144 B + 尾 262144 B，Codex 远程文件只读头尾，DSH 逐帧解压 zstd；都不会修改源文件。

## 7. HTTP 契约

前缀：`/agent-context/api`（本机 Web 端口 `56842`，见 `GET ping` 实际地址）。

### 7.1 路由表

| 方法 | 路径 | 参数 | 成功响应 | 失败 |
| --- | --- | --- | --- | --- |
| GET | `/ping` | — | `{"ok":true,"at":"<ISO>","name":"agent-context-hub"}` | — |
| GET | `/list` | `refresh=1` | 完整索引 + `stale` + `scanning` | — |
| GET | `/sources` | — | `{"generatedAt":"<ISO>","sources":[…],"byAgent":{…}}` | — |
| GET | `/stats` | — | `{"generatedAt":…,"stats":…,"warnings":[…],"sources":[…],"hosts":[…],"scanning":false,"lastError":null,"client":{…}}` | — |
| GET | `/shared` | `q`,`agent`,`kind`,`cwd`,`limit` | `{"entries":[…],"total":…,"all":…,"counts":{…},"agents":{…},"badLines":0}` | — |
| POST | `/shared` | JSON body | `201 {"entry":{…}}` | `400 标题和正文至少要有一个` / `400 正文不是合法 JSON` / `400 未知的 kind：…（可用：decision|handoff|note|task）`；`413 请求体过大` |
| GET | `/digest` | `cwd`,`limit` | `{"count":…,"markdown":"…","entries":[…]}` | — |
| GET | `/transcript` | `id=<agent:id>` 或裸 id | 见 §6 | `400 missing id`；`404 session not found: <id>`；`502` 远程读取失败 |
| GET | `/client.js` | — | 面板脚本（`text/javascript`，`no-store`） | — |
| POST | `/beacon` | JSON body | `204` 无正文 | — |
| * | 其它 | — | — | `404 {"error":{"status":404,"message":"unknown action: <x>"}}` |

方法限制：除 `POST /shared` 与 `POST /beacon` 外只接受 `GET` / `HEAD`，其它方法返回 `405`（空正文，响应头 `allow: GET, HEAD, POST`）。

### 7.2 示例

存活检查：

```powershell
curl.exe -s http://127.0.0.1:56842/agent-context/api/ping
{"ok":true,"at":"2026-10-30T08:53:02.917Z","name":"agent-context-hub"}
```

`/list` 返回的顶层键固定为：

```
version, generatedAt, sources, hosts, stats, warnings, groups, stale, scanning
```

`stale` 表示索引年龄超过 10 分钟（`STALE_MS`），`scanning` 表示此刻有扫描在跑；`refresh=1` 会同步触发一次扫描再返回。**没有** `limit` 之类的裁剪参数，调用方自己按 `groups[].sessions[]` 过滤。

写共享条目：

```powershell
curl.exe -s -X POST http://127.0.0.1:56842/agent-context/api/shared `
  -H "content-type: application/json" `
  -d '{"kind":"decision","agent":"codex","title":"索引改为按内容摘要","body":"完整正文太大，索引只存摘要，正文按需读。","tags":["index"],"refs":["dsh:7f8730e6-82cd-4f06-b046-0e03bd037ec1"]}'
```

```json
{"entry":{"id":"…","at":"2026-10-30T17:02:11+08:00","agent":"codex","kind":"decision","title":"索引改为按内容摘要","body":"完整正文太大，索引只存摘要，正文按需读。","tags":["index"],"refs":["dsh:7f8730e6-82cd-4f06-b046-0e03bd037ec1"],"cwd":null}}
```

错误形状统一为 `{"error":{"status":<code>,"message":"<text>"}}`：

| 场景 | 状态码 | `message` |
| --- | --- | --- |
| 未知 action | `404` | `unknown action: nope` |
| `transcript` 缺 `id` | `400` | `missing id` |
| `transcript` 找不到会话 | `404` | `session not found` |
| 远程正文读取失败 | `502` | 错误对象里另带 `agent`、`host`、`stale` |
| 共享条目标题与正文全空 | `400` | `标题和正文至少要有一个` |
| 请求体超过 256 KB | `413` | `请求体过大` |
| 请求体不是合法 JSON | `400` | `正文不是合法 JSON` |
| 方法不允许 | `405` | 无正文，响应头带 `allow: GET, HEAD, POST` |

### 7.3 `beacon`（面板自检）

```json
{"stage":"panel-mounted","detail":"tab=sessions"}
```

- 只接受 `POST`，字段超长会被截断（`stage` 60 字、`detail` 200 字）。
- 只保留最近 30 条，存在 host 内存里，通过 `GET /stats` 的 `client.beacons` 暴露；**不写盘、不外发**。
- 用途：装完插件面板没出来时，判断 host 是否注入成功（`client.inBootGraph`、`client.rev`）以及面板是否挂载。

## 8. 版本守卫与不兼容规则

契约里唯一允许「拒绝对待」的东西是索引版本。

1. **磁盘索引必须先过版本检查**。host 读 `index.json` 后只有当 `candidate.version === INDEX_VERSION`（当前 `4`）才直接服务；否则**拒绝使用该文件**，打印

   ```
   disk index version 3 != 4; rebuilding instead of serving it
   ```

   并重新扫描覆盖。因此「旧索引」不会以错误的结构被喂给面板或 API，而是被重建。
2. **不提供降级读取**。没有 `version <= 4 也能读` 的兼容分支；旧版本一律重建。这就是「旧版本索引被拒绝」的字面含义。
3. **请求侧不做版本协商**。HTTP 没有 `version` 参数；调用方拿到什么结构就是当前版本的结构。调用方若要长期存储，应自己记录 `version` 与 `generatedAt`，发现 `version` 变了就重读契约。
4. **适配器内部版本是私有的**。例如 Codex 的 `stats.indexVersion = 3`、远程片段的 `version = 1`，它们不进契约，可能随适配器实现变化。
5. **破坏性变更的流程**：改结构 → 提升 `INDEX_VERSION` → 更新本文件与 [CHANGELOG.md](CHANGELOG.md) → 保证旧索引被重建（而不是被误读）。新增字段可以只做加法，但读取方必须容忍未知字段。

## 9. 只读与幂等承诺

| 对象 | 读写 |
| --- | --- |
| 源会话目录（`~/.codex`、`~/.claude`、`~/.dsh/sessions`、远程 `~/.codex`） | 只读；不写、不改名、不删除、不加锁 |
| `index.json` / `remote/*.json` / `sync.log` | 插件可写，整体替换（原子 rename） |
| `shared.jsonl` | 只追加；不重写、不删除、不修改既有行 |
| `inbox/*.jsonl` | 插件只读；写入方是外部 agent |
| `sources.json` | 插件只读；由人或外部工具维护 |

同一个 `scan` 跑两次，除了 `generatedAt` 与耗时字段外结果一致（顺序稳定：`sources` 按 `order`，`groups` 按其 `updatedAt` 倒序，`sessions` 按 `updatedAt` 倒序）。
