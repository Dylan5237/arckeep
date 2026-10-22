import { overviewCounts } from '../shared/overview/classify'
import { canRemoveFromWatchList, overviewMetaText, visibleWarningChips } from '../shared/overview/present'
import { localAbsolute, localClock, relativeLabel } from '../shared/time'
import { orderList, type ListOrder } from '../shared/list-order'
import { listSortControl, readListOrder } from './list-sort'
import type { OverviewRow, OverviewSnapshot, OverviewWarning } from '../shared/overview/types'
import { createRefreshStatus } from './refresh-status'
import { commandCenterBadge, commandCenterPanel, progressCategory, type ProgressFilter } from './command-center-panel'
import { DEFAULT_REPO_FETCH_WINDOW, type RepoFetchWindow } from '../shared/repo-fetch-window'
import { repoFetchWindowControl } from './repo-fetch-window'

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

const CHIP_CLASS: Record<string, string> = {
  '卡住': 'stuck',
  '停滞': 'stalled',
  '空仓': 'empty'
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

function paint(host: HTMLElement, snapshot: OverviewSnapshot, handlers: {
  order: ListOrder
  filter: ProgressFilter
  setFilter: (filter: ProgressFilter) => void
  sort: (order: ListOrder) => void
  refresh: () => void
  setWindow: (value: RepoFetchWindow) => void
  settings: () => void
  focusWatch: () => void
  open: (url: string) => void
  remove: (name: string) => void
  startClaude: (repo: string, name: string) => void
  viewClaude: (repo: string) => void
}): HTMLElement {
  const sorted = orderList(snapshot.rows, handlers.order, {
    time: row => row.lastActivityAt ?? row.stallBasis?.at ?? row.lastCommitAt, name: row => row.name, id: row => row.name
  })
  const matches = (row: OverviewRow) => handlers.filter === 'all' || progressCategory(row.commandCenter) === handlers.filter
  const archived = sorted.filter(row => (row.archived || row.group === 'archived') && matches(row))
  const visible = sorted.filter(row => !row.archived && row.group !== 'archived' && matches(row))
  const active = visible.filter(row => row.group !== 'stale')
  const stale = visible.filter(row => row.group === 'stale')
  const counts = overviewCounts(snapshot.rows)
  const refreshed = snapshot.refreshedAt
    ? relativeLabel(snapshot.refreshedAt, new Date())
    : '尚未刷新'
  const stamp = el('span', { class: 'waiting-stamp' }, [`上次刷新 ${refreshed}`])
  if (snapshot.refreshedAt) stamp.title = localAbsolute(snapshot.refreshedAt)
  const toolbar = el('div', { class: 'waiting-toolbar' })
  if (counts.repos > 0 || archived.length > 0) {
    toolbar.append(el('p', { class: 'waiting-summary' }, [
      `${counts.repos} 个项目 · ${counts.attention} 个有仓库提醒`
    ]))
  }
  toolbar.append(stamp)
  const refresh = el('button', { type: 'button', class: 'primary' }, [snapshot.refreshing ? '正在刷新' : '刷新'])
  const authBlocked = snapshot.auth === 'missing' || snapshot.auth === 'invalid'
  refresh.disabled = snapshot.refreshing || authBlocked
  refresh.addEventListener('click', handlers.refresh)
  toolbar.append(refresh, repoFetchWindowControl(snapshot.repoFetchWindow ?? DEFAULT_REPO_FETCH_WINDOW, handlers.setWindow, snapshot.refreshing), listSortControl('overview', handlers.order, handlers.sort))
  if (snapshot.refreshing) {
    toolbar.append(el('span', {
      class: 'waiting-stamp refresh-elapsed', 'data-refresh-elapsed': '', 'aria-live': 'off'
    }, ['已用 0 秒']))
  }

  const page = el('section', { class: 'page overview' }, [
    el('h1', {}, ['项目总览']),
    toolbar
  ])
  page.append(el('p', { class: 'lede cc-board-lede' }, ['项目进度看板 · 当前阶段、门禁与下一动作来自各项目 Command Center']))
  if (snapshot.rows.length > 0) {
    const filters = el('div', { class: 'cc-board-filters', role: 'group', 'aria-label': '筛选项目进度' })
    const projects = snapshot.rows.filter(row => !row.archived && row.group !== 'archived')
    const options: Array<[ProgressFilter, string]> = [['all', '全部项目'], ['running', '实现中'], ['review', '验证 / 待验收'], ['blocked', '阻塞'], ['maintenance', '待核对']]
    for (const [value, label] of options) {
      const count = value === 'all' ? projects.length : projects.filter(row => progressCategory(row.commandCenter) === value).length
      const button = el('button', { type: 'button', class: 'cc-board-filter', 'aria-pressed': String(handlers.filter === value) }, [label, el('span', {}, [String(count)])])
      button.addEventListener('click', () => handlers.setFilter(value))
      filters.append(button)
    }
    page.append(filters)
  }
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
    page.append(el('div', { class: 'alert error', role: 'status' }, [`${error.source}：${error.message}`]))
  }
  if (snapshot.refreshing && snapshot.rows.length === 0) {
    page.append(el('p', { class: 'waiting-loading', role: 'status' }, [
      snapshot.auth === 'unknown' ? '正在检查 GitHub 认证…' : '正在刷新…'
    ]))
  } else if (!snapshot.refreshing && counts.repos === 0 && archived.length === 0 && snapshot.auth === 'ok') {
    const add = el('button', { type: 'button', class: 'primary' }, ['去设置添加关注的仓库'])
    add.addEventListener('click', handlers.focusWatch)
    page.append(el('div', { class: 'overview-empty' }, [
      el('p', {}, ['还没有可显示的仓库']),
      ...((snapshot.repoFetchWindow ?? DEFAULT_REPO_FETCH_WINDOW) !== 'all'
        ? [el('p', { class: 'hint' }, ['当前范围内没有符合条件的仓库；可扩大上方推送时间范围，检查历史项目。'])] : []),
      add
    ]))
  } else if (counts.repos > 0 || archived.length > 0) {
    if (active.length > 0) {
      const list = el('div', { class: 'overview-list cc-board-grid' })
      for (const row of active) list.append(renderRow(row, handlers))
      page.append(list)
    }
    if (stale.length > 0) page.append(renderStale(stale, handlers, handlers.filter !== 'all'))
    if (archived.length > 0) page.append(renderArchived(archived, handlers))
    if (active.length === 0 && stale.length === 0 && archived.length === 0) page.append(el('p', { class: 'overview-empty' }, ['没有符合当前筛选的项目']))
  }
  host.replaceChildren(page)
  return page
}

function renderArchived(rows: readonly OverviewRow[], handlers: RowHandlers): HTMLElement {
  const details = el('details', { class: 'archived-group' })
  details.append(el('summary', {}, [`已归档 · ${rows.length}`]))
  const grid = el('div', { class: 'cc-board-grid' })
  for (const row of rows) grid.append(renderRow(row, handlers))
  details.append(grid)
  return details
}

function renderStale(rows: readonly OverviewRow[], handlers: RowHandlers, open = false): HTMLElement {
  const details = el('details', { class: 'stale-group' })
  details.open = open
  const summary = el('summary', {}, [`陈旧 · ${rows.length}`])
  details.append(summary)
  const grid = el('div', { class: 'cc-board-grid' })
  for (const row of rows) grid.append(renderRow(row, handlers))
  details.append(grid)
  return details
}

interface RowHandlers {
  open: (url: string) => void
  remove: (name: string) => void
  startClaude: (repo: string, name: string) => void
  viewClaude: (repo: string) => void
}

function renderRow(row: OverviewRow, handlers: RowHandlers): HTMLElement {
  const title = el('button', {
    type: 'button',
    class: 'waiting-title',
    title: '在浏览器中打开'
  }, [
    el('span', { class: 'waiting-title-text' }, [row.name]),
    externalIcon()
  ])
  title.addEventListener('click', () => handlers.open(row.url))
  const chips = el('span', { class: 'reason-chips' })
  if (row.archived) {
    chips.append(el('span', { class: 'chip chip-archived' }, ['已归档']))
  } else {
    for (const item of visibleWarningChips(row)) chips.append(warningChip(item, handlers.open))
  }
  const meta = el('span', {
    class: row.error ? 'waiting-meta overview-error' : 'waiting-meta'
  }, [overviewMetaText(row, new Date())])
  const activity = row.lastActivityAt ?? row.lastCommitAt
  if (activity) meta.title = `最近活动 ${localAbsolute(activity)}${row.lastCommitAt ? ` · 最近提交 ${localAbsolute(row.lastCommitAt)}` : ''}`
  const health = el('details', { class: 'cc-health' }, [el('summary', {}, ['仓库状态']), chips, meta])
  if (canRemoveFromWatchList(row)) {
    const remove = el('button', { type: 'button', class: 'ghost tiny overview-remove' }, ['从关注列表移除'])
    remove.addEventListener('click', () => { void handlers.remove(row.name) })
    health.append(remove)
  }
  const claudeActions = el('div', { class: 'project-claude-actions' })
  const startClaude = el('button', { type: 'button', class: 'primary tiny', title: '在此项目目录打开 Claude' }, ['使用 Claude 工作'])
  startClaude.addEventListener('click', () => handlers.startClaude(row.name, row.name))
  const sessions = el('button', { type: 'button', class: 'ghost tiny', title: '查看此项目的 Claude 会话' }, ['会话'])
  sessions.addEventListener('click', () => handlers.viewClaude(row.name))
  claudeActions.append(startClaude, sessions)
  return el('article', { class: `overview-row project-card${row.error ? ' is-error' : ''}` }, [
    el('header', { class: 'project-card-head' }, [title, commandCenterBadge(row.commandCenter)]),
    commandCenterPanel(row.commandCenter, handlers.open), claudeActions, health
  ])
}

function warningChip(warning: OverviewWarning, open: (url: string) => void): HTMLElement {
  const kind = CHIP_CLASS[warning.kind] ?? 'other'
  const target = warning.targets[0]?.url
  if (!target) return el('span', { class: `chip chip-${kind}`, title: warning.hint }, [warning.label])
  const chip = el('a', {
    class: `chip chip-link chip-${kind}`,
    href: target,
    title: warning.hint
  }, [warning.label, externalIcon()])
  chip.addEventListener('click', event => {
    event.preventDefault()
    open(target)
  })
  return chip
}

export async function renderOverview(
  host: HTMLElement,
  navigate: (view: 'settings' | 'claude', options?: { focusToken?: boolean, focusWatch?: boolean, repo?: string, sessionId?: string }) => void
): Promise<void> {
  const loading: OverviewSnapshot = {
    rows: [],
    refreshedAt: null,
    refreshing: true,
    auth: 'unknown',
    rateLimitResetAt: null,
    sourceErrors: [],
    notices: []
  }
  let current = loading
  let requestVersion = 0
  let order = readListOrder('overview')
  let filter: ProgressFilter = 'all'
  const refreshStatus = createRefreshStatus(host)
  const showClaudeError = (message: string) => {
    host.querySelector('.project-claude-error')?.remove()
    const alert = el('p', { class: 'alert error project-claude-error', role: 'alert' }, [message])
    host.querySelector('.page.overview')?.prepend(alert)
  }
  const apply = (snapshot: OverviewSnapshot) => {
    if (!refreshStatus.ownsPage()) return
    current = snapshot
    refreshStatus.attach(paint(host, snapshot, {
      order,
      filter,
      setFilter: value => { filter = value; apply(current) },
      sort: value => { order = value; apply(current) },
      refresh: () => { void reload() },
      setWindow: value => { void setWindow(value) },
      settings: () => navigate('settings', { focusToken: true }),
      focusWatch: () => navigate('settings', { focusWatch: true }),
      open: url => { void window.arckeep.openExternal(url) },
    remove: name => { void removeWatched(name) },
    startClaude: (repo, name) => {
      void window.arckeep.startClaudeSession(repo, name).then(result => {
        if (!refreshStatus.ownsPage()) return
        if (result.ok) navigate('claude', { repo, sessionId: result.data.id })
        else showClaudeError(result.error)
      }).catch(error => {
        if (refreshStatus.ownsPage()) showClaudeError(error instanceof Error ? error.message : 'Claude 启动失败')
      })
    },
    viewClaude: repo => navigate('claude', { repo })
    }))
  }
  const removeWatched = async (name: string) => {
    const state = await window.arckeep.getState()
    const next = state.watchedRepos.filter(item => item.toLowerCase() !== name.toLowerCase())
    const result = await window.arckeep.setRepos(next)
    if (!result.ok) return
    await reload()
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
    apply({
      ...current,
      refreshing: true,
      auth: current.auth === 'ok' ? 'ok' : 'unknown',
      sourceErrors: current.auth === 'missing' || current.auth === 'invalid' ? [] : current.sourceErrors
    })
    try {
      const snapshot = await window.arckeep.refreshOverview(force)
      if (version === requestVersion) apply(snapshot)
    } catch (error) {
      if (version !== requestVersion) return
      apply({
        ...current,
        refreshing: false,
        sourceErrors: [{ source: '刷新', message: error instanceof Error ? error.message : '刷新失败' }]
      })
    } finally {
      finish()
    }
  }
  const finishLoading = refreshStatus.start()
  apply(loading)
  try {
    apply(await window.arckeep.getOverview())
  } catch {
    // A missing cache does not prevent a fresh request.
  } finally {
    finishLoading()
  }
  if (refreshStatus.ownsPage()) await reload(false)
}
