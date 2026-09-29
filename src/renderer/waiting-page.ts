import { localAbsolute, localClock, relativeLabel } from '../shared/waiting/local-time'
import type { WaitingRow, WaitingSnapshot } from '../shared/waiting/types'

const PROVENANCE = new Set(['指派', '提及', '请求 review', '状态文档'])

const ACTION_CLASS: Record<string, string> = {
  '要你动手': 'act-do',
  '待你审合': 'act-review',
  '待你推送': 'act-push',
  '待办': 'act-todo'
}

/** Mention-only rows are not a request to act. */
export const MENTION_ONLY_LABEL = '只是提及'

export interface MaybeSectionMemory {
  whenEmpty: boolean | null
  whenListed: boolean | null
}

export function rowActionLabel(row: { tier: 'strong' | 'weak', action: string, reasons: readonly string[] }): string | null {
  if (row.tier === 'weak') {
    const mentionOnly = row.reasons.includes('提及') && !row.reasons.includes('要人动手')
    return mentionOnly ? MENTION_ONLY_LABEL : null
  }
  return row.action || '要你动手'
}

/**
 * First visit with an empty main list opens the section. First visit with rows leaves it closed.
 * A saved choice wins after that, including a collapse that must stay collapsed next launch.
 */
export function maybeSectionOpen(mainCount: number, memory: MaybeSectionMemory): boolean {
  if (mainCount === 0) return memory.whenEmpty ?? true
  return memory.whenListed ?? false
}

export function rememberMaybeSection(mainCount: number, open: boolean, memory: MaybeSectionMemory): MaybeSectionMemory {
  if (mainCount === 0) return { ...memory, whenEmpty: open }
  return { ...memory, whenListed: open }
}

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

/** Collapsed 「可能相关」 header. The count is visible without opening the section. */
export function maybeRelatedLabel(count: number): string {
  return `可能相关 · ${count}`
}

/**
 * Empty-state line for the main list.
 * An all-clear line is only for when the weak section is empty too.
 */
export function waitingEmptyCopy(maybeCount: number): string {
  if (maybeCount > 0) return `没有明确等你的事 · 另有 ${maybeCount} 条可能相关`
  return '没有等你处理的事项'
}

function externalIcon(): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('class', 'external-icon')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', 'M6 3H3.5A1.5 1.5 0 0 0 2 4.5v8A1.5 1.5 0 0 0 3.5 14h8a1.5 1.5 0 0 0 1.5-1.5V10M9 2h5v5M14 2 7 9')
  path.setAttribute('fill', 'none')
  path.setAttribute('stroke', 'currentColor')
  path.setAttribute('stroke-width', '1.5')
  path.setAttribute('stroke-linecap', 'round')
  path.setAttribute('stroke-linejoin', 'round')
  svg.append(path)
  return svg
}

function paint(host: HTMLElement, snapshot: WaitingSnapshot, handlers: {
  refresh: () => void
  settings: () => void
  todos: () => void
  snooze: (id: string, days: 1 | 3 | 7) => void
  ignore: (id: string) => void
  restore: (id: string) => void
  hideRepo: (repo: string) => void
  unhideRepo: (repo: string) => void
  toggleIgnored: (show: boolean) => void
  rememberMaybe: (open: boolean) => void
  open: (url: string) => void
}): void {
  const mainRows = snapshot.rows.filter(row => row.tier !== 'weak')
  const maybeRows = snapshot.rows.filter(row => row.tier === 'weak')
  const oldest = mainRows.reduce((max, row) => Math.max(max, row.waitingDays), 0)
  const summary = mainRows.length === 0
    ? '打开这一页就会刷新。'
    : `${mainRows.length} 件待处理 · 最久的一件已经等了 ${oldest} 天`
  const refreshed = snapshot.refreshedAt
    ? relativeLabel(snapshot.refreshedAt, new Date())
    : '尚未刷新'
  const stamp = el('span', { class: 'waiting-stamp' }, [`上次刷新 ${refreshed}`])
  if (snapshot.refreshedAt) stamp.title = localAbsolute(snapshot.refreshedAt)
  const toolbar = el('div', { class: 'waiting-toolbar' }, [
    el('p', { class: 'waiting-summary' }, [summary]),
    stamp
  ])
  const refresh = el('button', { type: 'button', class: 'primary' }, [snapshot.refreshing ? '正在刷新' : '刷新'])
  const authBlocked = snapshot.auth === 'missing' || snapshot.auth === 'invalid'
  refresh.disabled = snapshot.refreshing || authBlocked
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
  if (snapshot.auth === 'missing' || snapshot.auth === 'invalid') {
    const go = el('button', { type: 'button', class: 'primary' }, ['去设置'])
    go.addEventListener('click', handlers.settings)
    const message = snapshot.auth === 'missing' ? '未配置 GitHub 认证' : 'GitHub 认证无效或已过期'
    page.append(el('div', {
      class: snapshot.auth === 'invalid' ? 'alert error auth-alert' : 'alert auth-alert',
      role: snapshot.auth === 'invalid' ? 'alert' : 'status'
    }, [
      el('p', {}, [message]),
      go
    ]))
  }
  if (snapshot.rateLimitResetAt) {
    page.append(el('div', { class: 'alert', role: 'status' }, [
      `GitHub 速率限制，重置时间 ${localClock(snapshot.rateLimitResetAt)}。下面仍是上次刷新的列表。`
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
  if (snapshot.showIgnored && snapshot.hiddenRepos.length > 0) {
    page.append(renderHiddenRepos(snapshot.hiddenRepos, handlers.unhideRepo))
  }
  if (snapshot.refreshing && snapshot.rows.length === 0) {
    page.append(el('p', { class: 'waiting-loading', role: 'status' }, ['正在刷新…']))
  } else if (!snapshot.refreshing && mainRows.length === 0 && maybeRows.length === 0 && snapshot.auth === 'ok') {
    page.append(el('p', { class: 'waiting-empty' }, [waitingEmptyCopy(0)]))
  } else {
    if (mainRows.length === 0 && snapshot.auth === 'ok' && !snapshot.refreshing) {
      page.append(el('p', { class: 'waiting-empty' }, [waitingEmptyCopy(maybeRows.length)]))
    } else if (mainRows.length > 0) {
      page.append(renderGroups(mainRows, handlers))
    }
    if (maybeRows.length > 0) {
      page.append(renderMaybe(
        maybeRows,
        handlers,
        maybeSectionOpen(mainRows.length, {
          whenEmpty: snapshot.maybeWhenEmpty,
          whenListed: snapshot.maybeWhenListed
        })
      ))
    }
  }
  host.replaceChildren(page)
}

function renderHiddenRepos(repos: readonly string[], unhideRepo: (repo: string) => void): HTMLElement {
  const section = el('section', { class: 'hidden-repos' }, [
    el('h2', {}, ['已忽略的仓库'])
  ])
  for (const repo of repos) {
    const restore = el('button', { type: 'button', class: 'ghost tiny' }, ['恢复'])
    restore.addEventListener('click', () => unhideRepo(repo))
    section.append(el('div', { class: 'hidden-repo' }, [
      el('span', { class: 'waiting-meta' }, [repo]),
      restore
    ]))
  }
  return section
}

function renderMaybe(rows: readonly WaitingRow[], handlers: {
  snooze: (id: string, days: 1 | 3 | 7) => void
  ignore: (id: string) => void
  restore: (id: string) => void
  hideRepo: (repo: string) => void
  open: (url: string) => void
  todos: () => void
  rememberMaybe: (open: boolean) => void
}, startsOpen: boolean): HTMLElement {
  const details = el('details', { class: 'maybe-related' })
  details.open = startsOpen
  details.addEventListener('toggle', () => {
    if (details.open !== startsOpen) handlers.rememberMaybe(details.open)
  })
  details.append(el('summary', {}, [maybeRelatedLabel(rows.length)]))
  details.append(el('p', { class: 'hint' }, ['只有提及，或正文里散落的关键词。不计入上面的待处理件数。']))
  const list = el('div', { class: 'maybe-list' })
  for (const row of rows) list.append(renderRow(row, handlers))
  details.append(list)
  return details
}

function renderGroups(rows: readonly WaitingRow[], handlers: {
  snooze: (id: string, days: 1 | 3 | 7) => void
  ignore: (id: string) => void
  restore: (id: string) => void
  hideRepo: (repo: string) => void
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
  hideRepo: (repo: string) => void
  open: (url: string) => void
  todos: () => void
}): HTMLElement {
  const age = band(row.waitingDays)
  const days = el('span', {
    class: `days days-${age}`,
    title: row.daysEstimated ? '估算：没有精确的事件时间，按 updated_at 计算' : '从原因发生时算起'
  }, [
    row.daysEstimated ? '约' : '',
    String(row.waitingDays),
    el('span', { class: 'unit' }, ['天'])
  ])
  const title = el('button', {
    type: 'button',
    class: 'waiting-title',
    title: '在浏览器中打开'
  }, [
    el('span', { class: 'waiting-title-text' }, [row.title]),
    externalIcon()
  ])
  title.addEventListener('click', () => {
    if (row.url.startsWith('arckeep://todos')) {
      handlers.todos()
      return
    }
    handlers.open(row.url)
  })
  const actionName = rowActionLabel(row)
  const chip = actionName
    ? el('span', {
      class: row.tier === 'weak' ? 'chip chip-mention' : `chip chip-${ACTION_CLASS[actionName] ?? 'act-do'}`,
      title: row.tier === 'weak' ? '不计入待处理件数' : row.reasons.join(' · ')
    }, [actionName])
    : null
  const viaNames = row.tier === 'weak' ? [] : row.reasons.filter(reason => PROVENANCE.has(reason))
  const via = viaNames.length > 0
    ? el('span', { class: 'waiting-via' }, [viaNames.join(' · ')])
    : null
  const where = row.number === null ? row.repo : `${row.repo} #${row.number}`
  const family = [
    row.parentNumber != null ? `属于 #${row.parentNumber}` : '',
    row.childCount > 0 ? `含 ${row.childCount} 个子项` : ''
  ].filter(Boolean).join(' ')
  const meta = el('span', { class: 'waiting-meta' }, [family ? `${where} ${family}` : where])
  const actions = el('div', { class: 'row-actions' })
  if (row.ignored) {
    const restore = el('button', { type: 'button', class: 'ghost tiny' }, ['恢复'])
    restore.addEventListener('click', () => handlers.restore(row.id))
    actions.append(restore)
  } else {
    const menu = el('div', { class: 'snooze-menu' })
    for (const amount of [1, 3, 7] as const) {
      const choice = el('button', { type: 'button', class: 'ghost tiny' }, [`${amount} 天`])
      choice.addEventListener('click', () => handlers.snooze(row.id, amount))
      menu.append(choice)
    }
    const snooze = el('details', { class: 'snooze' }, [
      el('summary', {}, ['延后']),
      menu
    ])
    const ignoreOne = el('button', { type: 'button', class: 'ghost tiny' }, ['忽略这一条'])
    ignoreOne.addEventListener('click', () => handlers.ignore(row.id))
    const hide = el('button', { type: 'button', class: 'ghost tiny' }, [`不看 ${row.repo} 这个仓库`])
    hide.addEventListener('click', () => handlers.hideRepo(row.repo))
    const ignoreMenu = el('div', { class: 'snooze-menu ignore-menu' }, [ignoreOne, hide])
    const ignore = el('details', { class: 'snooze ignore' }, [
      el('summary', {}, ['忽略']),
      ignoreMenu
    ])
    actions.append(snooze, ignore)
  }
  const body: Array<Node | string | null> = [days, title, chip, meta, actions]
  if (via) body.splice(3, 0, via)
  const excerpt = row.signalText.trim()
  const reason = excerpt
    ? el('p', { class: 'waiting-reason' }, [excerpt])
    : row.tier === 'weak'
      ? null
      : el('p', { class: 'waiting-reason' }, [row.reasons.join(' · ') || '等待'])
  return el('div', { class: `waiting-row age-${age}${row.ignored ? ' is-ignored' : ''}` }, [...body, reason].filter((node): node is Node | string => node != null))
}

export async function renderWaiting(
  host: HTMLElement,
  navigate: (view: 'settings' | 'todos', options?: { focusToken?: boolean }) => void
): Promise<void> {
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
    hiddenRepos: [],
    todosAvailable: false,
    maybeWhenEmpty: null,
    maybeWhenListed: null
  }
  const apply = (snapshot: WaitingSnapshot) => {
    paint(host, snapshot, {
      refresh: () => { void reload() },
      settings: () => navigate('settings', { focusToken: true }),
      todos: () => navigate('todos'),
      snooze: (id, days) => { void act(api => api.snoozeWaiting(id, days)) },
      ignore: id => { void act(api => api.ignoreWaiting(id)) },
      restore: id => { void act(api => api.restoreWaiting(id)) },
      hideRepo: repo => { void act(api => api.hideWaitingRepo(repo)) },
      unhideRepo: repo => { void act(api => api.unhideWaitingRepo(repo)) },
      toggleIgnored: show => { void act(api => api.setShowIgnored(show)) },
      rememberMaybe: open => { void act(api => api.setMaybeSectionOpen(open)) },
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
