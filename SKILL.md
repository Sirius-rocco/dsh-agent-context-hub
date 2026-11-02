---
name: agent-context-hub
description: >-
  Query and feed the cross-agent context hub: recover another agent's (Codex,
  Claude Code, DSH, Trae, or an inbox source) earlier work from the local session
  index, read one transcript without flooding context, and post a
  decision/handoff to the shared board so the next agent can pick it up. Use
  for cross-agent handoff, "what did we decide last time", searching local
  session history by project or keyword, and exporting the board as Markdown.
---

# 上下文中枢（agent-context-hub）技能

一个索引覆盖本机所有 agent 的会话，一份共享板承载跨 agent 的结论。你的任务是**先查再问**：上下文多半已经在盘上，不要让用户重新解释一遍。

## 0. 先跑这三条

```powershell
node <pkg>/lib/cli.mjs stats          # 索引多新、各 agent 多少会话、有没有 warning
node <pkg>/lib/cli.mjs list --limit 5 # 最近发生过什么
node <pkg>/lib/cli.mjs digest --limit 10   # 共享板上已有的结论
```

`<pkg>` 是本插件目录（本机：`<pkg>`）。DSH 里也可以直接用 HTTP：

```powershell
curl.exe -s http://127.0.0.1:56842/agent-context/api/stats
```

判断索引是否还能用：`stats` 第一行 `索引 <时间> · version 4`，时间超过 10 分钟就先 `node <pkg>/lib/cli.mjs scan`（全量约 3~7 秒）；出现 `disk index version X != 4` 说明索引被重建过，属正常。

## 1. 查另一个 agent 的旧活

**由粗到细，三步**：

```powershell
# ① 关键词：命中标题 / 项目 / 首条提问 / 会话 id
node <pkg>/lib/cli.mjs list --q 索引 --limit 20
# ② 限定 agent：codex | claude-code | dsh | inbox
node <pkg>/lib/cli.mjs list --q handoff --agent codex --limit 20
# ③ 拿到 id 再读正文（见第 3 节）
node <pkg>/lib/cli.mjs show --id codex:<session-id> --max-messages 20
```

`list` 每行是 `[agent] 时间  项目` ＋ 标题 ＋ `id=agent:会话id`；带 `--q` 时多一行 `↳ 片段`，那是**命中位置**，用它判断这条值不值得展开。

- `--local` / `--remote`：只看本地或只看 SSH 远程会话。
- 退出码 `3` = 没有任何结果，不是错误。

想按项目而不是关键词找：

```powershell
node <pkg>/lib/cli.mjs list --limit 200          # 先看项目名
node <pkg>/lib/cli.mjs list --q "new-chat" --limit 50
```

项目名就是 `cwd` 最后一段；同一项目下不同 agent 的会话在同一个分组里，这正是跨 agent 交接的入口。

## 2. 把结论写到共享板

只在**有结论**时写：定了方案、留了坑、交给下一个人。不要写「我开始了」这类流水账。

```powershell
node <pkg>/lib/cli.mjs share `
  --title "索引改为按内容摘要" `
  --body "完整正文太大：索引只存摘要，正文按需读。影响 lib/hub.mjs 的 prompts 上限。下一步：确认 20 条够不够用。证据：dsh:7f8730e6-82cd-4f06-b046-0e03bd037ec1" `
  --kind decision `
  --tags index,search `
  --agent dsh
```

`--tags` 用逗号分隔即可。CLI 的 `share` **不支持** `--refs`；要写结构化引用就改用 HTTP：

```powershell
curl.exe -s -X POST http://127.0.0.1:56842/agent-context/api/shared `
  -H "content-type: application/json" `
  -d '{"kind":"handoff","agent":"dsh","title":"下一步接索引字段校验","body":"...","tags":["index"],"refs":["codex:abc123"]}'
```

面板里的「＋ 写入」走的是同一个 `POST /shared`：CLI、HTTP、面板三条入口写的是同一份 `shared.jsonl`。

规则：

| 项 | 约定 |
| --- | --- |
| `kind` | `decision`（定了什么）/ `handoff`（交给谁做什么）/ `task`（待办）/ `note`（备注） |
| `title` | 一句话结论，≤200 字；`body` 里写理由和影响面 |
| `tags` | 最多 12 个，逗号分隔 |
| `refs` | 指向证据：`agent:会话id`、文件路径、URL；最多 20 条 |
| `cwd` | 传了就只在该项目下可见；不传是全局条目 |
| 不可改 | 追加式写入，写错就再写一条并用 `refs` 指向前一条 |

写完立刻回读确认：

```powershell
node <pkg>/lib/cli.mjs context --kind decision --limit 5
```

## 3. 读正文而不炸上下文

正文可能有几万到几十万字。**永远先估大小，再决定读多少。**

```powershell
# 默认 200 条，可能非常长；先只读最近几轮
node <pkg>/lib/cli.mjs show --id dsh:<id> --max-messages 10
```

顺序建议：

1. `list --q` 的片段 → 判断相关性（几十字）
2. `show --max-messages 10` → 只看开头和最近的结论（几千字）
3. 需要细节再 `--max-messages 50`，或换 `--json` 自己挑字段

其他要点：

- 被截断时输出末尾有「（已截断）」，`--json` 里是 `truncated: true`。
- 远程会话（`remote=ssh:<host>`）首次打开要 1~3 秒，失败是 `502`，报错里带 `host` 与 `stale`；不要反复重试，先确认 SSH 通不通。
- `--json` 输出是完整结构，字段见 `CONTRACT.md` §6；**不要把整个 JSON 塞进上下文**，用 `jq`/`node -e` 先筛。
- 工具调用与工具输出默认截断到 4000 字，这是有意的：正文里最有价值的通常是人类发言和最终结论。

## 4. 交付给下一个 agent

收尾时把结论压成一段 Markdown 贴进回复或写进共享板：

```powershell
node <pkg>/lib/cli.mjs digest --limit 10
```

`digest` 的输出就是给模型看的：每条一行标题 ＋ 最多 6 行正文，按 `decision → handoff → task → note` 排序。

## 5. 安全与边界

- **只读源**：`~/.codex`、`~/.claude`、`~/.dsh/sessions` 只读，不要建议用户「清理」这些目录来解决问题。
- **只写自己的数据目录**：索引可重建，`shared.jsonl` 只能追加，不要手改或删除既有行。
- **共享板是本机明文**：不要把密钥、token、个人隐私写进 `title`/`body`，需要引用就写 `refs` 指向文件或会话。
- **不要伪造历史**：`list`/`show` 的结果是证据，引用时给出 `agent:会话id`，不要凭印象复述。
- **索引不是实时的**：10 分钟内的快照；用户说「刚刚的会话找不到」时先 `scan` 再查。

## 6. 故障对照

| 现象 | 处理 |
| --- | --- |
| `list` 空 / 退出码 `3` | 先 `scan`；仍空则 `stats` 看该 agent 是否「未启用（本机没有数据）」 |
| 某 agent 未启用 | 该 agent 没装或数据不在默认路径（Claude Code 要 `~/.claude/projects`，可用 `CLAUDE_CONFIG_DIR`；Trae 要 `~/.trae-cn/memory`） |
| Trae 会话只有摘要 | Trae 不把原文落盘，只存每回合 intent/outcome/learned；这是本机能拿到的全部 |
| `show` 报 404 | id 少了 agent 前缀或会话已被删除；用 `list --q` 重新取 id |
| `show` 报 502 | 远程 SSH 读取失败；报错里有 host，先手工 `ssh <host> cat` 验证 |
| `shared` 写入 413 | 单条超过 256 KB；拆条，长文放文件或 `refs` |
| 面板里看不到条目 | 面板是 HTTP 的视图，写完 `context` 能查到就说明写入成功；面板刷新即可 |

## 7. 命令速查

| 命令 | 作用 | 退出码 |
| --- | --- | --- |
| `scan [--deep] [--json] [--quiet]` | 全量重扫，写 `index.json` | 0/1 |
| `list [--q 词] [--agent a] [--limit n] [--local\|--remote] [--json]` | 会话列表 | 0/1/3 |
| `show --id <agent:id> [--max-messages n] [--json]` | 单个会话正文 | 0/1/3 |
| `stats [--json]` | 索引与各来源统计 | 0/1 |
| `share --title … --body … [--kind] [--tags] [--agent] [--cwd]` | 追加一条共享上下文（`refs` 只能走 HTTP / 面板） | 0/1 |
| `context [--q] [--agent] [--kind] [--cwd] [--limit n] [--json]` | 检索共享板 | 0/1/3 |
| `digest [--cwd] [--limit n] [--json]` | 导出共享板 Markdown | 0/1/3 |
| `paths [--json]` | 打印数据目录实际位置 | 0/1 |
