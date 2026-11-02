/**
 * agent-context-hub — Web client half.
 *
 * Adds one global panel icon to the sidebar and one `main` panel that shows
 * every historical Codex conversation, grouped by project exactly like Codex
 * does, with a searchable list on the left and the transcript on the right.
 *
 * Data comes from the host half through same-origin fetch (see index.js).
 * Plain JavaScript bundle: `window.__ModuleLoader__.load` + React from require.
 */
// The host half also injects this file into the page shell, so on a working boot
// graph the same registration arrives twice; a second `load` of one id makes the
// module system throw, hence the guard. When the injection lands before the
// shell publishes `window.__ModuleLoader__` the registration waits for it below.
//
// Diagnostic beacon: the host records these and exposes them at
// `agent-context-hub/api/stats` (`client.beacons`), which is the only way to see
// what the real page did — the panel can only be missing because this script
// never ran, ran but threw, or ran and registered into a slot nobody renders.
function hubBeacon(stage, detail) {
  try {
    const payload = JSON.stringify({
      stage: String(stage),
      detail: detail === undefined || detail === null ? null : String(detail).slice(0, 300),
      at: new Date().toISOString(),
    })
    const url = 'agent-context-hub/api/beacon'
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      navigator.sendBeacon(url, new Blob([payload], { type: 'application/json' }))
      return
    }
    fetch(url, { method: 'POST', body: payload, keepalive: true, headers: { 'content-type': 'application/json' } }).catch(() => {})
  } catch {
    /* diagnostics must never break the panel */
  }
}

function registerAgentContextHubClient() {
  // A healthy instance already mounted: nothing to do. A *disposed* one (the
  // shell hot-reloads client modules by re-evaluating this file, and the old
  // instance's slot registration is dropped with it) must register again —
  // otherwise the sidebar icon disappears a while after every reload.
  if (window.__agentContextHubLive || window.__agentContextHubRegistered) return true
  if (!window.__ModuleLoader__ || typeof window.__ModuleLoader__.load !== 'function') return false
  window.__agentContextHubLoaded = true
  // The factory is registered once per page load: the host injects this file
  // and the boot batch also executes it, and the second `load` of one id throws.
  // `Registered` (unlike `Live`) is already true between registration and
  // mount, so a second execution in that window returns here instead of
  // throwing; the dispose hook clears it so a hot reload can register again.
  window.__agentContextHubRegistered = true
  hubBeacon(
    'script-eval',
    (() => {
      try {
        const boot = window.__DSH_BOOT__
        const ids = Array.isArray(boot?.entries) ? boot.entries.map((entry) => entry && entry.id) : []
        return `mode=${window.__ModuleLoader__ && window.__ModuleLoader__.mode} bootRev=${boot?.rev ?? 'none'} inBoot=${ids.includes('dsh-agent-context-hub') || ids.includes('agent-context-hub')} entries=${ids.length}`
      } catch {
        return 'boot-unreadable'
      }
    })(),
  )

window.__ModuleLoader__.load({
  // The boot graph names this bundle by its package name (`dsh-agent-context-hub`);
  // registering under any other id makes the entry's import fail.
  id: 'dsh-agent-context-hub',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo, useRef, useCallback } = React

    const PANEL_ID = 'agent-context-hub'
    const ROUTE = 'agent-context-hub/api'
    hubBeacon('factory')

    /* ------------------------------------------------------------------ */
    /* tokens                                                              */
    /* ------------------------------------------------------------------ */

    const T = {
      bg: 'var(--dsw-alias-bg-base)',
      layer1: 'var(--dsw-alias-bg-layer-1)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      border: 'var(--dsw-alias-border-l1)',
      borderStrong: 'var(--dsw-alias-border-l2)',
      brand: 'var(--dsw-alias-brand-primary)',
      text: 'var(--dsw-alias-label-primary)',
      text2: 'var(--dsw-alias-label-secondary)',
      error: 'var(--dsw-alias-state-error-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      mono: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
    }

    /* ------------------------------------------------------------------ */
    /* remote (SSH) sessions                                              */
    /* ------------------------------------------------------------------ */
    /* A remote session is indexed locally but its rollout file lives on an
     * SSH host: the host half pulls the body on demand. Everything here is
     * inert unless `session.remote === true`, so local-only payloads (the
     * old shape, without `remote`/`host`) render exactly as before. */

    function remoteHost(session) {
      if (!session || session.remote !== true) return ''
      return typeof session.host === 'string' ? session.host : ''
    }

    function remoteHint(session) {
      const host = remoteHost(session)
      return host ? `远程会话（${host}），正文按需通过 SSH 读取` : '远程会话，正文按需通过 SSH 读取'
    }

    /* ------------------------------------------------------------------ */
    /* http                                                                */
    /* ------------------------------------------------------------------ */

    function apiUrl(path) {
      const relative = `${ROUTE}/${String(path).replace(/^\/+/, '')}`
      if (typeof document === 'undefined') return `/${relative}`
      // Anchor on document.baseURI: a reverse proxy may mount Harness under a
      // sub-path while location.pathname still reads "/".
      // Keep the query string: URL.pathname alone would drop `?id=` / `?refresh=1`.
      const url = new URL(relative, document.baseURI)
      return url.pathname + url.search
    }

    async function getJson(path) {
      const response = await fetch(apiUrl(path), { headers: { accept: 'application/json' } })
      const text = await response.text()
      let payload = null
      try {
        payload = text ? JSON.parse(text) : null
      } catch {
        payload = null
      }
      if (!response.ok) {
        const message = payload?.error?.message || `HTTP ${response.status}`
        throw new Error(message)
      }
      if (payload === null || typeof payload !== 'object') throw new Error('响应不是合法 JSON')
      return payload
    }

    async function postJson(path, body) {
      const response = await fetch(apiUrl(path), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      const text = await response.text()
      let payload = null
      try {
        payload = text ? JSON.parse(text) : null
      } catch {
        payload = null
      }
      if (!response.ok) {
        const message = payload?.error?.message || `HTTP ${response.status}`
        throw new Error(message)
      }
      if (payload === null || typeof payload !== 'object') throw new Error('响应不是合法 JSON')
      return payload
    }

    /* ------------------------------------------------------------------ */
    /* formatting                                                          */
    /* ------------------------------------------------------------------ */

    function relativeTime(value) {
      const time = Date.parse(value ?? '')
      if (!Number.isFinite(time)) return ''
      const delta = Date.now() - time
      if (delta < 60_000) return '刚刚'
      if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`
      if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`
      if (delta < 30 * 86_400_000) return `${Math.floor(delta / 86_400_000)} 天前`
      const date = new Date(time)
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    }

    function absoluteTime(value) {
      const time = Date.parse(value ?? '')
      if (!Number.isFinite(time)) return ''
      const date = new Date(time)
      const pad = (n) => String(n).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    function shortPath(cwd) {
      if (!cwd) return ''
      const parts = String(cwd).split(/[\\/]+/).filter(Boolean)
      if (parts.length <= 3) return cwd
      return `…\\${parts.slice(-2).join('\\')}`
    }

    function basename(p) {
      if (!p) return ''
      const parts = String(p).split(/[\\/]+/).filter(Boolean)
      return parts[parts.length - 1] ?? String(p)
    }

    /* ------------------------------------------------------------------ */
    /* icons                                                               */
    /* ------------------------------------------------------------------ */

    let iconBeaconSent = false
    function HubIcon(props) {
      const size = props?.size ?? 16
      if (!iconBeaconSent) {
        iconBeaconSent = true
        hubBeacon('icon-render', `size=${size}`)
      }
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block', pointerEvents: 'none' },
        },
        h('rect', { x: 2.5, y: 4, width: 19, height: 15, rx: 3.2, opacity: 0.55 }),
        h('path', { d: 'M6.4 9.2 9 11.5l-2.6 2.3' }),
        h('path', { d: 'M11.4 13.9h4.2' }),
        h('path', { d: 'M16.6 17.9a4.6 4.6 0 1 1-2.1-8.6', opacity: 0.9 }),
        h('path', { d: 'M14.2 6.3v3.2h3.1' }),
      )
    }

    function RefreshIcon(props) {
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: props?.size ?? 14,
          height: props?.size ?? 14,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('path', { d: 'M20 11a8 8 0 1 0-2.3 5.7' }),
        h('path', { d: 'M20 4v7h-7' }),
      )
    }

    /* ------------------------------------------------------------------ */
    /* small components                                                    */
    /* ------------------------------------------------------------------ */

    function ErrorBoundary(props) {
      const [error, setError] = useState(null)
      if (error) {
        return h(
          'div',
          { style: { padding: 24, color: T.error, fontSize: 13, whiteSpace: 'pre-wrap' } },
          '上下文中枢面板渲染失败：',
          String(error?.message ?? error),
        )
      }
      try {
        return props.children
      } catch (caught) {
        setError(caught)
        return null
      }
    }

    function Spinner(props) {
      return h('span', {
        style: {
          display: 'inline-block',
          width: props?.size ?? 12,
          height: props?.size ?? 12,
          borderRadius: '50%',
          border: `2px solid ${T.borderStrong}`,
          borderTopColor: T.brand,
          animation: 'agent-context-hub-spin 0.8s linear infinite',
        },
      })
    }

    function LongText(props) {
      const text = String(props.text ?? '')
      const limit = props.limit ?? 6000
      const [open, setOpen] = useState(false)
      const clipped = text.length > limit && !open
      return h(
        'div',
        null,
        h('div', { style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.65 } }, clipped ? `${text.slice(0, limit)}…` : text),
        text.length > limit
          ? h(
              'button',
              {
                type: 'button',
                onClick: () => setOpen((value) => !value),
                style: {
                  marginTop: 6,
                  background: 'none',
                  border: 'none',
                  padding: 0,
                  color: T.brand,
                  cursor: 'pointer',
                  fontSize: 12,
                },
              },
              open ? '收起' : `展开全文（${text.length.toLocaleString()} 字符）`,
            )
          : null,
      )
    }

    function ToolBlock(props) {
      const message = props.message
      const isOutput = message.kind === 'tool_output'
      const title = message.name ? `${message.name}` : isOutput ? '工具输出' : '工具调用'
      return h(
        'details',
        {
          style: {
            border: `1px solid ${T.border}`,
            borderRadius: 8,
            background: T.layer2,
            padding: '6px 10px',
            margin: '6px 0',
          },
        },
        h(
          'summary',
          {
            style: {
              cursor: 'pointer',
              fontSize: 12,
              color: T.text2,
              userSelect: 'none',
              display: 'flex',
              gap: 6,
              alignItems: 'center',
            },
          },
          h('span', { style: { color: T.idle } }, isOutput ? '▤' : '▸'),
          h('span', { style: { fontWeight: 600, color: T.text } }, title),
          message.truncated ? h('span', { style: { color: T.warn } }, '· 已截断') : null,
        ),
        h(
          'pre',
          {
            style: {
              margin: '8px 0 2px',
              padding: 8,
              background: T.bg,
              border: `1px solid ${T.border}`,
              borderRadius: 6,
              maxHeight: 320,
              overflow: 'auto',
              fontSize: 11.5,
              lineHeight: 1.5,
              fontFamily: T.mono,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              color: T.text,
            },
          },
          String(message.text ?? ''),
        ),
      )
    }

    function MessageRow(props) {
      const message = props.message
      const role = message.role
      if (message.kind === 'tool_call' || message.kind === 'tool_output') return h(ToolBlock, { message })
      if (message.kind === 'agent_message') {
        return h(
          'div',
          {
            style: {
              margin: '12px 0',
              border: `1px dashed ${T.border2}`,
              borderRadius: 8,
              background: T.layer2,
              padding: '8px 12px',
            },
          },
          h('div', { style: { fontSize: 11, color: T.text2, marginBottom: 4 } }, `子代理 · ${message.name ?? 'agent'} · ${absoluteTime(message.ts)}`),
          h(LongText, { text: message.text }),
        )
      }
      if (role === 'user') {
        return h(
          'div',
          {
            style: {
              margin: '14px 0',
              borderLeft: `3px solid ${T.brand}`,
              background: T.layer1,
              borderRadius: '0 8px 8px 0',
              padding: '10px 14px',
            },
          },
          h('div', { style: { fontSize: 11, color: T.text2, marginBottom: 4 } }, `你 · ${absoluteTime(message.ts)}`),
          h(LongText, { text: message.text }),
        )
      }
      if (role === 'assistant') {
        return h(
          'div',
          { style: { margin: '14px 0', padding: '0 2px' } },
          h('div', { style: { fontSize: 11, color: T.text2, marginBottom: 4 } }, `Codex · ${absoluteTime(message.ts)}`),
          h(LongText, { text: message.text }),
        )
      }
      return h(
        'div',
        {
          style: {
            margin: '8px 0',
            fontSize: 12,
            color: T.text2,
            fontStyle: 'italic',
            whiteSpace: 'pre-wrap',
          },
        },
        String(message.text ?? ''),
      )
    }

    /**
     * Agent identity chip. Every session row can come from a different coding
     * agent, so the row has to say which one — the same project is often worked
     * on by Codex, Claude Code and DSH itself within one day.
     */
    const AGENT_META = {
      codex: { label: 'Codex', color: T.brand },
      'claude-code': { label: 'Claude', color: '#c2703a' },
      dsh: { label: 'DSH', color: '#4a8f6a' },
      inbox: { label: '接入', color: T.text2 },
    }

    function agentMeta(agent) {
      const key = String(agent ?? '').toLowerCase()
      return AGENT_META[key] ?? { label: agent ? String(agent) : '未知', color: T.text2 }
    }

    function AgentBadge(props) {
      const meta = agentMeta(props?.agent)
      const compact = props?.compact === true
      return h(
        'span',
        {
          title: `来源 agent：${meta.label}`,
          style: {
            flex: '0 0 auto',
            display: 'inline-flex',
            alignItems: 'center',
            height: 15,
            padding: compact ? '0 4px' : '0 5px',
            border: `1px solid ${meta.color}`,
            borderRadius: 4,
            color: meta.color,
            background: 'transparent',
            fontSize: 9.5,
            fontWeight: 600,
            lineHeight: '15px',
            letterSpacing: 0.2,
            whiteSpace: 'nowrap',
            verticalAlign: 'middle',
            opacity: 0.95,
          },
        },
        meta.label,
      )
    }

    /** Composite key: ids are only unique inside one agent. */
    function sessionKey(session) {
      if (!session) return ''
      return `${session.agent ?? 'codex'}:${session.id}`
    }

    function RemoteBadge(props) {
      const host = props?.host
      const label = host ? `SSH · ${host}` : 'SSH'
      return h(
        'span',
        {
          title: host ? `远程会话（${host}），正文按需通过 SSH 读取` : '远程会话，正文按需通过 SSH 读取',
          style: {
            flex: '0 0 auto',
            display: 'inline-flex',
            alignItems: 'center',
            height: 15,
            padding: '0 5px',
            border: `1px solid ${T.border}`,
            borderRadius: 999,
            background: T.layer2,
            color: T.idle,
            fontSize: 9.5,
            fontWeight: 600,
            lineHeight: '15px',
            letterSpacing: 0.2,
            whiteSpace: 'nowrap',
            verticalAlign: 'middle',
          },
        },
        label,
      )
    }

    /**
     * The snippet shown under a row while searching: the first indexed content
     * snippet that contains the keyword, else the newest indexed snippet.
     */
    function matchingSnippet(session, keyword) {
      const prompts = session.prompts ?? []
      const needle = String(keyword ?? '').toLowerCase()
      const hit = needle ? prompts.find((prompt) => String(prompt).toLowerCase().includes(needle)) : null
      const flat = String(hit ?? prompts[0] ?? '').replace(/\s+/g, ' ').trim()
      return flat.length > 120 ? `${flat.slice(0, 120)}…` : flat
    }

    function SessionRow(props) {
      const { session, active, onSelect, keyword, showAgent } = props
      const [hover, setHover] = useState(false)
      const host = remoteHost(session)
      const rowTitle = `${session.title}\n${session.cwd ?? ''}\n${absoluteTime(session.updatedAt)}`
      return h(
        'button',
        {
          type: 'button',
          onClick: () => onSelect(sessionKey(session)),
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          title: host ? `${rowTitle}\n${remoteHint(session)}` : rowTitle,
          style: {
            display: 'block',
            width: '100%',
            textAlign: 'left',
            border: 'none',
            borderRadius: 8,
            padding: '8px 10px',
            margin: '1px 0',
            cursor: 'pointer',
            background: active ? T.layer2 : hover ? T.layer1 : 'transparent',
            boxShadow: active ? `inset 2px 0 0 ${T.brand}` : 'none',
            color: T.text,
          },
        },
        h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 13,
              fontWeight: active ? 600 : 500,
              minWidth: 0,
            },
          },
          // Sessions coming through the generic inbox adapter carry the real
          // agent name in `actor`; the adapter id alone says nothing useful.
          showAgent || session.actor
            ? h(AgentBadge, { agent: session.actor ?? session.agent, compact: true })
            : null,
          h(
            'span',
            { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            session.title || '(无标题会话)',
          ),
          host ? h(RemoteBadge, { host }) : null,
        ),
        h(
          'div',
          {
            style: {
              display: 'flex',
              gap: 8,
              alignItems: 'center',
              marginTop: 3,
              fontSize: 11,
              color: T.text2,
            },
          },
          h('span', null, relativeTime(session.updatedAt)),
          session.messageCount ? h('span', null, `· ${session.messageCount} 条`) : null,
          session.model ? h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, `· ${session.model}`) : null,
        ),
        keyword && session.prompts?.length
          ? h(
              'div',
              {
                style: {
                  marginTop: 3,
                  fontSize: 11,
                  color: T.text2,
                  opacity: 0.85,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                },
              },
              `↳ ${matchingSnippet(session, keyword)}`,
            )
          : null,
      )
    }

    function GroupSection(props) {
      const { group, sessions, collapsed, onToggle, selectedId, onSelect, keyword, showAgent } = props
      const agentMix = (() => {
        const counts = new Map()
        for (const session of sessions) counts.set(session.agent ?? 'codex', (counts.get(session.agent ?? 'codex') ?? 0) + 1)
        return Array.from(counts.entries())
      })()
      const header = h(
        'button',
        {
          type: 'button',
          onClick: onToggle,
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            width: '100%',
            textAlign: 'left',
            border: 'none',
            background: 'transparent',
            color: T.text2,
            cursor: 'pointer',
            padding: '8px 4px 4px',
            fontSize: 11.5,
            fontWeight: 600,
            letterSpacing: 0.2,
          },
        },
        h('span', { style: { width: 10, display: 'inline-block' } }, collapsed ? '▸' : '▾'),
        h(
          'span',
          { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
          group.label || basename(group.cwd) || '未知项目',
        ),
        h('span', { style: { opacity: 0.6, fontWeight: 400 } }, String(sessions.length)),
        showAgent && agentMix.length > 1
          ? h(
              'span',
              { style: { fontWeight: 400, opacity: 0.5, whiteSpace: 'nowrap' } },
              agentMix.map(([agent, count]) => agentMeta(agent).label + ' ' + count).join(' · '),
            )
          : null,
        h(
          'span',
          {
            style: {
              marginLeft: 'auto',
              fontWeight: 400,
              opacity: 0.55,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              maxWidth: '45%',
            },
            title: group.cwd ?? '',
          },
          shortPath(group.cwd),
        ),
      )
      return h(
        'div',
        { style: { marginBottom: 2 } },
        header,
        collapsed
          ? null
          : h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 1 } },
              sessions.map((session) =>
                h(SessionRow, {
                  key: sessionKey(session),
                  session,
                  active: sessionKey(session) === selectedId,
                  showAgent,
                  onSelect,
                  keyword,
                }),
              ),
            ),
      )
    }

    function TranscriptPane(props) {
      const { session, transcript, loading, error, onRetry } = props
      if (error) {
        return h(
          'div',
          { style: { padding: 28, color: T.text2, fontSize: 13 } },
          h('div', { style: { color: T.error, marginBottom: 8 } }, `读取会话失败：${error}`),
          h(
            'button',
            {
              type: 'button',
              onClick: onRetry,
              style: {
                border: `1px solid ${T.borderStrong}`,
                background: T.layer1,
                color: T.text,
                borderRadius: 6,
                padding: '4px 12px',
                cursor: 'pointer',
              },
            },
            '重试',
          ),
        )
      }
      if (loading) {
        const host = remoteHost(session)
        return h(
          'div',
          { style: { display: 'flex', gap: 8, alignItems: 'center', padding: 28, color: T.text2, fontSize: 13 } },
          h(Spinner, { size: 14 }),
          host ? `正在从 ${host} 读取会话…（首次打开约 1~3 秒）` : '正在读取 上下文中枢正文…',
        )
      }
      if (!transcript) {
        return h(
          'div',
          { style: { padding: 28, color: T.text2, fontSize: 13 } },
          session ? '选择左侧会话查看正文。' : '左侧选择一个 上下文中枢开始阅读。',
        )
      }
      const messages = transcript.messages ?? []
      const fetchMs = typeof transcript.fetchMs === 'number' && isFinite(transcript.fetchMs) ? transcript.fetchMs : null
      const sshHost = (typeof transcript.host === 'string' && transcript.host) || remoteHost(session)
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } },
        h(
          'div',
          {
            style: {
              borderBottom: `1px solid ${T.border}`,
              padding: '12px 18px',
              background: T.layer1,
            },
          },
          h('div', { style: { fontSize: 15, fontWeight: 600, lineHeight: 1.4, wordBreak: 'break-word' } }, transcript.title || session?.title || '(无标题会话)'),
          h(
            'div',
            { style: { marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 12, fontSize: 11.5, color: T.text2 } },
            h('span', { title: transcript.cwd ?? '' }, `📁 ${shortPath(transcript.cwd ?? session?.cwd)}`),
            h('span', null, `🕒 ${absoluteTime(transcript.updatedAt ?? session?.updatedAt)}`),
            transcript.model ? h('span', null, `🤖 ${transcript.model}`) : null,
            fetchMs === null
              ? null
              : h(
                  'span',
                  { title: sshHost ? `正文通过 SSH 从 ${sshHost} 读取` : '' },
                  `SSH 读取 ${fetchMs} ms`,
                ),
            h('span', null, `${messages.length} 条消息`),
            transcript.truncated ? h('span', { style: { color: T.warn } }, `· 仅显示前 ${messages.length} 条`) : null,
            h(
              'button',
              {
                type: 'button',
                onClick: () => {
                  const id = transcript.id ?? session?.id ?? ''
                  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(id).catch(() => {})
                },
                style: {
                  marginLeft: 'auto',
                  border: 'none',
                  background: 'transparent',
                  color: T.text2,
                  cursor: 'pointer',
                  fontSize: 11.5,
                  padding: 0,
                },
              },
              '复制会话 ID',
            ),
          ),
        ),
        h(
          'div',
          { style: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '6px 18px 32px' } },
          messages.length === 0
            ? h('div', { style: { padding: 24, color: T.text2 } }, '这个会话没有可展示的消息。')
            : messages.map((message, index) => h(MessageRow, { key: `${index}-${message.ts ?? ''}`, message })),
        ),
      )
    }

    /* ------------------------------------------------------------------ */
    /* main panel                                                          */
    /* ------------------------------------------------------------------ */

    /* ------------------------------------------------------------------ */
    /* shared context                                                      */
    /* ------------------------------------------------------------------ */
    /* The second tab: one append-only log that every agent reads and writes.
     * It is what makes a handoff survive a switch between Codex, Claude Code
     * and DSH — a decision recorded here is visible to all of them, while the
     * "会话" tab stays a read-only archive of past transcripts. */

    const KINDS = [
      ['decision', '决策', T.brand],
      ['handoff', '交接', '#b07d2a'],
      ['task', '待办', '#4a8f6a'],
      ['note', '备注', T.text2],
    ]

    function kindMeta(kind) {
      const key = String(kind ?? '').toLowerCase()
      const hit = KINDS.find((entry) => entry[0] === key)
      return hit ? { key, label: hit[1], color: hit[2] } : { key: key || 'note', label: kind || '备注', color: T.text2 }
    }

    function KindChip(props) {
      const meta = kindMeta(props?.kind)
      return h(
        'span',
        {
          style: {
            flex: '0 0 auto',
            display: 'inline-flex',
            alignItems: 'center',
            height: 17,
            padding: '0 6px',
            borderRadius: 4,
            background: meta.color,
            color: T.bg,
            fontSize: 10,
            fontWeight: 700,
            lineHeight: '17px',
            letterSpacing: 0.3,
            whiteSpace: 'nowrap',
          },
        },
        meta.label,
      )
    }

    function sharedMatches(entry, keyword) {
      if (!keyword) return true
      const haystack = [entry.title, entry.body, entry.agent, entry.kind, entry.cwd, (entry.tags ?? []).join(' ')]
        .filter(Boolean)
        .join('\n')
        .toLowerCase()
      return haystack.includes(keyword)
    }

    function FieldLabel(props) {
      return h('div', { style: { fontSize: 11, color: T.text2, marginBottom: 4 } }, props.children)
    }

    const inputStyle = {
      width: '100%',
      boxSizing: 'border-box',
      border: `1px solid ${T.border}`,
      borderRadius: 6,
      background: T.bg,
      color: T.text,
      padding: '6px 8px',
      fontSize: 12,
      fontFamily: 'inherit',
      outline: 'none',
    }

    function SharedPane() {
      const [data, setData] = useState(null)
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState(null)
      const [query, setQuery] = useState('')
      const [kindFilter, setKindFilter] = useState('')
      const [selectedId, setSelectedId] = useState(null)
      const [composerOpen, setComposerOpen] = useState(false)
      const [saving, setSaving] = useState(false)
      const [saveError, setSaveError] = useState(null)
      const [draft, setDraft] = useState({ kind: 'decision', title: '', body: '', tags: '', agent: 'dsh' })

      const load = useCallback(async () => {
        setLoading(true)
        setError(null)
        try {
          const payload = await getJson('shared?limit=300')
          setData(payload)
        } catch (loadFailure) {
          setError(String(loadFailure?.message ?? loadFailure))
        } finally {
          setLoading(false)
        }
      }, [])

      useEffect(() => {
        load()
      }, [load])

      const entries = useMemo(() => {
        const keyword = query.trim().toLowerCase()
        return (data?.entries ?? []).filter(
          (entry) => (!kindFilter || entry.kind === kindFilter) && sharedMatches(entry, keyword),
        )
      }, [data, query, kindFilter])

      const selected = useMemo(() => {
        if (selectedId) {
          const hit = (data?.entries ?? []).find((entry) => entry.id === selectedId)
          if (hit) return hit
        }
        return entries[0] ?? null
      }, [data, entries, selectedId])

      const submit = useCallback(async () => {
        const title = draft.title.trim()
        if (!title) {
          setSaveError('标题不能为空')
          return
        }
        setSaving(true)
        setSaveError(null)
        try {
          const payload = await postJson('shared', {
            kind: draft.kind,
            title,
            body: draft.body.trim(),
            tags: draft.tags
              .split(/[,，\s]+/)
              .map((tag) => tag.trim())
              .filter(Boolean),
            agent: draft.agent.trim() || 'dsh',
          })
          setDraft({ kind: draft.kind, title: '', body: '', tags: '', agent: draft.agent })
          await load()
          if (payload?.entry?.id) setSelectedId(payload.entry.id)
        } catch (submitFailure) {
          setSaveError(String(submitFailure?.message ?? submitFailure))
        } finally {
          setSaving(false)
        }
      }, [draft, load])

      const counts = data?.counts ?? {}

      const header = h(
        'div',
        { style: { padding: '12px 12px 8px', borderBottom: `1px solid ${T.border}` } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('span', { style: { display: 'flex', color: T.brand } }, h(HubIcon, { size: 16 })),
          h('span', { style: { fontSize: 13, fontWeight: 600 } }, '共享上下文'),
          h(
            'span',
            { style: { fontSize: 11, color: T.text2, marginLeft: 2 } },
            loading && !data ? '读取中…' : `${data?.total ?? 0} 条 · ${Object.keys(data?.agents ?? {}).length} 个 agent`,
          ),
          h(
            'button',
            {
              type: 'button',
              title: '写一条共享上下文',
              onClick: () => setComposerOpen((open) => !open),
              style: {
                marginLeft: 'auto',
                border: `1px solid ${T.border}`,
                borderRadius: 6,
                background: composerOpen ? T.layer2 : 'transparent',
                color: T.text,
                cursor: 'pointer',
                fontSize: 11.5,
                padding: '3px 8px',
              },
            },
            composerOpen ? '收起' : '＋ 写入',
          ),
        ),
        h('input', {
          value: query,
          onChange: (event) => setQuery(event.target.value),
          placeholder: '搜索共享条目（标题 / 正文 / 标签 / agent）',
          style: { ...inputStyle, marginTop: 8 },
        }),
        h(
          'div',
          { style: { display: 'flex', gap: 4, marginTop: 6, flexWrap: 'wrap' } },
          [['', '全部']].concat(KINDS.map(([key, label]) => [key, label])).map(([key, label]) =>
            h(
              'button',
              {
                key: key || 'all',
                type: 'button',
                onClick: () => setKindFilter(key),
                style: {
                  border: `1px solid ${kindFilter === key ? T.borderStrong : T.border}`,
                  background: kindFilter === key ? T.layer2 : 'transparent',
                  color: kindFilter === key ? T.text : T.text2,
                  borderRadius: 999,
                  padding: '1px 8px',
                  fontSize: 11,
                  cursor: 'pointer',
                },
              },
              key ? `${label} ${counts[key] ?? 0}` : label,
            ),
          ),
        ),
        error
          ? h(
              'div',
              { style: { marginTop: 8, fontSize: 11.5, color: T.error } },
              `加载失败：${error}`,
              h(
                'button',
                {
                  type: 'button',
                  onClick: load,
                  style: { marginLeft: 8, border: `1px solid ${T.borderStrong}`, background: T.layer1, color: T.text, borderRadius: 5, padding: '1px 8px', cursor: 'pointer', fontSize: 11 },
                },
                '重试',
              ),
            )
          : null,
      )

      const list = h(
        'div',
        { style: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px 8px 16px' } },
        !loading && entries.length === 0
          ? h(
              'div',
              { style: { padding: 18, color: T.text2, fontSize: 12, lineHeight: 1.8 } },
              query || kindFilter ? '没有匹配的条目。' : '共享上下文还是空的。点「＋ 写入」记录第一条决策或交接。',
            )
          : entries.map((entry) => {
              const active = selected && entry.id === selected.id
              return h(
                'button',
                {
                  key: entry.id,
                  type: 'button',
                  onClick: () => setSelectedId(entry.id),
                  title: `${entry.title}\n${absoluteTime(entry.at)} · ${entry.agent}`,
                  style: {
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    border: 'none',
                    borderRadius: 8,
                    padding: '8px 10px',
                    margin: '1px 0',
                    cursor: 'pointer',
                    background: active ? T.layer2 : 'transparent',
                    boxShadow: active ? `inset 2px 0 0 ${T.brand}` : 'none',
                    color: T.text,
                  },
                },
                h(
                  'div',
                  { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
                  h(KindChip, { kind: entry.kind }),
                  h(
                    'span',
                    { style: { fontSize: 12.5, fontWeight: active ? 600 : 500, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                    entry.title,
                  ),
                ),
                h(
                  'div',
                  { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 3, fontSize: 11, color: T.text2 } },
                  h(AgentBadge, { agent: entry.agent, compact: true }),
                  h('span', null, relativeTime(entry.at)),
                  entry.cwd ? h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, `· ${basename(entry.cwd)}`) : null,
                ),
              )
            }),
      )

      const composer = composerOpen
        ? h(
            'div',
            { style: { border: `1px solid ${T.border}`, borderRadius: 8, padding: 12, marginBottom: 14, background: T.layer1 } },
            h('div', { style: { fontSize: 12, fontWeight: 600, marginBottom: 8 } }, '写一条共享上下文'),
            h(
              'div',
              { style: { display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' } },
              KINDS.map(([key, label]) =>
                h(
                  'button',
                  {
                    key,
                    type: 'button',
                    onClick: () => setDraft((state) => ({ ...state, kind: key })),
                    style: {
                      border: `1px solid ${draft.kind === key ? kindMeta(key).color : T.border}`,
                      background: draft.kind === key ? kindMeta(key).color : 'transparent',
                      color: draft.kind === key ? T.bg : T.text2,
                      borderRadius: 999,
                      padding: '1px 9px',
                      fontSize: 11,
                      fontWeight: draft.kind === key ? 700 : 400,
                      cursor: 'pointer',
                    },
                  },
                  label,
                ),
              ),
            ),
            h(FieldLabel, null, '标题'),
            h('input', {
              value: draft.title,
              onChange: (event) => setDraft((state) => ({ ...state, title: event.target.value })),
              placeholder: '一句话说清结论，例如「索引改为按内容摘要」',
              style: inputStyle,
            }),
            h('div', { style: { height: 8 } }),
            h(FieldLabel, null, '正文（可选：背景、影响、下一步）'),
            h('textarea', {
              value: draft.body,
              onChange: (event) => setDraft((state) => ({ ...state, body: event.target.value })),
              rows: 5,
              placeholder: '为什么这么定、影响哪些文件、下一个人要接着做什么…',
              style: { ...inputStyle, resize: 'vertical', lineHeight: 1.6 },
            }),
            h(
              'div',
              { style: { display: 'flex', gap: 8, marginTop: 8 } },
              h(
                'div',
                { style: { flex: 1 } },
                h(FieldLabel, null, '标签（逗号分隔）'),
                h('input', {
                  value: draft.tags,
                  onChange: (event) => setDraft((state) => ({ ...state, tags: event.target.value })),
                  placeholder: '索引, 搜索',
                  style: inputStyle,
                }),
              ),
              h(
                'div',
                { style: { width: 120 } },
                h(FieldLabel, null, '写入者'),
                h('input', {
                  value: draft.agent,
                  onChange: (event) => setDraft((state) => ({ ...state, agent: event.target.value })),
                  placeholder: 'dsh / codex / claude-code',
                  style: inputStyle,
                }),
              ),
            ),
            saveError ? h('div', { style: { marginTop: 8, fontSize: 11.5, color: T.error } }, saveError) : null,
            h(
              'div',
              { style: { display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' } },
              h(
                'button',
                {
                  type: 'button',
                  onClick: submit,
                  disabled: saving,
                  style: {
                    border: 'none',
                    borderRadius: 6,
                    background: T.brand,
                    color: T.bg,
                    fontSize: 12,
                    fontWeight: 600,
                    padding: '6px 14px',
                    cursor: saving ? 'default' : 'pointer',
                    opacity: saving ? 0.7 : 1,
                  },
                },
                saving ? '写入中…' : '写入共享上下文',
              ),
              h('span', { style: { fontSize: 11, color: T.text2 } }, '所有 agent 都能读到这条（HTTP API 与 CLI 同一份文件）'),
            ),
          )
        : null

      const detail = selected
        ? h(
            'div',
            { style: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '16px 20px' } },
            composer,
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' } },
              h(KindChip, { kind: selected.kind }),
              h(AgentBadge, { agent: selected.agent }),
              h('span', { style: { fontSize: 11.5, color: T.text2 } }, absoluteTime(selected.at)),
              selected.cwd ? h('span', { style: { fontSize: 11.5, color: T.text2, fontFamily: T.mono } }, shortPath(selected.cwd)) : null,
              h(
                'button',
                {
                  type: 'button',
                  title: '复制为 markdown',
                  onClick: () => {
                    const md = `### [${kindMeta(selected.kind).label}] ${selected.title}\n\n${selected.body ?? ''}\n\n_${selected.at} · ${selected.agent}_`
                    if (navigator?.clipboard?.writeText) navigator.clipboard.writeText(md).catch(() => {})
                  },
                  style: { marginLeft: 'auto', border: `1px solid ${T.border}`, background: 'transparent', color: T.text2, borderRadius: 5, padding: '1px 8px', fontSize: 11, cursor: 'pointer' },
                },
                '复制',
              ),
            ),
            h('div', { style: { fontSize: 16, fontWeight: 650, marginBottom: 8, lineHeight: 1.4 } }, selected.title),
            (selected.tags ?? []).length
              ? h(
                  'div',
                  { style: { display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 10 } },
                  selected.tags.map((tag) => h('span', { key: tag, style: { fontSize: 10.5, color: T.text2, border: `1px solid ${T.border}`, borderRadius: 999, padding: '0 7px' } }, `#${tag}`)),
                )
              : null,
            h(
              'div',
              { style: { fontSize: 13, lineHeight: 1.75, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: T.text } },
              selected.body || '（没有正文）',
            ),
            (selected.refs ?? []).length
              ? h('div', { style: { marginTop: 12, fontSize: 11.5, color: T.text2 } }, `引用：${(selected.refs ?? []).join(' · ')}`)
              : null,
          )
        : h(
            'div',
            { style: { flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, overflowY: 'auto', padding: '16px 20px' } },
            composer,
            h('div', { style: { color: T.text2, fontSize: 12.5, lineHeight: 1.9 } }, '左侧还没有条目。'),
          )

      return h(
        'div',
        { style: { display: 'flex', height: '100%', minHeight: 0, background: T.bg, color: T.text, fontSize: 13, fontFamily: 'inherit' } },
        h(
          'div',
          { style: { width: 330, flex: '0 0 330px', display: 'flex', flexDirection: 'column', minHeight: 0, borderRight: `1px solid ${T.border}`, background: T.layer1 } },
          header,
          list,
        ),
        h('div', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 } }, detail),
      )
    }

    function ContextHubPanel() {
      const [index, setIndex] = useState(null)
      const [loadError, setLoadError] = useState(null)
      const [loading, setLoading] = useState(true)
      const [refreshing, setRefreshing] = useState(false)
      const [query, setQuery] = useState('')
      const [selectedId, setSelectedId] = useState(null)
      const [collapsed, setCollapsed] = useState({})
      const [transcript, setTranscript] = useState(null)
      const [transcriptLoading, setTranscriptLoading] = useState(false)
      const [transcriptError, setTranscriptError] = useState(null)
      const [tab, setTab] = useState("sessions")
      const cacheRef = useRef(new Map())
      const refreshTimer = useRef(null)

      const loadIndex = useCallback(async (force) => {
        if (force) setRefreshing(true)
        else setLoading(true)
        setLoadError(null)
        try {
          const data = await getJson(force ? 'list?refresh=1' : 'list')
          setIndex(data)
        } catch (error) {
          setLoadError(String(error?.message ?? error))
        } finally {
          setLoading(false)
          setRefreshing(false)
        }
      }, [])

      useEffect(() => {
        loadIndex(false)
        return () => {
          if (refreshTimer.current) clearTimeout(refreshTimer.current)
        }
      }, [loadIndex])

      // A stale index means the host is rescanning in the background: pick the
      // fresh result up shortly, without hammering the host.
      useEffect(() => {
        if (!index?.stale) return undefined
        if (refreshTimer.current) clearTimeout(refreshTimer.current)
        refreshTimer.current = setTimeout(() => loadIndex(false), 6000)
        return () => {
          if (refreshTimer.current) clearTimeout(refreshTimer.current)
        }
      }, [index?.stale, index?.generatedAt, loadIndex])

      const flat = useMemo(() => (index?.groups ?? []).flatMap((group) => group.sessions ?? []), [index])

      const filteredGroups = useMemo(() => {
        const keyword = query.trim().toLowerCase()
        const groups = index?.groups ?? []
        if (!keyword) return groups.map((group) => ({ group, sessions: group.sessions ?? [] }))
        return groups
          .map((group) => ({
            group,
            sessions: (group.sessions ?? []).filter((session) => {
              const haystack = `${session.title ?? ''}\n${session.cwd ?? ''}\n${session.id ?? ''}\n${session.agent ?? ''}\n${session.actor ?? ''}\n${(session.prompts ?? []).join('\n')}`.toLowerCase()
              return haystack.includes(keyword)
            }),
          }))
          .filter((entry) => entry.sessions.length > 0)
      }, [index, query])

      // Default selection: newest session overall.
      useEffect(() => {
        if (selectedId || flat.length === 0) return
        setSelectedId(sessionKey(flat[0]))
      }, [flat, selectedId])

      const loadTranscript = useCallback(
        async (id, force) => {
          if (!id) return
          const cached = cacheRef.current.get(id)
          if (cached && !force) {
            setTranscript(cached)
            setTranscriptError(null)
            return
          }
          setTranscriptLoading(true)
          setTranscriptError(null)
          try {
            const data = await getJson(`transcript?id=${encodeURIComponent(id)}&t=${Date.now()}`)
            cacheRef.current.set(id, data)
            setTranscript(data)
          } catch (error) {
            setTranscriptError(String(error?.message ?? error))
            setTranscript(null)
          } finally {
            setTranscriptLoading(false)
          }
        },
        [],
      )

      useEffect(() => {
        if (!selectedId) return
        setTranscript(null)
        loadTranscript(selectedId, false)
      }, [selectedId, loadTranscript])

      const selectedSession = useMemo(() => flat.find((session) => sessionKey(session) === selectedId) ?? null, [flat, selectedId])
      const stats = index?.stats ?? {}
      const total = stats.sessions ?? flat.length
      const projectCount = index?.groups?.length ?? 0
      // Remote SSH sessions are indexed locally, so count them from the
      // sessions themselves; `hosts` only decides whether to show the segment.
      const remoteCounts = useMemo(() => {
        const counts = new Map()
        for (const session of flat) {
          if (session?.remote !== true) continue
          const host = typeof session.host === 'string' && session.host ? session.host : ''
          counts.set(host, (counts.get(host) ?? 0) + 1)
        }
        return counts
      }, [flat])
      const declaredHosts = Array.isArray(index?.hosts)
        ? index.hosts.filter((host) => typeof host === 'string' && host)
        : []
      const hostNames = declaredHosts.length ? declaredHosts : Array.from(remoteCounts.keys()).filter(Boolean)
      // One machine usually runs several agents; the panel says which ones.
      const agentCounts = useMemo(() => {
        const counts = new Map()
        for (const session of flat) {
          const agent = session.agent ?? "codex"
          counts.set(agent, (counts.get(agent) ?? 0) + 1)
        }
        return Array.from(counts.entries()).sort((left, right) => right[1] - left[1])
      }, [flat])
      const showAgent = agentCounts.length > 1
      const agentSummary = agentCounts.map(([agent, count]) => agentMeta(agent).label + " " + count).join(" · ")
      // Adapters that found nothing (or are not detected) are still worth a line:
      // otherwise a user never learns that Claude Code / the generic inbox exist.
      const sourceLine = useMemo(() => {
        const list = Array.isArray(index?.sources) ? index.sources : []
        const parts = []
        for (const source of list) {
          const label = source?.label ?? source?.id ?? "?"
          if (source?.detected === false) parts.push(label + " 未启用")
          else if (source?.error) parts.push(label + " 出错")
          else parts.push(label + " " + (source?.sessions ?? 0))
        }
        return parts.join(" · ")
      }, [index])

      const header = h(
        'div',
        { style: { padding: '12px 12px 8px', borderBottom: `1px solid ${T.border}` } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('span', { style: { display: 'flex', color: T.brand } }, h(HubIcon, { size: 16 })),
          h('span', { style: { fontSize: 13, fontWeight: 600 } }, '所有 agent 的会话'),
          h(
            'span',
            { style: { fontSize: 11, color: T.text2, marginLeft: 2 } },
            loading ? '读取中…' : `${total} 个 · ${projectCount} 个项目`,
          ),
          hostNames.length
            ? h(
                'span',
                {
                  title: '远程 SSH 会话：正文按需读取',
                  style: {
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 11,
                    color: T.idle,
                    minWidth: 0,
                    overflow: 'hidden',
                    whiteSpace: 'nowrap',
                    textOverflow: 'ellipsis',
                  },
                },
                hostNames.map((host) =>
                  h('span', { key: host }, `SSH: ${host} · ${remoteCounts.get(host) ?? 0} 个`),
                ),
              )
            : null,
          h(
            'button',
            {
              type: 'button',
              title: '重新扫描所有 agent 的会话',
              onClick: () => loadIndex(true),
              disabled: refreshing,
              style: {
                marginLeft: 'auto',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 26,
                height: 26,
                border: `1px solid ${T.border}`,
                borderRadius: 6,
                background: 'transparent',
                color: refreshing ? T.text2 : T.text,
                cursor: refreshing ? 'default' : 'pointer',
                padding: 0,
              },
            },
            refreshing ? h(Spinner, { size: 12 }) : h(RefreshIcon),
          ),
        ),
        h('input', {
          value: query,
          onChange: (event) => setQuery(event.target.value),
          placeholder: '搜索标题 / 项目 / 提问内容 / 会话 ID',
          style: {
            marginTop: 8,
            width: '100%',
            boxSizing: 'border-box',
            border: `1px solid ${T.border}`,
            borderRadius: 6,
            background: T.bg,
            color: T.text,
            padding: '6px 8px',
            fontSize: 12,
            outline: 'none',
          },
        }),
        index?.stale || index?.scanning
          ? h('div', { style: { marginTop: 6, fontSize: 11, color: T.warn } }, '索引正在后台刷新，稍后自动更新…')
          : index?.generatedAt
            ? h('div', { style: { marginTop: 6, fontSize: 11, color: T.text2 } }, `索引生成于 ${absoluteTime(index.generatedAt)}`)
            : null,
        loadError
          ? h(
              'div',
              { style: { marginTop: 8, fontSize: 11.5, color: T.error, display: 'flex', gap: 8, alignItems: 'center' } },
              h('span', { style: { flex: 1 } }, `加载失败：${loadError}`),
              h(
                'button',
                {
                  type: 'button',
                  onClick: () => loadIndex(false),
                  style: { border: `1px solid ${T.borderStrong}`, background: T.layer1, color: T.text, borderRadius: 5, padding: '2px 8px', cursor: 'pointer', fontSize: 11 },
                },
                '重试',
              ),
            )
          : null,
      )

      const list = h(
        'div',
        { style: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '2px 8px 16px' } },
        loading && !index ? h('div', { style: { padding: 20, color: T.text2, fontSize: 12 } }, '首次索引可能需要几秒钟…') : null,
        !loading && filteredGroups.length === 0
          ? h(
              'div',
              { style: { padding: 20, color: T.text2, fontSize: 12, lineHeight: 1.7 } },
              query
                ? '没有匹配的会话。'
                : '还没有索引到任何会话：确认本机存在 ~/.codex/sessions 或 ~/.claude/projects，也可以把任意 agent 的 JSONL 放进数据目录的 inbox。',
            )
          : filteredGroups.map(({ group, sessions }) =>
              h(GroupSection, {
                key: group.key,
                group,
                sessions,
                collapsed: Boolean(collapsed[group.key]),
                onToggle: () => setCollapsed((state) => ({ ...state, [group.key]: !state[group.key] })),
                selectedId,
                onSelect: setSelectedId,
                keyword: query,
                showAgent,
              }),
            ),
      )

      const tabButton = (key, label) =>
        h(
          'button',
          {
            key,
            type: 'button',
            onClick: () => setTab(key),
            style: {
              border: 'none',
              borderBottom: `2px solid ${tab === key ? T.brand : 'transparent'}`,
              background: 'transparent',
              color: tab === key ? T.text : T.text2,
              fontSize: 12,
              fontWeight: tab === key ? 650 : 500,
              padding: '5px 10px 4px',
              cursor: 'pointer',
            },
          },
          label,
        )

      const tabBar = h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 2,
            padding: '4px 8px 0',
            borderBottom: `1px solid ${T.border}`,
            background: T.layer1,
          },
        },
        tabButton('sessions', '会话'),
        tabButton('shared', '共享上下文'),
        h('span', { style: { marginLeft: 'auto', fontSize: 11, color: T.text2, paddingRight: 4 } }, agentSummary),
        sourceLine
          ? h(
              'span',
              {
                title: `来源：${sourceLine}`,
                style: {
                  fontSize: 11,
                  color: T.text2,
                  paddingRight: 6,
                  maxWidth: 320,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                },
              },
              `来源：${sourceLine}`,
            )
          : null,
      )

      if (tab === 'shared') {
        return h(
          'div',
          {
            style: {
              display: 'flex',
              flexDirection: 'column',
              height: '100%',
              minHeight: 0,
              background: T.bg,
              color: T.text,
              fontSize: 13,
              fontFamily: 'inherit',
            },
          },
          tabBar,
          h('div', { style: { flex: 1, minHeight: 0, display: 'flex' } }, h(SharedPane)),
        )
      }

      return h(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            minHeight: 0,
            background: T.bg,
            color: T.text,
            fontSize: 13,
            fontFamily: 'inherit',
          },
        },
        tabBar,
        h(
          'div',
          { style: { flex: 1, minHeight: 0, display: 'flex' } },
          h(
            'div',
            {
              style: {
                width: 330,
                flex: '0 0 330px',
                display: 'flex',
                flexDirection: 'column',
                minHeight: 0,
                borderRight: `1px solid ${T.border}`,
                background: T.layer1,
              },
            },
            header,
            list,
          ),
          h(
            'div',
            { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 } },
            h(TranscriptPane, {
              session: selectedSession,
              transcript,
              loading: transcriptLoading,
              error: transcriptError,
              onRetry: () => loadTranscript(selectedId, true),
            }),
          ),
        ),
      )
    }

    /* ------------------------------------------------------------------ */
    /* plugin                                                              */
    /* ------------------------------------------------------------------ */

    return {
      inject: ['slots'],
      apply(ctx) {
        // Mark the runtime as live so a later hot reload can tell a healthy
        // instance from one the shell already disposed.
        window.__agentContextHubLive = true
        try {
          const disposers = []
          const push = (value) => {
            if (typeof value === 'function') disposers.push(value)
          }

          // One global panel icon + the `main` cell it dispatches to. The
          // sidebar owns the button; both use the same id/key.
          //
          // Both seats are declared by other plugins (`@deepseek-ai/dsh-client-ui-sidebar`
          // and `-ui-layout`), and those can land after this one in the boot
          // graph. A direct `register()` then throws "slot ... is not declared"
          // and this plugin never mounts, so wait for each slot to appear and
          // register from inside `inject`, which re-runs when it is declared.
          push(
            ctx.slots.inject('sidebar.panellist', () => {
              hubBeacon('slot-ready', 'sidebar.panellist')
              return ctx.slots.register(
                {
                  name: 'sidebar.panellist',
                  id: PANEL_ID,
                  order: 5,
                  label: () => '上下文中枢',
                },
                (owner) => h(HubIcon, { size: owner?.size ?? 18 }),
              )
            }),
          )
          push(
            ctx.slots.inject('main', () => {
              hubBeacon('slot-ready', 'main')
              return ctx.slots.register(
                {
                  name: 'main',
                  key: PANEL_ID,
                },
                () => h(ErrorBoundary, null, h(ContextHubPanel)),
              )
            }),
          )
          hubBeacon('apply', 'injected')

          return () => {
            window.__agentContextHubLive = false
            window.__agentContextHubRegistered = false
            for (const dispose of disposers) {
              try {
                dispose()
              } catch {
                /* already disposed */
              }
            }
          }
        } catch (error) {
          // A throwing client plugin blanks the whole app: contain it.
          console.error('agent-context-hub: client plugin failed to mount', error)
          hubBeacon('mount-error', error && error.message)
          return () => {}
        }
      },
    }
  },
})

// Spinner keyframes: a single <style> element, namespaced to this plugin.
if (typeof document !== 'undefined' && !document.getElementById('agent-context-hub-style')) {
  const style = document.createElement('style')
  style.id = 'agent-context-hub-style'
  style.textContent = '@keyframes agent-context-hub-spin{to{transform:rotate(360deg)}}'
  document.head.appendChild(style)
}

  return true
}

// Register now, or wait for the shell's module queue: the injection can execute
// before the boot script that publishes `window.__ModuleLoader__`. The same loop
// keeps watching afterwards, so an instance the shell disposed during a hot
// reload is replaced instead of silently leaving the sidebar without its icon.
// The shell evaluates this file more than once (bundle client plus the
// index-inject above), so these names must survive re-evaluation: a top-level
// `let`/`const` redeclaration is a SyntaxError that kills the whole bundle.
var agentContextHubAttempts = 0
var agentContextHubTimer = setInterval(() => {
  agentContextHubAttempts += 1
  const done = registerAgentContextHubClient()
  if (done) {
    clearInterval(agentContextHubTimer)
    return
  }
  if (agentContextHubAttempts >= 60) clearInterval(agentContextHubTimer)
}, 1000)
registerAgentContextHubClient()
if (window.__agentContextHubLive) clearInterval(agentContextHubTimer)
