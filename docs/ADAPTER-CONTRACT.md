# 会话源适配器契约（Adapter Contract）

中枢（`agent-context-hub`）本身不认识任何 agent 的私有格式。每个 agent 由一个**适配器模块**接入：
`lib/sources/<id>.mjs`。适配器只做两件事：**扫描历史 → 会话行**，以及**把某一行读成正文 → transcript**。

## 1. 模块必须导出

```js
export const meta = {
  id: 'claude-code',        // 唯一，小写连字符；写进索引每行 session.agent
  label: 'Claude Code',     // 面板徽标与分组显示名
  order: 20,                // 面板里的展示顺序（codex 10、claude-code 20、dsh 30、trae 40、inbox 90）
  remote: false,            // 是否可能来自 SSH 远程（codex 为 true）
}

export function detect(ctx)               // → boolean；数据根是否存在，决定是否显示该来源
export async function scan(ctx)           // → { sessions, warnings?, stats? }
export async function readTranscript(session, ctx)  // → transcript（见 §3）
```

`ctx` 由中枢传入：`{ home, dataDir, concurrency, deep, maxPrompts }`。

## 2. `scan()` 返回的会话行

```js
{
  id: 'uuid 或稳定字符串',        // 同一 agent 内唯一；不同 agent 允许同 id
  title: '短标题',                 // 可省，中枢会用首条 prompts 兜底
  cwd: 'D:\\path\\project' | null,
  file: '绝对路径' | null,         // 正文来源；remote 会话可为 null
  createdAt: '2026-10-30T16:20:21+08:00' | null,
  updatedAt: '...' | null,         // 缺省沿用 createdAt
  model: '...' | null,
  originator: '...' | null,
  sizeBytes: 1234 | null,
  remote: false,
  host: null,
  prompts: ['用户真实提问的短文本', ...],   // ≤ maxPrompts(20) 条，每条建议 ≤200 字；供内容搜索
  extra: { ... } | null,           // 可选，透传到正文页头部
}
```

要求：

- **必须是真实用户输入**。`isMeta`、`<INSTRUCTIONS>`、`# AGENTS.md instructions for`、系统提示、工具回显一律不要进 `prompts`（否则搜索会被噪声淹没）。可复用 `base.mjs` 的 `mergePrompts()`。
- **必须便宜**。只读文件头（`readHeadBytes`）够用时不要全量读；全量读只发生在 `readTranscript`。
- 扫描失败要写 `warnings`（中文，含文件路径），不能让整个扫描抛错。
- 同一 id 的多个副本要自己去重，`duplicateFiles` 放被丢弃的路径。

## 3. `readTranscript()` 返回

与 `codex` 完全同构（`client.js` 只认这一种形状）：

```js
{
  id, title, cwd, model, createdAt, updatedAt,
  messages: [
    { role: 'user'|'assistant'|'tool'|'agent', kind: 'message'|'tool_call'|'tool_output'|'agent_message',
      ts: 'ISO' | null, name: '工具名' | null, text: '正文', truncated: false }
  ],
  messageCount, userPromptCount, hasToolCalls, truncated, badLines, file,
}
```

- `maxMessages`（默认 400）到达即停止并置 `truncated: true`。
- 工具参数/输出要截断（建议 4000 字），长文本 120000 字上限，用 `clampText()`。
- 读不到文件时抛 `Error`，`code` 用 `ENOENT` 之类的稳定值；中枢会翻译成 404/502。

## 4. 注册

在 `lib/sources/index.mjs` 的 `ADAPTERS` 数组里 import 并加入即可。顺序即面板顺序。

## 5. 自测

每个适配器必须提供 `test/fixtures/<id>/` 下的**合成**样本（不含真实隐私），并在 `lib/test.mjs` 里至少覆盖：
`detect()`、`scan()` 出的行数/标题/prompts、`readTranscript()` 的消息角色序列、以及一个畸形行不致命的用例。
