# dsh-agent-context-hub · 上下文中枢

把本机**所有 AI agent 的会话历史**合并成一份只读索引塞进 DSH，再给这些 agent 一块都能读写的上下文板。换 agent（Codex → Claude Code → DSH）时上下文不再断层，同一时刻所有 agent 看的是同一份「谁在哪个项目上做过什么、当时怎么定的」。

- 包名：`dsh-agent-context-hub`，DSH bundle + 客户端面板，面板名「上下文中枢」
- 索引版本：`INDEX_VERSION = 5`
- 数据目录：默认 `~/.dsh/agent-context`（`DSH_AGENT_CONTEXT_HOME` 可覆盖）
- 磁盘契约与 HTTP 契约见 [CONTRACT.md](CONTRACT.md)，给 agent 用的技能见 [SKILL.md](SKILL.md)

## 它解决什么

| 问题 | 现在的样子 |
| --- | --- |
| 这个方案上次在 Codex 里定过什么？ | 打开面板按项目或关键词搜，直接看当时那段对话 |
| 三个 agent 轮流改同一个仓库，历史散在三个目录 | 索引按 `cwd` 归并，同一项目下的 Codex / Claude / DSH 会话排在同一个分组里 |
| 远程机器 `rag_research` 上的 Codex 会话在本机看不见 | 元数据先进索引，点开正文时再用 `ssh ... cat` 现取 |
| 结论只留在聊天里，下一个 agent 只能猜 | 写一条 `decision` / `handoff` 到共享板，任何 agent 都能读到 |
| 新会话要人肉翻译上一轮结论 | `digest` 把共享板压成一段 Markdown，直接贴进新会话 |

## 三个能力

| 能力 | 入口 | 说明 |
| --- | --- | --- |
| **跨 agent 会话索引** | 面板「会话」标签页 / `GET list` / `cli list` | 只读；按项目分组，每行带来源 agent 徽标与时间；搜索命中标题、项目、首条人类提问、会话 ID；远程会话打开时才读正文 |
| **共享上下文板** | 面板「共享上下文」标签页 / `GET|POST shared` / `cli context`、`cli share`、`cli digest` | 只追加的 `shared.jsonl`，四种条目 `decision` / `handoff` / `task` / `note`，可带 `tags` 与 `refs`，所有人可读 |
| **可编程接口** | CLI + HTTP + `SKILL.md` | 让 agent 自己去查别的 agent 的旧活、把结论写回共享板，不需要用户转述 |

三个能力共用一份数据：索引决定「有哪些会话、属于哪个项目」，共享板决定「哪些结论要跨 agent 传」，CLI / HTTP 是同一份数据的两个出口（面板走 HTTP）。

## 安装

插件以 DSH bundle 形式安装。三种方式按环境选一种。

前提：**Node ≥ 22.15**（`dsh` 适配器用 `zlib.zstdDecompressSync` 逐帧解开 DSH 的多帧 zstd 会话；Node 20 上该来源会被跳过并在 `warnings` 里说明，其它来源照常）。

### A. 有 `dsh` 启动器（推荐）

```powershell
dsh plugin add "D:\Users\80407921\Documents\Codex\2026-09-29\new-chat\agent-context-hub"
```

市场发布后（见 [docs/MARKET.md](docs/MARKET.md)）也可以直接按仓库地址装（npm 发布是可选的）：

```powershell
dsh plugin add github:<owner>/dsh-agent-context-hub
```

### B. 没有 `dsh` 启动器（本机当前状态）

本机 Web 版的 `dsh` 不在 PATH 上，走 DSH 自带的插件管理器：在 DSH 会话里说「安装本地插件 `D:\Users\80407921\Documents\Codex\2026-09-29\new-chat\agent-context-hub`」，agent 会调用 `plugin_manager` 安装；也可以手动改 profile 的 `package.json`（**只列出相关字段，合并进现有文件，不要整体覆盖**）：

```json
{
  "dependencies": {
    "dsh-agent-context-hub": "link:D:/Users/80407921/Documents/Codex/2026-09-29/new-chat/agent-context-hub"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-agent-context-hub"]
    }
  }
}
```

改完保存并刷新 DSH 页面。profile 目录一般是 `~/.dsh/profiles/<profile>/`（本机为 `~/.dsh/profiles/desktop/`）。

### 装完的三步验证

1. **刷新页面**（F5）。`client.js` 由 host 在页面加载时注入，装完不刷新就看不到侧栏图标——这是最常见的一次性「装失败」假象。
2. 确认 host 活着：

   ```powershell
   curl.exe -s http://127.0.0.1:56842/agent-context/api/ping
   ```

   返回 `{"ok":true,"at":"2026-10-30T08:53:02.917Z","name":"agent-context-hub"}` 即正常。
3. 触发第一次扫描并确认分会话数（本机实测 250 个会话、4.7 秒左右）：

   ```powershell
   node lib/cli.mjs scan
   ```

## 数据在哪里

| 路径（默认 `~/.dsh/agent-context`） | 内容 | 能删吗 |
| --- | --- | --- |
| `index.json` | 合并后的索引快照 | 能，重扫即重建 |
| `remote/remote-<host>.json` | SSH 远程会话的元数据片段 | 能，下次 `sync-remote.mjs` 重建 |
| `shared.jsonl` | 共享上下文，一行一条 | **不能**，这是唯一不可重建的数据 |
| `inbox/*.jsonl` | 通用接入（任意 agent 追加） | 能，但等于丢掉那些 agent 的历史 |
| `sources.json` | 额外登记的 glob 数据源 | 能，等于注销那些来源 |
| `sync.log` | 定时任务日志（按大小轮转） | 能 |

换目录：

```powershell
$env:DSH_AGENT_CONTEXT_HOME = "D:\agent-context"
node lib/cli.mjs paths
```

`paths` 会打印实际生效的六个位置：

```
dataHome    D:\Users\80407921\.dsh\agent-context
indexPath   D:\Users\80407921\.dsh\agent-context\index.json
remoteDir   D:\Users\80407921\.dsh\agent-context\remote
sharedFile  D:\Users\80407921\.dsh\agent-context\shared.jsonl
inboxDir    D:\Users\80407921\.dsh\agent-context\inbox
sourcesFile D:\Users\80407921\.dsh\agent-context\sources.json
```

## 用起来

### 面板

侧栏进入「上下文中枢」，两个标签页：

- **会话**：左列 330px 按项目分组的会话列表，行首是来源 agent 徽标（`Codex` / `Claude` / `DSH` / `接入`），搜索框同时匹配标题、项目、首条提问和会话 ID；右侧正文按消息分段，工具输出折叠。
- **共享上下文**：按类型与 agent 过滤、按关键词搜索，右上「＋ 写入」记录一条决策或交接。

远程会话行会标出 SSH host，**点开时才取正文**（提示「正在从 `<host>` 读取会话…（首次打开约 1~3 秒）」）。索引里只有元数据，所以列表刷新不依赖远程机器的连通性。

### CLI

```powershell
node lib/cli.mjs scan          # 全量重扫并写 index.json
node lib/cli.mjs list --limit 5   # 列出最近的会话
node lib/cli.mjs show --id dsh:7f8730e6-82cd-4f06-b046-0e03bd037ec1
node lib/cli.mjs stats
node lib/cli.mjs share --title "索引改为按内容摘要" --body "..." --kind decision --tags index,search
node lib/cli.mjs context --q 索引 --limit 10
node lib/cli.mjs digest --limit 5
node lib/cli.mjs paths
```

不传子命令时等价于 `list`。退出码：`0` 成功，`1` 失败，`3` 没有任何结果（空搜索也算正常结束，方便脚本判断）。

真实输出（本机 2026-10-30 16:52 摘录）：

```
$ node lib/cli.mjs scan
Codex       197 会话 · 193 文件 · 1505 ms
Claude Code 未启用（本机没有数据）
DSH         53 会话 · 53 文件 · 3221 ms
通用接入        未启用（本机没有数据）
合计 250 会话 / 62 项目 / 2244 MB · 远程 112 · 可搜索 240 会话（540 条摘要） · 4730 ms
! [Codex] session_index 列出 114 个会话，其中 29 个没有本地或远程 rollout 文件（只有索引记录，正文不可读）
索引已写入 D:\Users\80407921\.dsh\agent-context\index.json
```

```
$ node lib/cli.mjs list --limit 2
[dsh        ] 2026-10-30 16:50  new-chat
    将codex中所有的会话都复制到 t
    id=dsh:ca46840b-dc63-4011-8483-2a9d059986ff
[dsh        ] 2026-10-30 16:50  new-chat
    You are writing documentation for
    id=dsh:7f8730e6-82cd-4f06-b046-0e03bd037ec1

共 250 条，显示 2 条
```

每行格式是 `[agent] 时间  项目` ＋ 缩进的标题 ＋ `id=agent:会话id`（会话正文 id 一律带 agent 前缀，跨 agent 的同名 id 不会串）。带 `--q` 时还会多一行 `↳ 片段` 显示命中位置。

```
$ node lib/cli.mjs show --id dsh:7f8730e6-82cd-4f06-b046-0e03bd037ec1 --max-messages 3
# You are writing documentation for
agent=dsh id=7f8730e6-82cd-4f06-b046-0e03bd037ec1 cwd=D:\Users\80407921\Documents\Codex\2026-09-29\new-chat

--- user 2026-10-30T16:46:40+08:00
You are writing documentation for a DSH (DeepSeek Harness) plugin. …
```

`show` 默认最多 200 条消息（`--max-messages` 可调），被截断时末尾会标「（已截断）」；远程会话额外打印 `remote=ssh:<host>`。

```
$ node lib/cli.mjs stats
索引 2026-10-30T16:52:49+08:00 · version 5
  Codex       197 会话 / 193 文件 / 1923 ms
  Claude Code 未启用
  DSH         53 会话 / 53 文件 / 3528 ms
  通用接入        未启用

会话 250 · 项目 62 · 文件 246 · 重复 108 · 字节 2353373981 · 可搜索 240/250 · 耗时 5456 ms
! [Codex] session_index 列出 114 个会话，其中 29 个没有本地或远程 rollout 文件（只有索引记录，正文不可读）
```

```
$ node lib/cli.mjs context --limit 3
[decision] 2026-10-30T16:40:45+08:00 dsh  上下文中枢插件开工
    把 codex-sessions 泛化成多 agent 上下文中枢：Codex/Claude Code/DSH 适配器 + 共享上下文。
    tags: plugin,context

共 1 条（总库 1 条）
```

```
$ node lib/cli.mjs share --title "索引改为按内容摘要" --body "detail=... 的理由" --kind decision --tags index,search
已写入共享上下文：decision · 索引改为按内容摘要
id=<uuid> at=<iso8601>
```

```
$ node lib/cli.mjs digest --limit 2
- **decision** 上下文中枢插件开工 — dsh · 2026-10-30T16:40:45+08:00 _plugin,context_
  把 codex-sessions 泛化成多 agent 上下文中枢：Codex/Claude Code/DSH 适配器 + 共享上下文。
```

`digest` 的输出就是可以整段贴给模型的 Markdown：每条一行标题，正文最多取前 6 行。

### HTTP

前缀 `/agent-context/api`，本机 Web 端口 56842：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/agent-context/api/ping` | 存活探针 |
| GET | `/agent-context/api/list` | 会话列表（`refresh=1` 强制重扫） |
| GET | `/agent-context/api/sources` | 各数据源的探测状态与统计 |
| GET | `/agent-context/api/stats` | 全局统计、警告、面板注入自检 |
| GET | `/agent-context/api/shared` | 共享上下文列表（`q` / `agent` / `kind` / `cwd` / `limit`） |
| POST | `/agent-context/api/shared` | 写一条共享上下文 |
| GET | `/agent-context/api/digest` | 共享板导出成 Markdown |
| GET | `/agent-context/api/transcript?id=<agent:id>` | 单个会话正文 |
| GET | `/agent-context/api/client.js` | 面板脚本（由 host 注入页面） |
| POST | `/agent-context/api/beacon` | 面板自检埋点（`204`，不落盘） |

```powershell
curl.exe -s "http://127.0.0.1:56842/agent-context/api/shared?limit=1"
```

```json
{"entries":[{"id":"c8b77f84-0725-4ae3-b2d3-3a0dce4f4de2","at":"2026-10-30T16:40:45+08:00","agent":"dsh","kind":"decision","title":"上下文中枢插件开工","body":"把 codex-sessions 泛化成多 agent 上下文中枢：Codex/Claude Code/DSH 适配器 + 共享上下文。","tags":["plugin","context"],"refs":[],"cwd":"D:/Users/80407921/Documents/Codex/2026-09-29/new-chat"}],"total":1,"all":1,"counts":{"decision":1},"agents":{"dsh":1},"badLines":0}
```

写一条：

```powershell
curl.exe -s -X POST "http://127.0.0.1:56842/agent-context/api/shared" `
  -H "content-type: application/json" `
  -d '{"kind":"decision","agent":"dsh","title":"索引改为按内容摘要","body":"因为完整正文太大。","tags":["index"]}'
```

成功返回 `201` 与 `{"entry":{...}}`；`title` 与 `body` 全空返回 `400`，请求体超过 256 KB 返回 `413`。完整字段与错误码见 [CONTRACT.md](CONTRACT.md)。

## 定时同步

本机跑的是一个 Windows 计划任务，每天 09:45 刷新索引：

| 组件 | 作用 |
| --- | --- |
| `scripts/sync.ps1` | 先跑远程元数据扫描，再跑本地全量 `scan`；写 `sync.log`，按 1 MB 轮转 |
| `scripts/sync-remote.mjs` | 只扫远程文件的头尾元数据，经 `ssh` 抓取 → `remote/remote-<host>.json` |
| `scripts/register-task.ps1` | 注册/更新计划任务，默认 `09:45`、交互式登录、错过补跑、30 分钟上限 |

注册（默认任务名 `AgentContextSync`）：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\register-task.ps1
# 想换名字：-TaskName CodexSessionSync
```

查状态与手动跑一次：

```powershell
Get-ScheduledTaskInfo -TaskName AgentContextSync
powershell -ExecutionPolicy Bypass -File .\scripts\sync.ps1
```

`sync.ps1` 退出码：

| 码 | 含义 |
| --- | --- |
| `0` | 索引已更新 |
| `1` | 同步出错（看 `sync.log`） |
| `2` | 找不到 `lib/cli.mjs`，安全空转（打包路径变了） |
| `3` | 一个会话都没读到 |
| `4` | 找不到可用的 node |

**注意**：`register-task.ps1` 有一道保护——同名任务的 action 必须同时匹配 `agent-context-hub` 与 `sync.ps1`，否则 `exit 5` 并保持原任务不动。旧版本留下的 `CodexSessionSync`（指向旧的 `codex-sessions` 包）不会被自动接管，也不再刷新本插件的数据；确认不再需要后注销：

```powershell
Unregister-ScheduledTask -TaskName CodexSessionSync -Confirm:$false
```

## 自测

```bash
node lib/test.mjs            # 52 个用例，约 6 秒
node lib/test.mjs shared     # 只跑名字里带 shared 的用例
node lib/test.mjs --list     # 列出全部用例名
```

用例覆盖四个适配器（codex / claude-code / dsh / inbox）、索引合并与去重、`findSession`、共享板、转录读取、路径覆盖与 CLI 退出码；全部在临时目录里跑，不碰真实数据。

## 隐私与只读

- **源目录只读**：`~/.codex`、`~/.claude`、`~/.dsh/sessions` 只 `stat` + `read`，插件从不写入、不移动、不删除、不加锁。Codex 正在写的 rollout 文件也按「头尾窗口」读取，避免与 `codex.exe` 抢文件。
- **唯一的写入**：`~/.dsh/agent-context/` 下的索引、远程片段、日志，以及 `shared.jsonl` 的**追加**（不重写、不删除、不改既有行）。
- **远程只读**：`ssh <host> cat -- '<绝对路径>'`；元数据扫描只读文件头尾，不执行远端任何写操作。
- **不联网、不埋点**：除你自己配置的 `ssh` 之外没有出网请求；`beacon` 只把面板自检状态留在内存里给 `stats` 看，不落盘、不外发。
- **敏感内容的落点**：`index.json` 会保存每个会话最多 20 条提问摘要（每条约 120 字，元数据片段更短），远程片段最多 20 条 × 200 字。索引文件是本机明文，按普通本地数据处理；不想留就删数据目录。

## 排错

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| 装完侧栏没有「上下文中枢」 | 页面没刷新，`client.js` 尚未注入 | **刷新页面（F5）**；仍无则查 `GET stats` 里的 `client.inBootGraph` |
| 面板一直转圈 / 一直「读取中」 | 首扫还没结束，或 host 未加载 | 等 5~10 秒；`GET ping` 若无响应说明 host 没起来 |
| 某个来源显示「未启用（本机没有数据）」 | 该 agent 没装、没会话，或不在默认路径 | Claude Code 需要 `~/.claude/projects`；也支持 `CLAUDE_CONFIG_DIR` |
| Codex 会话只有索引记录、正文打不开 | `session_index` 有记录但 rollout 文件不存在（旧机器/已清理） | 属预期，`stats.warnings` 会写清多少个 |
| 正文返回 `502` | 远程 `ssh` 失败或超时 | 报错里带 `host` 与 `stale`；先手工 `ssh rag_research cat` 验通 |
| 启动日志出现 `disk index version X != 5` | 磁盘索引是旧版本 | 正常：host 会丢弃旧索引并重扫覆盖 |
| 共享板写入 `413` | 请求体超过 256 KB | 拆成多条，或把长文放 `refs` 指向会话/文件 |
| 搜索不到刚出现的会话 | 索引是 10 分钟内的快照 | 面板或 `GET list?refresh=1` 触发重扫 |
| 改了 `lib/*.mjs` 但不生效 | `index.js` 与 `lib/` 都是进程内 ESM，模块一经 import 就被缓存 | 部分自动生效：host 每次请求比对 `lib/**/*.mjs` 的大小与 mtime，变了就带版本号重新 import `lib/hub.mjs`、`lib/shared.mjs`、`lib/transcript.mjs`；其余模块（`lib/sources/*` 适配器、`lib/parser|indexer|remote.mjs`，以及被 hub/shared 静态 import 的 `lib/paths.mjs`）仍是旧实例，改完必须重载插件（插件管理器停用→启用）——尤其 `lib/paths.mjs` 会让 host 眼里同时存在新旧两份路径函数，别在运行时改它|

## 卸载

1. 从 profile 移除：用插件管理器停用/卸载，或从 `~/.dsh/profiles/<profile>/package.json` 的 `dependencies` 与 `dsh.profile.bundles` 里删掉 `dsh-agent-context-hub`，刷新页面。
2. 可选：删数据目录 `~/.dsh/agent-context`（**`shared.jsonl` 删了就没了**）。
3. 可选：取消计划任务

   ```powershell
   Unregister-ScheduledTask -TaskName AgentContextSync -Confirm:$false
   ```

卸载不会动任何源会话目录；装回去扫一遍就能恢复索引。

## 进一步阅读

- [CONTRACT.md](CONTRACT.md) —— 磁盘与 HTTP 契约（索引字段、共享条目、事件格式、路由与版本守卫）
- [SKILL.md](SKILL.md) —— 给 agent 的技能：怎么查别人的旧活、怎么写共享板、怎么读正文不炸上下文
- [CHANGELOG.md](CHANGELOG.md) —— 版本变更
- [docs/MARKET.md](docs/MARKET.md) —— 上架 DSH 插件市场的清单
- [docs/ADAPTER-CONTRACT.md](docs/ADAPTER-CONTRACT.md)、[docs/FORMAT-DSH.md](docs/FORMAT-DSH.md) —— 写新适配器时的内部约定
