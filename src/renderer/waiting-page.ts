import type { WaitingRow, WaitingSnapshot } from '../shared/waiting/types'

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: Array<Node | string> = []
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value
    else node.setAttribute(key, value)
  }
  for (const child of children) node.append(child instanceof Node ? child : document.createTextNode(child))
  return node
}

function band(days: number): 'high' | 'mid' | 'low' {
  if (days >= 14) return 'high'
  if (days >= 3) return 'mid'
  return 'low'
}

const BAND_LABEL = {
  high: '两周以上',
  mid: '3–13 天',
  low: '近 3 天'
} as const

function formatStamp(iso: string | null): string {
  if (!iso) return '尚未刷新'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`
}

function paint(host: HTMLElement, snapshot: WaitingSnapshot, handlers: {
  refresh: () => void
  settings: () => void
  todos: () => void
  snooze: (id: string, days: 1 | 3 | 7) => void
  ignore: (id: string) => void
  restore: (id: string) => void
  toggleIgnored: (show: boolean) => void
  open: (url: string) => void
}): void {
  const oldest = snapshot.rows.reduce((max, row) => Math.max(max, row.waitingDays), 0)
  const summary = snapshot.rows.length === 0
    ? '打开这一页就会刷新。'
    : `${snapshot.rows.length} 件待处理 · 最久的一件已经等了 ${oldest} 天`
  const toolbar = el('div', { class: 'waiting-toolbar' }, [
    el('p', { class: 'waiting-summary' }, [summary]),
    el('span', { class: 'waiting-stamp' }, [`上次刷新 ${formatStamp(snapshot.refreshedAt)}`])
  ])
  const refresh = el('button', { type: 'button', class: 'primary' }, [snapshot.refreshing ? '正在刷新' : '刷新'])
  refresh.disabled = snapshot.refreshing
  refresh.addEventListener('click', handlers.refresh)
  const ignored = el('label', { class: 'check' }, ['显示已忽略'])
  const ignoredInput = el('input', { type: 'checkbox' })
  ignoredInput.checked = snapshot.showIgnored
  ignoredInput.addEventListener('change', () => handlers.toggleIgnored(ignoredInput.checked))
  ignored.prepend(ignoredInput)
  toolbar.append(refresh, ignored)

  const page = el('section', { class: 'page waiting' }, [
    el('h1', {}, ['等我处理']),
    toolbar
  ])
  if (!snapshot.todosAvailable) {
    page.append(el('p', { class: 'hint waiting-note' }, ['待办里的「等我」还没接上（依赖待办 #4），这个来源现在是空的。']))
  }
  if (snapshot.auth === 'missing') {
    const button = el('button', { type: 'button', class: 'alert-button' }, ['未配置 GitHub 认证，去设置'])
    button.addEventListener('click', handlers.settings)
    page.append(el('div', { class: 'alert', role: 'status' }, [button]))
  } else if (snapshot.auth === 'invalid') {
    const button = el('button', { type: 'button', class: 'alert-button' }, ['GitHub 认证无效或已过期，去设置'])
    button.addEventListener('click', handlers.settings)
    page.append(el('div', { class: 'alert error', role: 'alert' }, [button]))
  }
  if (snapshot.rateLimitResetAt) {
    page.append(el('div', { class: 'alert', role: 'status' }, [
      `GitHub 速率限制，重置时间 ${formatStamp(snapshot.rateLimitResetAt)}。下面仍是上次刷新的列表。`
    ]))
  }
  for (const notice of snapshot.notices) {
    page.append(el('div', { class: 'alert', role: 'status' }, [notice]))
  }
  for (const error of snapshot.sourceErrors) {
    page.append(el('div', { class: 'alert error', role: 'status' }, [`来源「${error.source}」失败：${error.message}`]))
  }
  if (snapshot.hiddenCount > 0) {
    page.append(el('p', { class: 'hint' }, [`另有 ${snapshot.hiddenCount} 条已延后或已忽略。`]))
  }
  if (snapshot.refreshing && snapshot.rows.length === 0) {
    page.append(el('p', { class: 'waiting-loading', role: 'status' }, ['正在刷新…']))
  } else if (!snapshot.refreshing && snapshot.rows.length === 0 && snapshot.auth === 'ok') {
    page.append(el('p', { class: 'waiting-empty' }, ['没有等你处理的事项']))
  } else {
    page.append(renderGroups(snapshot.rows, handlers))
  }
  host.replaceChildren(page)
}

function renderGroups(rows: readonly WaitingRow[], handlers: {
  snooze: (id: string, days: 1 | 3 | 7) => void
  ignore: (id: string) => void
  restore: (id: string) => void
  open: (url: string) => void
  todos: () => void
}): HTMLElement {
  const list = el('div', { class: 'waiting-groups' })
  let current: 'high' | 'mid' | 'low' | null = null
  let group: HTMLElement | null = null
  for (const row of rows) {
    const age = band(row.waitingDays)
    if (age !== current) {
      current = age
      const count = rows.filter(item => band(item.waitingDays) === age).length
      group = el('section', { class: `age-group age-${age}` }, [
        el('h2', {}, [`${BAND_LABEL[age]} · ${count}`])
      ])
      list.append(group)
    }
    group?.append(renderRow(row, handlers))
  }
  return list
}

function renderRow(row: WaitingRow, handlers: {
  snooze: (id: string, days: 1 | 3 | 7) => void
  ignore: (id: string) => void
  restore: (id: string) => void
  open: (url: string) => void
  todos: () => void
}): HTMLElement {
  const age = band(row.waitingDays)
  const open = el('button', { type: 'button', class: 'waiting-open' })
  const days = el('span', {
    class: `days days-${age}`,
    title: row.daysEstimated ? '估算：没有精确的事件时间，按 updated_at 计算' : '从原因发生时算起'
  }, [
    row.daysEstimated ? '约' : '',
    String(row.waitingDays),
    el('span', { class: 'unit' }, ['天'])
  ])
  const where = row.number === null ? row.repo : `${row.repo} #${row.number}`
  open.append(
    days,
    el('span', { class: 'waiting-copy' }, [
      el('span', { class: 'waiting-title' }, [row.title]),
      el('span', { class: 'waiting-meta' }, [`${where} · ${row.reasons.join(' · ')}`])
    ])
  )
  open.addEventListener('click', () => {
    if (row.url.startsWith('arckeep://todos')) {
      handlers.todos()
      return
    }
    handlers.open(row.url)
  })
  const actions = el('div', { class: 'row-actions' })
  if (row.ignored) {
    const restore = el('button', { type: 'button', class: 'ghost tiny' }, ['恢复'])
    restore.addEventListener('click', () => handlers.restore(row.id))
    actions.append(restore)
  } else {
    for (const days of [1, 3, 7] as const) {
      const button = el('button', { type: 'button', class: 'ghost tiny', title: `延后 ${days} 天` }, [`${days}天`])
      button.addEventListener('click', () => handlers.snooze(row.id, days))
      actions.append(button)
    }
    const ignore = el('button', { type: 'button', class: 'ghost tiny' }, ['忽略'])
    ignore.addEventListener('click', () => handlers.ignore(row.id))
    actions.append(ignore)
  }
  return el('div', { class: `waiting-row age-${age}${row.ignored ? ' is-ignored' : ''}` }, [open, actions])
}

export async function renderWaiting(host: HTMLElement, navigate: (view: 'settings' | 'todos') => void): Promise<void> {
  const loading: WaitingSnapshot = {
    rows: [],
    refreshedAt: null,
    refreshing: true,
    auth: 'ok',
    rateLimitResetAt: null,
    sourceErrors: [],
    notices: [],
    showIgnored: false,
    hiddenCount: 0,
    todosAvailable: false
  }
  const apply = (snapshot: WaitingSnapshot) => {
    paint(host, snapshot, {
      refresh: () => { void reload() },
      settings: () => navigate('settings'),
      todos: () => navigate('todos'),
      snooze: (id, days) => { void act(api => api.snoozeWaiting(id, days)) },
      ignore: id => { void act(api => api.ignoreWaiting(id)) },
      restore: id => { void act(api => api.restoreWaiting(id)) },
      toggleIgnored: show => { void act(api => api.setShowIgnored(show)) },
      open: url => { void window.arckeep.openExternal(url) }
    })
  }
  const act = async (call: (api: Window['arckeep']) => Promise<{ ok: boolean, error?: string, data?: WaitingSnapshot }>) => {
    const result = await call(window.arckeep)
    if (result.ok && result.data) apply(result.data)
  }
  const reload = async () => {
    apply({ ...loading, refreshing: true })
    try {
      apply(await window.arckeep.refreshWaiting())
    } catch (error) {
      apply({
        ...loading,
        refreshing: false,
        sourceErrors: [{ source: '刷新', message: error instanceof Error ? error.message : '刷新失败' }]
      })
    }
  }
  apply(loading)
  await reload()
}
