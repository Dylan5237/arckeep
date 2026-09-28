import { isStaleGroup } from '../shared/overview/classify'
import { localAbsolute, localClock, relativeLabel } from '../shared/waiting/local-time'
import type { CiState, OverviewRow, OverviewSnapshot, OverviewWarning } from '../shared/overview/types'

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
  '空仓': 'empty',
  '陈旧': 'stale'
}

const CI_LABEL: Record<CiState, string> = {
  success: '通过',
  failure: '失败',
  pending: '进行中',
  none: '无检查',
  unknown: '未知'
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

function pullNumber(url: string): string {
  const match = url.match(/\/pull\/(\d+)/)
  return match?.[1] ? `#${match[1]}` : ''
}

function paint(host: HTMLElement, snapshot: OverviewSnapshot, handlers: {
  refresh: () => void
  settings: () => void
  open: (url: string) => void
}): void {
  const active = snapshot.rows.filter(row => !isStaleGroup(row))
  const stale = snapshot.rows.filter(row => isStaleGroup(row))
  const warned = snapshot.rows.filter(row => row.warnings.length > 0 || row.error).length
  const summary = snapshot.rows.length === 0
    ? '打开这一页就会刷新。关注列表留空时走自动模式。'
    : `${snapshot.rows.length} 个仓库 · ${warned} 个需要看一眼`
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
  } else if (!snapshot.refreshing && snapshot.rows.length === 0 && snapshot.auth === 'ok') {
    page.append(el('p', { class: 'waiting-empty' }, ['没有可显示的仓库']))
  } else if (snapshot.rows.length > 0) {
    const list = el('div', { class: 'overview-list' })
    for (const row of active) list.append(renderRow(row, handlers.open))
    page.append(list)
    if (stale.length > 0) page.append(renderStale(stale, handlers.open))
  }
  host.replaceChildren(page)
}

function renderStale(rows: readonly OverviewRow[], open: (url: string) => void): HTMLElement {
  const details = el('details', { class: 'stale-group' })
  const summary = el('summary', {}, [`陈旧 · ${rows.length}`])
  details.append(summary)
  for (const row of rows) details.append(renderRow(row, open))
  return details
}

function renderRow(row: OverviewRow, open: (url: string) => void): HTMLElement {
  const title = el('button', {
    type: 'button',
    class: 'waiting-title',
    title: '在浏览器中打开'
  }, [
    el('span', { class: 'waiting-title-text' }, [row.name]),
    externalIcon()
  ])
  title.addEventListener('click', () => open(row.url))
  const chips = el('span', { class: 'reason-chips' })
  for (const item of row.warnings) chips.append(...warningChips(item, open))
  if (!row.error && row.ciState !== 'unknown') {
    chips.append(el('span', { class: `chip chip-ci chip-ci-${row.ciState}` }, [CI_LABEL[row.ciState]]))
  }
  const metaText = row.error
    ? row.error
    : row.lastCommitAt
      ? `${relativeLabel(row.lastCommitAt, new Date())} · ${row.openPrCount} 个 open PR`
      : `尚无提交 · ${row.openPrCount} 个 open PR`
  const meta = el('span', { class: row.error ? 'waiting-meta overview-error' : 'waiting-meta' }, [metaText])
  if (row.lastCommitAt) meta.title = localAbsolute(row.lastCommitAt)
  return el('div', { class: `overview-row${row.error ? ' is-error' : ''}` }, [
    title,
    chips,
    meta
  ])
}

function warningChips(warning: OverviewWarning, open: (url: string) => void): HTMLElement[] {
  const kind = CHIP_CLASS[warning.kind] ?? 'other'
  if (warning.targets.length === 0) {
    return [el('span', { class: `chip chip-${kind}` }, [warning.kind])]
  }
  return warning.targets.map(target => {
    const label = warning.kind === '卡住' ? `卡住 ${pullNumber(target.url)}`.trim() : warning.kind
    const chip = el('button', {
      type: 'button',
      class: `chip chip-${kind}`,
      title: target.url
    }, [label])
    chip.addEventListener('click', () => open(target.url))
    return chip
  })
}

export async function renderOverview(
  host: HTMLElement,
  navigate: (view: 'settings', options?: { focusToken?: boolean }) => void
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
      open: url => { void window.arckeep.openExternal(url) }
    })
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
