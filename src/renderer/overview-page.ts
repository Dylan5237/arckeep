import { isStaleGroup, overviewCounts } from '../shared/overview/classify'
import { canRemoveFromWatchList, overviewMetaText, visibleWarningChips } from '../shared/overview/present'
import { localAbsolute, localClock, relativeLabel } from '../shared/waiting/local-time'
import type { OverviewRow, OverviewSnapshot, OverviewWarning } from '../shared/overview/types'

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
  refresh: () => void
  settings: () => void
  focusWatch: () => void
  open: (url: string) => void
  remove: (name: string) => void
}): void {
  const archived = snapshot.rows.filter(row => row.archived)
  const visible = snapshot.rows.filter(row => !row.archived)
  const active = visible.filter(row => !isStaleGroup(row))
  const stale = visible.filter(row => isStaleGroup(row))
  const counts = overviewCounts(snapshot.rows)
  const refreshed = snapshot.refreshedAt
    ? relativeLabel(snapshot.refreshedAt, new Date())
    : '尚未刷新'
  const stamp = el('span', { class: 'waiting-stamp' }, [`上次刷新 ${refreshed}`])
  if (snapshot.refreshedAt) stamp.title = localAbsolute(snapshot.refreshedAt)
  const toolbar = el('div', { class: 'waiting-toolbar' })
  if (counts.repos > 0 || archived.length > 0) {
    toolbar.append(el('p', { class: 'waiting-summary' }, [
      `${counts.repos} 个仓库 · ${counts.attention} 个需要看一眼`
    ]))
  }
  toolbar.append(stamp)
  const refresh = el('button', { type: 'button', class: 'primary' }, [snapshot.refreshing ? '正在刷新' : '刷新'])
  const authBlocked = snapshot.auth === 'missing' || snapshot.auth === 'invalid'
  refresh.disabled = snapshot.refreshing || authBlocked
  refresh.addEventListener('click', handlers.refresh)
  toolbar.append(refresh)

  const page = el('section', { class: 'page overview' }, [
    el('h1', {}, ['项目总览']),
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
    page.append(el('div', { class: 'alert error', role: 'status' }, [`${error.source}：${error.message}`]))
  }
  if (snapshot.refreshing && snapshot.rows.length === 0) {
    page.append(el('p', { class: 'waiting-loading', role: 'status' }, ['正在刷新…']))
  } else if (!snapshot.refreshing && counts.repos === 0 && archived.length === 0 && snapshot.auth === 'ok') {
    const add = el('button', { type: 'button', class: 'primary' }, ['去设置添加关注的仓库'])
    add.addEventListener('click', handlers.focusWatch)
    page.append(el('div', { class: 'overview-empty' }, [
      el('p', {}, ['还没有可显示的仓库']),
      add
    ]))
  } else if (counts.repos > 0 || archived.length > 0) {
    const list = el('div', { class: 'overview-list' })
    for (const row of active) list.append(renderRow(row, handlers))
    page.append(list)
    if (stale.length > 0) page.append(renderStale(stale, handlers))
    if (archived.length > 0) page.append(renderArchived(archived, handlers))
  }
  host.replaceChildren(page)
}

function renderArchived(rows: readonly OverviewRow[], handlers: RowHandlers): HTMLElement {
  const details = el('details', { class: 'archived-group' })
  details.append(el('summary', {}, [`已归档 · ${rows.length}`]))
  for (const row of rows) details.append(renderRow(row, handlers))
  return details
}

function renderStale(rows: readonly OverviewRow[], handlers: RowHandlers): HTMLElement {
  const details = el('details', { class: 'stale-group' })
  const summary = el('summary', {}, [`陈旧 · ${rows.length}`])
  details.append(summary)
  for (const row of rows) details.append(renderRow(row, handlers))
  return details
}

interface RowHandlers {
  open: (url: string) => void
  remove: (name: string) => void
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
  if (row.lastCommitAt) meta.title = localAbsolute(row.lastCommitAt)
  const children: Array<Node | string> = [title, chips, meta]
  if (canRemoveFromWatchList(row)) {
    const remove = el('button', { type: 'button', class: 'ghost tiny overview-remove' }, ['从关注列表移除'])
    remove.addEventListener('click', () => { void handlers.remove(row.name) })
    children.push(remove)
  }
  return el('div', { class: `overview-row${row.error ? ' is-error' : ''}` }, children)
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
  navigate: (view: 'settings', options?: { focusToken?: boolean, focusWatch?: boolean }) => void
): Promise<void> {
  const loading: OverviewSnapshot = {
    rows: [],
    refreshedAt: null,
    refreshing: true,
    auth: 'ok',
    rateLimitResetAt: null,
    sourceErrors: [],
    notices: []
  }
  const apply = (snapshot: OverviewSnapshot) => {
    paint(host, snapshot, {
      refresh: () => { void reload() },
      settings: () => navigate('settings', { focusToken: true }),
      focusWatch: () => navigate('settings', { focusWatch: true }),
      open: url => { void window.arckeep.openExternal(url) },
      remove: name => { void removeWatched(name) }
    })
  }
  const removeWatched = async (name: string) => {
    const state = await window.arckeep.getState()
    const next = state.watchedRepos.filter(item => item.toLowerCase() !== name.toLowerCase())
    const result = await window.arckeep.setRepos(next)
    if (!result.ok) return
    await reload()
  }
  const reload = async () => {
    apply({ ...loading, refreshing: true, rows: [] })
    try {
      apply(await window.arckeep.refreshOverview())
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
