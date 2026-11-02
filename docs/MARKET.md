# 上架 DSH 插件市场

本文是 `dsh-agent-context-hub` 发布到 DSH 插件市场（awesome-dsh-plugin）的操作清单。所有片段都可直接复制，把 `<owner>` 换成你的 GitHub 账号即可。

## 1. 链路

```
你提 PR（只加一个 YAML 文件）
   → awesome-dsh-plugin/awesome-dsh-plugin 的 data/plugins/<owner>__<repo>.yml
   → 维护者合并
   → 仓库 CI 生成 README 与站点数据
   → https://awesome-dsh-plugin.com/plugins.json 出现该条目
   → 站点 https://awesome-dsh-plugin.com/p/<owner>/<repo>/ 可访问
```

要点：

- **贡献物是一个 YAML 文件**，不是 JSON，也不是改 README。README 与 `plugins.json` 都是生成物，PR 里改它们会被拒。
- 仓库里同时放**真实可运行的代码**，市场按仓库根目录的 `cordis.patch.yml` + `package.json` 判定是不是 DSH 插件。
- 收录后站点会在插件旁展示安装命令（GitHub-only 条目是 `dsh plugin --profile web add github:<owner>/<repo>`），**npm 发布是可选的**。

## 2. 类别：`session`

本插件聚合、索引并检索多个 agent 的会话历史，属于「Sessions & Messages / 会话与消息」，所以 `category: session`。

全部合法取值（只能选一个）：

```
agi ui usage theme model identity session memory tools wsl browser vision voice
docs skill workflow git notify dev security remote market fun
```

## 3. 要提交的文件

路径：`data/plugins/<owner>__dsh-agent-context-hub.yml`（文件名是 `<owner>__<repo>`，双下划线）。

本仓库已把这份 YAML 放在 `publish/awesome-dsh-plugin.yml`，把里面的三处 `<owner>` 换成你的 GitHub 账号、文件名改成 `<owner>__dsh-agent-context-hub.yml` 即可提交：

```yaml
url: https://github.com/<owner>/dsh-agent-context-hub
name: <owner>/dsh-agent-context-hub
category: session
description:
  en: One read-only index of every local AI-agent session (Codex, Claude Code, DSH, Trae, or any JSONL source) grouped by project, plus an append-only shared board for decisions and handoffs so switching agents leaves no context gap.
  zh: 把本机所有 agent 的会话历史合并成一份按项目分组的只读索引，并附一块只追加的共享上下文板，让换 agent 时不丢结论。
# 位图源已随仓库提供：assets/icon-180.png（另有 512px 与透明底版本，脚本 scripts/make-icon.py）
icon: https://raw.githubusercontent.com/<owner>/dsh-agent-context-hub/main/assets/icon-180.png
```

规则：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `url` | 是 | 与仓库地址**逐字一致**，不要带 `.git`、不要带尾斜杠 |
| `name` | 是 | `owner/repo` 形式，与 `url` 一致 |
| `category` | 是 | 上面 24 个之一，本插件用 `session` |
| `description.en` | 是 | 一句话，**以句号结尾**；这是唯一必需的描述字段 |
| `description.zh` | 建议 | 一句话，以「。」结尾 |
| `icon` | 否 | GitHub 托管的**位图** URL；本包已生成 `assets/icon-180.png`（`icon.svg` 是矢量图，不能直接当 `icon`） |

YAML 细节：描述里出现 `: `（冒号+空格）必须加引号，否则 YAML 解析失败；`<owner>` 与仓库名大小写要和 GitHub 上完全一致。

## 4. 收录后 `plugins.json` 里的条目长什么样

`https://awesome-dsh-plugin.com/plugins.json` 是生成结果，字段由 CI 计算，**贡献者不写这些**。对照用（本插件被收录后应呈现为）：

```json
{
  "name": "dsh-agent-context-hub",
  "owner": "<owner>",
  "url": "https://github.com/<owner>/dsh-agent-context-hub",
  "page": "https://awesome-dsh-plugin.com/p/<owner>/dsh-agent-context-hub/",
  "category": "session",
  "description": {
    "en": "One read-only index of every local AI-agent session (Codex, Claude Code, DSH, Trae, or any JSONL source) grouped by project, plus an append-only shared board for decisions and handoffs so switching agents leaves no context gap.",
    "zh": "把本机所有 agent 的会话历史合并成一份按项目分组的只读索引，并附一块只追加的共享上下文板，让换 agent 时不丢结论。"
  },
  "npm": null,
  "version": null,
  "stars": 0,
  "downloads": null,
  "downloadsStart": null,
  "downloadsEnd": null,
  "downloadsCheckedAt": null,
  "capabilities": ["shell", "fs-write", "fs-read", "env"],
  "capabilityRedLines": [],
  "capabilityCheckedAt": "2026-10-30T00:00:00.000Z",
  "install": "dsh plugin --profile web add github:<owner>/dsh-agent-context-hub",
  "added": "2026-10-30",
  "icon": "https://raw.githubusercontent.com/<owner>/dsh-agent-context-hub/main/assets/icon-180.png"
}
```

| 字段 | 来源 | 说明 |
| --- | --- | --- |
| `name` / `owner` / `url` | 你的 YAML | 仓库身份 |
| `page` | CI 生成 | `https://awesome-dsh-plugin.com/p/<owner>/<name>/` |
| `category` | 你的 YAML | 本插件 `session` |
| `description{en,zh}` | 你的 YAML | 原样展示 |
| `npm` | CI 探测 | 未发 npm 为 `null` |
| `version` | CI 探测 | 未发 npm 为 `null`（仓库里的 `1.0.0` 不自动同步到市场） |
| `stars` / `downloads` | CI 采集 | 未发 npm 时 `downloads` 为 `null` |
| `downloadsStart` / `downloadsEnd` / `downloadsCheckedAt` | CI 采集 | npm 有包时才有值 |
| `capabilities[]` | CI 扫描 | 取自 `shell` `fs-write` `fs-read` `network` `env` `llm` `dynamic-code` `subagent`；本插件实际是 `shell`（`ssh` 子进程 + node 脚本）、`fs-write`（写自己的数据目录）、`fs-read`（读会话文件）、`env`（读 `DSH_AGENT_CONTEXT_HOME` 等） |
| `capabilityRedLines[]` | CI 扫描 | 本插件没有触碰红线，为 `[]` |
| `capabilityCheckedAt` | CI 生成 | 最近一次能力扫描时间 |
| `install` | CI 生成 | GitHub-only：`dsh plugin --profile web add github:<owner>/<repo>` |
| `added` | CI 生成 | 收录日期 `YYYY-MM-DD` |
| `icon` | 你的 YAML（可选） | 位图 URL，可省略 |
| `tarball` / `screenshots` | 可选 | 只在 npm 不可达时给 `tarball` 兜底；`screenshots` 是 GitHub 托管的位图 URL 数组 |

## 5. 合并要求

维护者会按这些条件审核（都在仓库侧，不在 PR 文本里）：

| 条件 | 本仓库现状 | 要做的 |
| --- | --- | --- |
| `package.json` 声明 `dsh.bundle` | 已有（`dsh.bundle.patch: ./cordis.patch.yml`） | 无需改 |
| 需要 UI 时声明 `dsh.client` | 已有（`dsh.client.platform: web`） | 无需改 |
| 仓库根有 `cordis.patch.yml` | 已有 | 无需改 |
| 仓库有真实可运行的代码 | 是（`index.js` + `lib/` + `client.js`） | 无需改 |
| 仓库创建满 1 天 | CI 检查 | 新仓库先等一天再提 PR |
| GitHub 仓库带 `dsh-plugin` topic | 需确认 | `gh repo edit --add-topic dsh-plugin` |
| 描述逐字准确 | — | 描述里的能力必须和代码一致，审核会对着代码看 |
| 项目在维护 | — | 有问题能回应 |

## 6. 预检（提交前逐条跑）

```powershell
cd "C:\path\to\agent-context-hub"

# 1) 确认 private 不存在、发布元信息齐全
#    并用真实 GitHub 账号替换 repository / homepage / bugs 里的 OWNER 占位符
node -e "const p=require('./package.json');console.log('private:',p.private);console.log('dsh:',JSON.stringify(p.dsh));console.log('version:',p.version)"

# 2) 干净 profile 安装（把 <owner> 换成你的账号；本地目录也可）
dsh plugin --profile web add github:<owner>/dsh-agent-context-hub

# 3) 装完验证：面板出现 + ping 通
curl.exe -s http://127.0.0.1:56842/agent-context/api/ping
node lib/cli.mjs stats

# 4) 确认仓库 topic 与元信息
gh repo view --json name,url,repositoryTopics,createdAt
```

`package.json` 需要满足的最小内容（`private` 必须不存在；`repository` / `homepage` / `bugs` 里的 `OWNER` 换成你的 GitHub 账号）：

```json
{
  "name": "dsh-agent-context-hub",
  "version": "1.0.0",
  "repository": { "type": "git", "url": "git+https://github.com/<owner>/dsh-agent-context-hub.git" },
  "homepage": "https://github.com/<owner>/dsh-agent-context-hub#readme",
  "bugs": { "url": "https://github.com/<owner>/dsh-agent-context-hub/issues" }
}
```

> 注意：本包当前 `package.json` 已无 `"private": true`，也已带 `repository` / `homepage` / `bugs`，但三者里的 `OWNER` 还是大写占位符，**提交前必须替换成真实账号**，否则市场页的仓库链接会指向不存在的地址。若你从更早的副本发布，先确认 `private` 已删除——留着它在市场侧的安装与发布检查都会失败。

## 7. PR body（可直接粘贴）

```markdown
Adds `data/plugins/<owner>__dsh-agent-context-hub.yml`.

- Repo: https://github.com/<owner>/dsh-agent-context-hub
- Category: `session` — it aggregates, indexes and searches session history from Codex, Claude Code, DSH, Trae and any JSONL inbox source, grouped by project.
- What it does: one read-only index of every local agent session, plus an append-only shared context board (`decision` / `handoff` / `task` / `note`) that any agent can read and write.
- Declares `dsh.bundle` (+ `dsh.client` for the panel); `cordis.patch.yml` at repo root; Node >= 20 and >= 22.15 for the DSH adapter's zstd frames.
- Verified clean-profile install: `dsh plugin --profile web add github:<owner>/dsh-agent-context-hub`, then panel appears after a page refresh and `GET /agent-context/api/ping` returns `{"ok":true,...}`.
- Read-only by design: never writes `~/.codex`, `~/.claude` or `~/.dsh/sessions`; only writes its own data dir (`~/.dsh/agent-context`).
- `package.json` has no `private` field and has `repository` / `homepage` / `bugs` set to the real account.
- Repo topic `dsh-plugin` added.

Checklist:
- [ ] only `data/plugins/<owner>__dsh-agent-context-hub.yml` is added, no generated files touched
- [ ] `url` / `name` match the repo exactly
- [ ] `description.en` is one sentence and ends with a period
- [ ] `category` is one of the allowed values
- [ ] repo has runnable code and a root `cordis.patch.yml`
- [ ] repo carries the `dsh-plugin` topic
- [ ] descriptions match what the code actually does
```

## 8. 发布清单（从零到收录）

1. 在 GitHub 建仓库 `dsh-agent-context-hub`（Public）。
2. 本地 `git init`，首次提交：

   ```powershell
   git init
   git add .   # .gitignore 已排除 cache/、.verify*/、node_modules/
   git commit -m "feat: agent-context-hub 1.0.0"
   git branch -M main
   git remote add origin https://github.com/<owner>/dsh-agent-context-hub.git
   git push -u origin main
   ```

3. 确认 `package.json`：没有 `"private": true`，`repository` / `homepage` / `bugs` 里的 `OWNER` 已换成真实账号；`assets/icon-180.png` 已随仓库提供，无需再导出。
4. 加 topic：

   ```powershell
   gh repo edit --add-topic dsh-plugin
   ```

5. 等仓库满 1 天（CI 硬性检查）。
6. Fork `awesome-dsh-plugin/awesome-dsh-plugin`，新建 `data/plugins/<owner>__dsh-agent-context-hub.yml`（第 3 节的模板），只提交这一个文件。
7. 提 PR，body 用第 7 节的模板。
8. 合并后核对：

   ```powershell
   curl.exe -s https://awesome-dsh-plugin.com/plugins.json | findstr /C:"dsh-agent-context-hub"
   ```

   站点页应能打开：`https://awesome-dsh-plugin.com/p/<owner>/dsh-agent-context-hub/`。

9. 维护者可能改 `category` 或补中文描述——这属于正常编辑，不必回滚；以合并后的 `plugins.json` 为准。

## 9. 常见退回原因

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| CI 报描述不合规 | `description.en` 不以句号结尾，或含未加引号的 `: ` | 补句号、给整段加引号 |
| PR 被要求删文件 | 顺手改了 README / `plugins.json` | 只保留新增的 YAML |
| 仓库不被识别为插件 | 根目录缺 `cordis.patch.yml` 或 `package.json` 没有 `dsh.bundle` | 补齐后再提 |
| 提示仓库太新 | 创建未满 1 天 | 等一天 |
| 图标不显示 | `icon` 指向 SVG 或非 GitHub 托管地址 | 换成 `raw.githubusercontent.com` 上的 PNG/JPG |

## 10. 一条命令完成仓库侧准备（`scripts/publish.mjs`）

第 2–4 节的手工步骤可以合并成一次调用——它只做「把仓库变成可上架状态」，不会替你登录 GitHub：

```powershell
# 先看会改什么，不写任何文件
node scripts/publish.mjs --owner <你的GitHub账号> --dry-run

# 真正写入：package.json 的三个 URL、publish/<owner>__dsh-agent-context-hub.yml、git origin、分支改名 main
node scripts/publish.mjs --owner <你的GitHub账号>

# 有凭据的话直接推上去
node scripts/publish.mjs --owner <你的GitHub账号> --push
```

它完成后仍要你做的只剩：在 GitHub 建同名仓库（public）、加 `dsh-plugin` topic、等满 1 天、提市场的 YAML PR。

配套自检：`node scripts/preflight.mjs --live --port <端口>` 逐项核对 32 项上架前置条件（包名、`private`、`cordis.patch.yml` 的 insert 名、图标、git 状态、gh/npm 登录、活体路由），任何一项不通过都会打印修复提示并以非 0 退出。

## 11. 用 token 把 GitHub 侧一次做完（`scripts/github-setup.mjs`）

本机 `api.github.com` 与 `github.com` 直连都被拦，脚本默认走 `ssh -D 10808 rag_research` 的 SOCKS 代理；token 从文件读，不打印、不写入 git config。

```powershell
# 1. 建一个 fine-grained token：Contents = Read and write，Pull requests = Read and write
#    （经典 token 就勾 repo）
# 2. 存成一行到 %USERPROFILE%\.dsh\gh-token.txt
# 3. 先确认身份，再一条命令做完
node scripts/github-setup.mjs auth
node scripts/github-setup.mjs all --pr
```

`all` 依次执行：建仓库（已存在则跳过）→ `git push`（HTTPS + token，全程走代理）→ 加 `dsh-plugin` 等 topic → fork 市场仓库 → 写 `data/plugins/<owner>__dsh-agent-context-hub.yml` → 开 PR。每一步都能单独跑：`repo` / `push` / `topics` / `market`。

代理端口不是 10808 时用 `--socks <port>`；完全直连用 `--proxy direct`。

## 12. 市场 CI 到底查什么（照它自查）

`awesome-dsh-plugin/scripts/check-submission.mjs` 的自动检查只有四条：

1. 仓库里**任意** `package.json` 声明了 `dsh.bundle`（只声明 `dsh.client` 不算可安装，这是最常见的被拒原因）；
2. 仓库创建满 **1 天**（没有提交数门槛，而且这条会自己重跑，不必关掉 PR 重开）；
3. 仓库存在且未归档；
4. 不是 DSH 仓库本身。

`contributing.md` 里另有几条靠人工核对，提交前先自己对一遍：

- 仓库要有 `dsh-plugin` topic；
- 描述必须与代码一致（写了「几个工具」「某条命令」「某个 API」，就要真的存在）；
- 一个 PR 最多 3 条；
- `icon:` 必须是 GitHub 托管的**位图**（`assets/icon-180.png`），仓库里的 SVG 只给 Harness 自己用；
- 文件名 `<owner>__<repo>.yml` 必须与 `url:` 里的仓库完全一致。

本仓库的自查入口：

| 命令 | 覆盖 |
| --- | --- |
| `node scripts/verify-pack.mjs` | 9 项：`files` 白名单是否含全部运行时模块与适配器、是否夹带 cache、`git clone` 后能否通过测试并扫描本机 |
| `node scripts/preflight.mjs` | 31 项：包名、`private`、`cordis.patch.yml` 的 insert 名、图标、git 状态、凭据泄漏、活体路由 |
| `node scripts/verify-api.mjs` | 19 项：对活体实例逐个打 `/ping` `/list` `/sources` `/stats` `/shared` `/digest` `/transcript` `/client.js` 与 404，核对状态码与错误文案 |
| `node lib/test.mjs` | 52 项单元/集成用例 |

条目模板在 `publish/awesome-dsh-plugin.yml`，`github-setup.mjs market` 会自动把 `<owner>` 换成 token 所属账号再写进去。
## 13. 本轮实际结果（2026-11-02）

已经完成的，不需要再动手：

| 项 | 状态 |
| --- | --- |
| 公开仓库 | <https://github.com/Sirius-rocco/dsh-agent-context-hub>（public，`main`，已推 `b8103bf`） |
| 仓库 topic | `dsh-plugin` / `dsh-bundle` / `agent-context` / `session-history` |
| 市场条目 | `data/plugins/Sirius-rocco__dsh-agent-context-hub.yml`，`category: session` |
| 市场 PR | <https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/11332>（open，1 个文件，结构检查全过） |
| 图标 | `assets/icon-180.png`（8420 B，GitHub 托管位图，`icon:` 用的是它） |
| 发布物自检 | 从 GitHub 拉 tarball 解包后 `node --check` 通过、`node lib/test.mjs` 52/52 通过 |
| 安装方式 | `dsh plugin --profile web add github:Sirius-rocco/dsh-agent-context-hub`（市场收录后站点会显示这条） |

剩下的只有两件需要账号权限的事：

- **合并 PR #11332**：由市场维护者操作，我们只能等；CI 若回退到 `neutral`，仓库的 `regate.yml` 会自己重跑，不需要关 PR 重开。
- **npm 发布（可选）**：不上 npm 也能装、也能上架，只是市场卡片的 `npm` / `downloads` 两列为 `null`。

### 13.1 npm 发布（一条命令，或交给 CI）

本地手动：

```powershell
npm login                      # 浏览器授权一次，之后本机记住凭据
npm publish --access public    # 在仓库根目录执行
```

交给 CI（推荐，发布记录留痕）。工作流模板在 `publish/npm-publish.yml`，三步启用：

1. 在 npm 建一个 **Automation** token；
2. 仓库 Settings → Secrets and variables → Actions 新建 `NPM_TOKEN`；
3. 把 `publish/npm-publish.yml` 复制到 `.github/workflows/npm-publish.yml` 并提交，然后发一个 GitHub Release（或手动 `Run workflow` 把 `dry_run` 设为 false）。

工作流会先 `npm pack --dry-run`、再跑 `node lib/test.mjs`，全过了才 `npm publish`；`dry_run` 默认 `true`，手动触发不会误发。

> 为什么是模板而不是直接放 `.github/workflows/`：GitHub 只允许带 `workflow` scope 的 token 推送工作流文件，当前 classic token 只有 `repo` scope，push 会报 `refusing to allow a Personal Access Token to create or update workflow ... without workflow scope`。要么给 token 勾上 `workflow` 再推，要么在网页里新建这个文件——两条路都只需要一次。

### 13.2 复查命令

```powershell
node scripts/preflight.mjs --live --port <当前 GUI 端口>   # 32 项前置条件
node scripts/verify-pack.mjs                                # 9 项打包/可安装性
node scripts/verify-api.mjs --port <端口>                    # 19 项活体接口
node scripts/repo-check.mjs --pr 11332                      # 仓库元数据/topic/文件/市场 PR/CI 状态
```

`node scripts/github-setup.mjs auth` 可随时确认 token 是否还有效（它只打印账号名，不打印 token）。
