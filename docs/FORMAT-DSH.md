# DSH 会话格式（逆向笔记）

在 Windows / DSH 2026-10 版本上实测得出，来源是本机 `~/.dsh/sessions` 全量 51 个会话。
只记录结构与字段，不记录真实内容。

## 目录布局

```
~/.dsh/sessions/<workspace-encoded>/<session-dir>/session.v4.jsonl.zstd
```

- `<workspace-encoded>`：形如 `--D-Users-alice-Documents-demo--`，`--` 包裹、`-` 代替路径分隔符。
  **有损**：`2026-09-29` 里的 `-` 与分隔符同形，反向还原必然出错，只能当最后兜底。
- `<session-dir>`：两种写法并存，`session-<uuid>` 与纯 `<uuid>`；id 以正文 header 为准。
- 正文文件名实测只有 `session.v4.jsonl.zstd`；目录里的 `*.json` 是旁路产物。未压缩的
  `session*.jsonl` 没出现过，但适配器同时认 zstd 与 jsonl（按扩展名 + 魔数 `28 B5 2F FD`）。
- 旁证：`~/.dsh/storages/session_projcache/sessions/<id>.json`（version 7 投影缓存，非公开 API）
  含 `record.identity.{cwd,createdAt}`、`rows.title.val`、`rows.modelSelection.val.lastUsed.model`，只在正文读不出来时当兜底元数据。

## 压缩：多帧 zstd 拼接（最大的坑）

一份文件是**几百到几千个独立 zstd 帧首尾相接**（单个会话见过 3973 帧）。每帧解出来是
若干行 JSON。`zlib.zstdDecompressSync(buf)` 只返回**第一帧**——一份 277KB 的会话只得到
312 字节、1 条 header，`JSON.parse` 之后看起来「格式正常」，实际正文全丢。

正确解帧方式（无第三方依赖）：

```js
const { buffer, engine } = zlib.zstdDecompressSync(buf.subarray(offset), { info: true })
chunks.push(buffer)
offset += engine.bytesWritten // 本次吃掉的“压缩”字节数，用来推进游标
```

- `engine.bytesWritten` 是压缩侧消费量，不要拿 `buffer.length`（那是解压后长度）。
- 不要靠魔数扫描帧边界：`28 B5 2F FD` 会命中压缩数据内部，误判率很高。
- 尾部被截断时 `zstdDecompressSync` 抛错：保留已解出的帧，报一条 warning，**不要整份丢弃**。
- 实测成本：51 个会话共 33MB 压缩 / 115MB 解压，同步解压约 1.2~1.6s、解析约 0.6s，
  总 `scan` 2s 左右；单文件最大 5.6MB→17MB。zstd 没有随机读，所以整份解压 + 逐文件释放
  是可行方案（并发 4）。

## 记录结构

每行一个对象，绝大多数是 `{ "type", "seq", "time", "data" }`，`time` 是毫秒时间戳。
**唯一例外是首行 header，字段直接平铺、没有 `time`/`seq`/`data`**：

```json
{"type":"session","version":4,"id":"session-<uuid>","createdAt":1767000000000,
 "cwd":"D:\\work\\demo","isSeeded":false,"delegationDepth":0,"agentPreset":"cordis"}
```

关键类型与正文位置：

| 记录 | 有用的字段 |
| --- | --- |
| `user/message` | `data.content[]`，part 为 `{type:'text',text}` / `{type:'image'}`；`data.source.kind` 决定归属 |
| `assistant/message` | `data.message.content[]`：`text` / `reasoning` / `tool-call{id,name,arguments}` |
| `tool/result` | `data.message.content[]` + `data.message.isError` + `data.toolCallId` |
| `session/title` | `data.title`、`data.source.kind`（`fallback` / `provider` / `user`） |
| `request/header` | `data.header.config.{provider,model,reasoningEffort}`（首条即会话起始模型） |
| `model/selection` | `data.{provider,model}`，会话中途换模型，最后一条才是当前模型 |
| `compaction/summary` | `data.summary` 是 `[{type:'text',text}]`，压缩检查点，正文要保留 |
| `agent/inbox/spliced` | `data.inserted[].{content,source}`：子代理初始提示词会先出现在这里 |

`tool/call` 独立记录与 `assistant/message` 里的 `tool-call` **重复**，正文只用后者，否则工具调用翻倍。
`step/*`、`turn/*`、`job/*`、`system/message`、`developer/message`、`sandbox/mode` 是运行噪声，跳过。

## 怎么认出「真实用户输入」

看 `user/message.data.source.kind`，只有 `'user'` 是人敲的；其余都是运行时注入，必须过滤：
`runtime-context`、`agent-instructions`、`skill-catalog`、`time-context`、`tool-jobs`、
`user-approval`、`subagent-settled`、`model-selection`、`schedule`、`skill-invocation`、
`compact-checkpoint`。`'agent-message'` 是 agent 间消息（`Team message from <id>:`），
归为 transcript 的 `role:'agent'`，**不进 prompts**。老日志没有 `source` 时按文本前缀兜底
（`<system-reminder>`、`Current runtime context`、`Time sampled while preparing turn` 等）。

## 已知边界

- 磁盘上会话可能被多个 workspace 目录各存一份，按 header id 去重、保留 `updatedAt` 更新的一份。
- `zstdDecompressSync` 需要 Node ≥ 22.15（本机 v24.21.0）；低版本直接报错而不是静默给空。
- 正文单条 120000 字、工具结果 4000 字截断；`readTranscript` 到 400 条即停并标 `truncated`。
