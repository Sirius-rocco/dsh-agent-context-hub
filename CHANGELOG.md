# Changelog

本文件记录 `dsh-agent-context-hub` 的变更。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## 未发布

### Added — 上架工具链

- `scripts/github-setup.mjs`：一条命令把 GitHub 侧做完——建仓库 → 改写 `package.json` 的三个 URL 并提交 → `git push` → 加 topic → fork 市场仓库 → 写 `data/plugins/<owner>__dsh-agent-context-hub.yml` → 开 PR。token 只从 `~/.dsh/gh-token.txt` 读，不打印、不写入 git config；`api.github.com` 直连被拦时自动起 `ssh -N -D <port>` 隧道。
- `scripts/publish.mjs`：本地准备（URL、entry、分支名、可选 `--push`），不需要 token。
- `scripts/verify-pack.mjs`：回答「别人装得上吗」——`npm pack --dry-run` 的 `files` 白名单是否含全部运行时模块与适配器、仓库是否夹带 cache，以及 `git clone` 出来的副本能否通过自己的测试并扫描本机。配套的 `scripts/verify-api.mjs` 逐条打活体的 HTTP 路由（19 项，默认 `--no-write` 不往共享板写东西）。

### Fixed

- `index.js` 的模块缓存护栏现在覆盖 `lib/` 下的**全部**模块（原先只给四个根模块加 `?v=`，`lib/hub.mjs` 再 import 的同名模块会命中旧缓存）。
- `INDEX_VERSION` 提到 5：`extra.sessionId` 进入索引后，旧版本索引会被判为不兼容并重建。
- `shared.jsonl` 里含 `/` 的 inbox source id 能正确解析；`shared` 的 `kind` 会去空白。

## 1.0.0 - 2026-10-30

首个公开版本：把本机所有 AI agent 的会话历史合成一份索引，并给所有 agent 一块共用的上下文板。

### Added — 三项核心能力

- **统一会话索引**：扫描 Codex、Claude Code、DSH 自身的会话文件，按 `cwd` 合并成同一项目下的会话分组，同一会话的重复副本按大小去重（保留最大的一份并记 `duplicateFiles`）。索引写入 `~/.dsh/agent-context/index.json`，`INDEX_VERSION = 4`，原子写（临时文件 + rename）。
- **共享上下文板**：`shared.jsonl` 只追加写入，条目类型 `decision` / `handoff` / `task` / `note`，支持 `title`、`body`、`tags`、`refs`、`cwd`；可导出为按类型排序的 Markdown 摘要（`digest`），直接贴进模型上下文。
- **跨 agent 检索与交接**：面板（侧边栏图标 + 主面板）按项目分组、带 per-agent 徽标，搜索同时命中会话标题与首条用户提问；同一套能力通过 CLI（`scan` / `list` / `show` / `stats` / `share` / `context` / `digest` / `paths`）和 HTTP（`/agent-context/api/*`）暴露给任何 agent。

### Added — 来源适配器（`lib/sources/`）

| 适配器 | 读取内容 | 说明 |
| --- | --- | --- |
| `codex` | `~/.codex/sessions`、`~/Documents/.codex/sessions` 下的 rollout JSONL，以及 `rag_research` 上的 SSH 远程会话 | 远程会话按需读取正文，元数据由 `scripts/sync-remote.mjs` 定期刷新 |
| `claude-code` | `~/.claude/projects/<slug>/<uuid>.jsonl`（或 `CLAUDE_CONFIG_DIR` 指定的目录） | 跳过 `system-reminder` 等注入文本，`tool_result` 不算用户提问 |
| `dsh` | `~/.dsh/sessions/<workspace>/<session>/session.v4.jsonl.zstd` | 逐帧解开多帧 zstd；只有 `source.kind = user` 的事件算人类提问；需要 Node ≥ 22.15 |
| `inbox` | `~/.dsh/agent-context/inbox/*.jsonl`，以及 `sources.json` 里登记的额外 glob | 任何 agent 追加一行 JSONL 即可接入，`role` 只允许 `user` / `assistant` / `tool` / `note` |

### Added — 运维

- `scripts/sync.ps1`：一次性执行远程元数据刷新 + 全量重扫，写 `index.json` 与 `sync.log`（带日志轮转），退出码 `0` 正常 / `1` 出错 / `2` CLI 缺失（安全跳过）/ `3` 没有会话 / `4` 找不到 node。
- `scripts/register-task.ps1`：注册 Windows 计划任务，默认每天 09:45 触发、登录后延迟 2 分钟执行。
- `scripts/sync-remote.mjs`：只取远程会话元数据（每个文件头尾若干字节），SSH 失败时保留上一次结果而不是清空。
- `docs/ADAPTER-CONTRACT.md`、`docs/FORMAT-DSH.md`：适配器接口与 DSH 会话文件格式说明。

### Fixed — 发布前修掉的真实缺陷

- `lib/sources/claude-code.mjs`：会话行没有带上 `agent`，导致 Claude Code 会话在面板里归到 `agents.undefined`、`findSession('claude-code:<id>')` 查不到、打开正文抛 `EUNKNOWN_AGENT`。现在与其它适配器一致写入 `agent: meta.id`。
- `lib/sources/inbox.mjs`：来自 `sources.json` glob 来源的会话，`scan` 用来源 id 拼出 `<source>/<session>`，但 `readTranscript` 只认 `entry.agent`，缺 `agent` 的行被全部过滤（正文返回 0 条）。现在缺 `agent` 的行归属于「正在被读取的那个前缀」。
- `lib/shared.mjs`：未知 `kind` 原先静默降级为 `note`（`--kind decision2` 会丢类型），现在直接拒绝：CLI 退出 1，HTTP 返回 `400 未知的 kind：…（可用：decision|handoff|note|task）`。
- `index.js`：`loadLib()` 以前只要加载成功就永久缓存，改了 `lib/` 必须重载插件才生效。现在每次请求比对 `lib/**/*.mjs` 的大小与 mtime，变了就带版本号重新 import `lib/hub.mjs`、`lib/shared.mjs`、`lib/transcript.mjs`；其余模块（`lib/sources/*`、`lib/parser|indexer|remote.mjs`、被 hub/shared 静态 import 的 `lib/paths.mjs`）覆盖不到，改完仍需重载插件。
- `lib/sources/inbox.mjs`：来源 id 本身可以带 `/`（`team/alpha`），会话 id 拼成 `team/alpha/s1` 后，`readTranscript` 按**第一个** `/` 拆前缀，于是本该匹配的行全被过滤，正文静默返回 0 条。现在 `scan` 把 `source` 与未加前缀的 `sessionId` 写进 `extra`，读取时直接用这两项，不再重新拆 id。
- `lib/hub.mjs`：`INDEX_VERSION` 4 → 5。索引行新增了 `extra.sessionId`（来源 id 带 `/` 时定位正文要用），旧索引没有这个字段，版本号不升就区分不出来；升级后 host 会丢弃旧索引并自动重扫一次。
- `lib/shared.mjs`：`kind` 校验只做了小写化没做 trim，`--kind " task "` 会被拒，而读取路径却按 trim 后的值比较。现在两端口径一致。
- `lib/hub.mjs`：适配器上报的字节数形状不同，DSH 来源曾显示 `bytes: 0`；现在兼容 `totalBytes` / `bytes` / `compressedBytes`。

### 测试

`node lib/test.mjs` → **52 个用例，52 passed / 0 failed**，约 6 秒；三个已知问题探针在修复后转为硬断言（glob 来源正文、来源 id 带 `/`、kind trim）。

### 说明

- 全部来源目录只读；插件只写自己的数据目录（默认 `~/.dsh/agent-context`，可用 `DSH_AGENT_CONTEXT_HOME` 覆盖）。
- 索引版本不匹配时拒绝直接使用旧文件并自动重建，不会把旧结构喂给面板。
- 面板在安装后需要刷新一次页面才会出现。
