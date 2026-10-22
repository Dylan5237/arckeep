import { elapsedTime, localAbsolute, localClock, relativeLabel } from '../shared/time'
import { orderList, type ListOrder } from '../shared/list-order'
import { listSortControl, readListOrder } from './list-sort'
import type { ApoQuickAction } from '../shared/waiting/apo-actions'
import type { WaitingRow, WaitingSnapshot } from '../shared/waiting/types'
import { createRefreshStatus } from './refresh-status'
import { DEFAULT_REPO_FETCH_WINDOW, type RepoFetchWindow } from '../shared/repo-fetch-window'
import { repoFetchWindowControl } from './repo-fetch-window'
import { bindExclusiveRowActions } from './exclusive-rows'

const PROVENANCE = new Set(['指派', '提及', '请求 review', '状态文档'])

const ACTION_CLASS: Record<string, string> = {
  '要你动手': 'act-do',
  '待你审合': 'act-review',
  '待你推送': 'act-push',
  '待办': 'act-todo'
}

/** Mention-only rows are not a request to act. */
export const MENTION_ONLY_LABEL = '只是提及'

/** The main-list excerpt is the signed-in user's own latest request. */
export const OWN_REQUEST_LABEL = '你写的'

export function ownRequestLabel(row: { tier?: 'strong' | 'weak', ownRequest?: boolean, signal?: { own?: boolean } }): string | null {
  const own = row.ownRequest === true || row.signal?.own === true
  if ((row.tier ?? 'strong') !== 'strong' || !own) return null
  return OWN_REQUEST_LABEL
}

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
  order: ListOrder
  sort: (order: ListOrder) => void
  comment: (rowId: string, action: ApoQuickAction, checkOnly?: boolean) => void
  commentState: (action: ApoQuickAction) => { busy: boolean, message: string, blocked: boolean }
  refresh: () => void
  setWindow: (value: RepoFetchWindow) => void
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
}): HTMLElement {
  const sorted = orderList(snapshot.rows, handlers.order, { time: row => row.updatedAt, name: row => row.repo, id: row => row.id })
  const mainRows = sorted.filter(row => row.tier !== 'weak')
  const maybeRows = sorted.filter(row => row.tier === 'weak')
  const oldest = mainRows.reduce((max, row) => Math.max(max, row.waitingDays), 0)
  const summary = mainRows.length === 0
    ? '先显示上次结果，需要最新数据时可点刷新。'
    : `${mainRows.length} 件待处理 · 最久的一件已经等了 ${oldest > 0 ? `${oldest} 天` : '不足 1 天'}`
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
  toolbar.append(refresh, repoFetchWindowControl(snapshot.repoFetchWindow ?? DEFAULT_REPO_FETCH_WINDOW, handlers.setWindow, snapshot.refreshing), listSortControl('waiting', handlers.order, handlers.sort), ignored)
  if (snapshot.refreshing) {
    toolbar.append(el('span', {
      class: 'waiting-stamp refresh-elapsed', 'data-refresh-elapsed': '', 'aria-live': 'off'
    }, ['已用 0 秒']))
  }

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
    page.append(el('p', { class: 'waiting-loading', role: 'status' }, [
      snapshot.auth === 'unknown' ? '正在检查 GitHub 认证…' : '正在刷新…'
    ]))
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
  bindExclusiveRowActions(page, '.waiting-row')
  host.replaceChildren(page)
  return page
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
  comment: (rowId: string, action: ApoQuickAction, checkOnly?: boolean) => void
  commentState: (action: ApoQuickAction) => { busy: boolean, message: string, blocked: boolean }
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
  details.append(el('p', { class: 'hint' }, ['只有「只是提及」。不计入上面的待处理件数。']))
  const list = el('div', { class: 'maybe-list' })
  for (const row of rows) list.append(renderRow(row, handlers))
  details.append(list)
  return details
}

function renderGroups(rows: readonly WaitingRow[], handlers: {
  comment: (rowId: string, action: ApoQuickAction, checkOnly?: boolean) => void
  commentState: (action: ApoQuickAction) => { busy: boolean, message: string, blocked: boolean }
  snooze: (id: string, days: 1 | 3 | 7) => void
  ignore: (id: string) => void
  restore: (id: string) => void
  hideRepo: (repo: string) => void
  open: (url: string) => void
  todos: () => void
}): HTMLElement {
  const list = el('div', { class: 'waiting-groups' })
  for (const row of rows) list.append(renderRow(row, handlers))
  return list
}

function renderRow(row: WaitingRow, handlers: {
  comment: (rowId: string, action: ApoQuickAction, checkOnly?: boolean) => void
  commentState: (action: ApoQuickAction) => { busy: boolean, message: string, blocked: boolean }
  snooze: (id: string, days: 1 | 3 | 7) => void
  ignore: (id: string) => void
  restore: (id: string) => void
  hideRepo: (repo: string) => void
  open: (url: string) => void
  todos: () => void
}): HTMLElement {
  const age = band(row.waitingDays)
  const duration = row.waitingDays > 0 ? { value: row.waitingDays, unit: '天' } : elapsedTime(row.waitingSince, new Date())
  const ageText = !duration ? '不足 1 天' : duration.unit === '刚刚' ? '刚刚' : `${duration.value} ${duration.unit}`
  const days = el('span', {
    class: `days days-${age}`,
    title: `${row.daysEstimated ? '估算等待时长' : '从原因发生时算起'}${row.waitingSince ? ` · ${localAbsolute(row.waitingSince)}` : ''}`
  }, [
    row.daysEstimated ? '约' : '',
    ageText
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
  const family = [
    row.parentNumber != null ? `属于 #${row.parentNumber}` : '',
    row.childCount > 0 ? `含 ${row.childCount} 个子项` : ''
  ].filter(Boolean).join(' ')
  const meta = el('span', { class: 'waiting-meta waiting-identity' }, [
    el('strong', { class: 'waiting-repo' }, [row.repo]),
    ...(row.number === null ? [] : [el('strong', { class: 'waiting-number' }, [`#${row.number}`])]),
    ...(family ? [el('span', { class: 'waiting-family' }, [family])] : [])
  ])
  meta.title = `最近活动 ${localAbsolute(row.updatedAt)}`
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
  const ownLabel = ownRequestLabel(row)
  const reason = excerpt
    ? el('p', { class: 'waiting-reason' }, [
      ...(ownLabel ? [el('span', { class: 'chip chip-own' }, [ownLabel])] : []),
      excerpt
    ])
    : row.tier === 'weak'
      ? null
      : el('p', { class: 'waiting-reason' }, [row.reasons.join(' · ') || '等待'])
  const quick = el('div', { class: 'apo-quick-actions' })
  if (row.tier !== 'weak' && !row.ignored) for (const action of row.quickActions ?? []) {
    const state = handlers.commentState(action)
    const button = el('button', {
      type: 'button', class: 'ghost apo-comment-button', 'data-apo-action': action.id,
      title: `以 @${action.viewerLogin} 向 ${action.target.repo} #${action.target.number} 评论：${action.token}\n请求：${action.requestText}`
    }, [state.busy ? '正在评论…' : action.token])
    button.disabled = state.busy || state.blocked
    button.addEventListener('click', () => handlers.comment(row.id, action))
    const target = el('button', { type: 'button', class: 'ghost tiny apo-target' }, [`${action.target.repo} #${action.target.number}`])
    target.addEventListener('click', () => handlers.open(action.target.url))
    const controls: Node[] = [button, target]
    if (!state.busy && (action.state === 'unknown' || state.message.includes('核对 GitHub'))) {
      const check = el('button', { type: 'button', class: 'ghost tiny apo-check' }, ['核对评论结果'])
      check.title = '只读取 GitHub 评论，不重新发送'
      check.addEventListener('click', () => handlers.comment(row.id, action, true))
      controls.push(check)
    }
    controls.push(el('span', { class: 'apo-comment-status', role: 'status' }, [state.message]))
    quick.append(el('div', { class: 'apo-action' }, controls))
  }
  return el('div', {
    class: `waiting-row age-${age}${row.ignored ? ' is-ignored' : ''}`,
    'data-row-id': row.id
  }, [...body, reason, ...(quick.childElementCount ? [quick] : [])].filter((node): node is Node | string => node != null))
}

export async function renderWaiting(
  host: HTMLElement,
  navigate: (view: 'settings' | 'todos', options?: { focusToken?: boolean }) => void
): Promise<void> {
  const loading: WaitingSnapshot = {
    rows: [],
    refreshedAt: null,
    refreshing: true,
    auth: 'unknown',
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
  let current = loading
  let requestVersion = 0
  let refreshing = false
  let order = readListOrder('waiting')
  const commentStates = new Map<string, { busy: boolean, message: string, blocked: boolean }>()
  const refreshStatus = createRefreshStatus(host)
  const apply = (snapshot: WaitingSnapshot) => {
    if (!refreshStatus.ownsPage()) return
    current = snapshot
    refreshStatus.attach(paint(host, snapshot, {
      order,
      sort: value => { order = value; apply(current) },
      comment: (rowId, action, checkOnly) => { void comment(rowId, action, checkOnly) },
      commentState: action => commentStates.get(action.id) ?? {
        busy: false, blocked: Boolean(action.state) || snapshot.auth !== 'ok', message: action.state === 'sent' ? '已评论' : action.state === 'unknown' ? '结果待核实，请先核对 GitHub' : ''
      },
      refresh: () => { void reload() },
      setWindow: value => { void setWindow(value) },
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
    }))
  }
  const comment = async (rowId: string, action: ApoQuickAction, checkOnly = false) => {
    if (!refreshStatus.ownsPage() || commentStates.get(action.id)?.busy) return
    commentStates.set(action.id, { busy: true, message: '', blocked: true })
    apply(current)
    try {
      const result = await (checkOnly ? window.arckeep.checkWaitingApo(rowId, action.id) : window.arckeep.commentWaitingApo(rowId, action.id))
      const unknown = result.ok && result.data.state === 'unknown'
      commentStates.set(action.id, {
        busy: false, blocked: result.ok || checkOnly || Boolean(action.state),
        message: result.ok ? (unknown ? '结果待核实，请先核对 GitHub' : '已评论') : result.error
      })
    } catch {
      commentStates.set(action.id, { busy: false, blocked: true, message: '未收到结果，请先核对 GitHub，勿重复评论' })
    }
    apply(current)
  }
  const act = async (call: (api: Window['arckeep']) => Promise<{ ok: boolean, error?: string, data?: WaitingSnapshot }>) => {
    const result = await call(window.arckeep)
    if (result.ok && result.data) apply({ ...result.data, refreshing: refreshing || result.data.refreshing })
  }
  const setWindow = async (value: RepoFetchWindow) => {
    if (!refreshStatus.ownsPage() || current.refreshing) return
    const previous = current
    apply({ ...current, refreshing: true })
    try {
      const result = await window.arckeep.setRepoFetchWindow(value)
      if (!result.ok) throw new Error(result.error)
      current = { ...current, rows: [], refreshedAt: null, repoFetchWindow: value }
      await reload()
    } catch (error) {
      apply({ ...previous, refreshing: false, sourceErrors: [{ source: '查询范围', message: error instanceof Error ? error.message : '查询范围保存失败' }] })
    }
  }
  const reload = async (force = true) => {
    if (!refreshStatus.ownsPage()) return
    const version = ++requestVersion
    const finish = refreshStatus.start()
    refreshing = true
    apply({
      ...current,
      refreshing: true,
      auth: current.auth === 'ok' ? 'ok' : 'unknown',
      sourceErrors: current.auth === 'missing' || current.auth === 'invalid' ? [] : current.sourceErrors
    })
    try {
      const snapshot = await window.arckeep.refreshWaiting(force)
      if (version === requestVersion) apply(snapshot)
    } catch (error) {
      if (version !== requestVersion) return
      apply({
        ...current,
        refreshing: false,
        sourceErrors: [{ source: '刷新', message: error instanceof Error ? error.message : '刷新失败' }]
      })
    } finally {
      if (version === requestVersion) refreshing = false
      finish()
    }
  }
  const finishLoading = refreshStatus.start()
  apply(loading)
  try {
    apply(await window.arckeep.getWaiting())
  } catch {
    // A missing cache does not prevent a fresh request.
  } finally {
    finishLoading()
  }
  if (refreshStatus.ownsPage()) await reload(false)
}
