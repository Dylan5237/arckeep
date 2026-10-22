import { sampleWaitingRows } from '../shared/waiting/sample.js'
import type { WaitingSnapshot } from '../shared/waiting/types.js'
import type { IpcResult } from '../shared/types.js'
import type { ScreenshotScene } from './screenshot-scene.js'
import { pendingApoActions } from '../shared/waiting/apo-actions.js'
import { pendingApoDecisionActions } from '../shared/waiting/apo-reply.js'
import { blankRecord } from '../shared/waiting/parse-github.js'

function base(partial: Partial<WaitingSnapshot>): WaitingSnapshot {
  return {
    rows: [],
    refreshedAt: '2026-09-28T09:40:00.000Z',
    refreshing: false,
    auth: 'ok',
    rateLimitResetAt: null,
    sourceErrors: [],
    notices: [],
    showIgnored: false,
    hiddenCount: 3,
    hiddenRepos: [],
    todosAvailable: false,
    maybeWhenEmpty: null,
    maybeWhenListed: null,
    ...partial
  }
}

export function screenshotWaitingSnapshot(scene: ScreenshotScene): WaitingSnapshot {
  if (scene === 'waiting-apo' || scene === 'waiting-apo-narrow') {
    const now = Date.now()
    const sample = sampleWaitingRows()[0]!
    const rows = [
      { number: 42, minutes: 92, token: 'FREEZE ACK', repo: 'northwind/workbench', title: '确认下一阶段的范围与验收标准' },
      { number: 87, minutes: 8, token: 'EXCEPTION ACCEPT', repo: 'northwind/agent-project', title: '合同变更：确认接口调整的影响与处理方式' },
      { number: 63, minutes: 38, token: 'PHASE ACCEPT', repo: 'northwind/workbench', title: '验证材料已齐，等待阶段验收' }
    ].map(item => {
      const at = new Date(now - item.minutes * 60_000).toISOString()
      const url = `https://github.com/${item.repo}/issues/${item.number}`
      const text = `请处置人 @mock-user 在本 Issue 评论 ${item.token}。`
      return { ...sample, id: `${item.repo}#${item.number}`, repo: item.repo, number: item.number, type: 'issue' as const,
        title: item.title, url, updatedAt: at, waitingSince: at, waitingDays: 0, daysEstimated: false,
        tier: 'strong' as const, ignored: false, parent: null, parentNumber: null, childCount: 0,
        reasons: ['要人动手'], action: '要你动手', signalText: text, ownRequest: false,
        quickActions: pendingApoActions(blankRecord({ repo: item.repo, number: item.number, kind: 'issue', title: item.title,
          url, body: text, createdAt: at, updatedAt: at, viewerLogin: 'mock-user', commentsTruncated: false })) }
    })
    const decisionAt = new Date(now - 21 * 60_000).toISOString()
    const decisionUrl = 'https://github.com/northwind/workbench/issues/71'
    const decisionBody = '<!-- apo-decision v1 | id: D-4 | rev: 1 | type: 最终验收 | target: #71 | disposer: @mock-user -->\n请验收：导出报表已按验收标准完成。'
    rows.push({ ...sample, id: 'northwind/workbench#71', repo: 'northwind/workbench', number: 71, type: 'issue' as const,
      title: '导出报表：等待最终验收', url: decisionUrl, updatedAt: decisionAt, waitingSince: decisionAt, waitingDays: 0, daysEstimated: false,
      tier: 'strong' as const, ignored: false, parent: null, parentNumber: null, childCount: 0,
      reasons: ['要人动手'], action: '要你动手', signalText: '请验收：导出报表已按验收标准完成。', ownRequest: false,
      quickActions: [], decisionActions: pendingApoDecisionActions(blankRecord({ repo: 'northwind/workbench', number: 71, kind: 'issue',
        title: '导出报表：等待最终验收', url: decisionUrl, body: decisionBody, createdAt: decisionAt, updatedAt: decisionAt,
        viewerLogin: 'mock-user', commentsTruncated: false })) })
    return base({ rows, hiddenCount: 0, refreshedAt: new Date(now).toISOString() })
  }
  if (scene === 'waiting' || scene === 'waiting-narrow' || scene === 'waiting-hover' || scene === 'waiting-ignore' || scene === 'waiting-related' || scene === 'waiting-related-open') {
    const rows = sampleWaitingRows().sort((left, right) => right.waitingDays - left.waitingDays || left.title.localeCompare(right.title))
    return base({ rows, hiddenCount: 4 })
  }
  if (scene === 'waiting-watch') {
    const rows = sampleWaitingRows()
      .filter(row => row.repo === 'northwind/ledger')
      .slice(0, 3)
      .map((row, index) => index === 2
        ? { ...row, repo: 'stranger/public', title: '指派给你的那一条', reasons: ['指派'], action: '要你动手', type: 'issue' as const }
        : row)
    return base({
      rows,
      hiddenCount: 0,
      notices: []
    })
  }
  if (scene === 'waiting-family') {
    const repo = 'northwind/ledger'
    const parent = sampleWaitingRows().find(row => row.type === 'issue')
    const baseRow = parent ?? sampleWaitingRows()[0]
    if (!baseRow) return base({ hiddenCount: 0, rows: [] })
    const child = (number: number, title: string, days: number): typeof baseRow => ({
      ...baseRow,
      id: `sample:${repo}#${number}`,
      repo,
      number,
      type: 'issue',
      title,
      url: `https://github.com/${repo}/issues/${number}`,
      reasons: ['要人动手'],
      action: '要你动手',
      waitingDays: days,
      daysEstimated: false,
      parentNumber: 40,
      parent: `https://github.com/${repo}/issues/40`,
      childCount: 0,
      tier: 'strong',
      ignored: false
    })
    return base({
      hiddenCount: 0,
      rows: [
        {
          ...baseRow,
          id: `sample:${repo}#40`,
          repo,
          number: 40,
          type: 'issue',
          title: '确认导出范围',
          url: `https://github.com/${repo}/issues/40`,
          reasons: ['要人动手'],
          action: '要你动手',
          waitingDays: 6,
          daysEstimated: false,
          parentNumber: null,
          parent: null,
          childCount: 2,
          tier: 'strong',
          ignored: false
        },
        child(41, '核对导出的列名', 4),
        child(42, '看空状态的截图', 2)
      ]
    })
  }
  if (scene === 'waiting-hidden') {
    const rows = sampleWaitingRows().sort((left, right) => right.waitingDays - left.waitingDays || left.title.localeCompare(right.title))
    const todo = rows.find(row => row.type === 'todo')
    const others = rows.filter(row => row !== todo)
    const faded = [
      ...(todo ? [{ ...todo, ignored: true, title: '把等我的待办先放下', action: '待办', reasons: ['待办'], waitingDays: 20 }] : []),
      ...others.slice(0, 3).map(row => ({ ...row, ignored: true }))
    ]
    return base({
      rows: [...faded, ...others.slice(3, 14)],
      showIgnored: true,
      hiddenCount: faded.length,
      hiddenRepos: ['stranger/public'],
      todosAvailable: true
    })
  }
  if (scene === 'waiting-maybe-only' || scene === 'waiting-maybe-collapsed') {
    const rows = sampleWaitingRows().filter(row => row.tier === 'weak')
    return base({
      rows,
      hiddenCount: 0,
      maybeWhenEmpty: scene === 'waiting-maybe-collapsed' ? false : null
    })
  }
  if (scene === 'waiting-empty') return base({ hiddenCount: 0, rows: [] })
  if (scene === 'waiting-no-token') return base({ auth: 'missing', refreshedAt: null, hiddenCount: 0 })
  if (scene === 'waiting-invalid-token') return base({ auth: 'invalid', refreshedAt: null, hiddenCount: 0 })
  if (scene === 'waiting-loading') return base({ refreshing: true, refreshedAt: null, hiddenCount: 0 })
  if (scene === 'waiting-auth-checking') return base({ auth: 'unknown', refreshing: true, refreshedAt: null, hiddenCount: 0 })
  if (scene === 'waiting-rate-limit') {
    const rows = sampleWaitingRows().sort((left, right) => right.waitingDays - left.waitingDays).slice(0, 8)
    return base({
      rows,
      rateLimitResetAt: '2026-09-28T18:30:00.000Z',
      sourceErrors: [{ source: '提及', message: 'GitHub 速率限制，本页保留上次结果' }]
    })
  }
  return base({ hiddenCount: 0 })
}

export function createScreenshotWaiting(scene: ScreenshotScene): {
  current: () => WaitingSnapshot
  refresh: () => Promise<WaitingSnapshot>
  snooze: (id?: unknown, days?: unknown) => IpcResult<WaitingSnapshot>
  ignore: (id?: unknown) => IpcResult<WaitingSnapshot>
  restore: (id?: unknown) => IpcResult<WaitingSnapshot>
  hideRepo: (repo?: unknown) => IpcResult<WaitingSnapshot>
  unhideRepo: (repo?: unknown) => IpcResult<WaitingSnapshot>
  setShowIgnored: (value?: unknown) => IpcResult<WaitingSnapshot>
  setMaybeSectionOpen: (open?: unknown) => IpcResult<WaitingSnapshot>
  advanceDays: (days?: unknown) => IpcResult<WaitingSnapshot>
  observedGithubRepos: () => readonly string[]
  observedLocalLinks: () => readonly { github: string, path: string }[]
} {
  const snapshot = screenshotWaitingSnapshot(scene)
  const refresh = scene === 'waiting-loading' || scene === 'waiting-auth-checking'
    ? () => new Promise<WaitingSnapshot>(() => {})
    : () => Promise.resolve(snapshot)
  const ok = (): IpcResult<WaitingSnapshot> => ({ ok: true, data: snapshot })
  return {
    current: () => snapshot,
    refresh,
    snooze: () => ok(),
    ignore: () => ok(),
    restore: () => ok(),
    hideRepo: () => ok(),
    unhideRepo: () => ok(),
    setShowIgnored: () => ok(),
    setMaybeSectionOpen: open => {
      if (typeof open !== 'boolean') return { ok: false, error: '展开状态无效' }
      const mainCount = snapshot.rows.filter(row => row.tier !== 'weak').length
      const next = mainCount === 0
        ? { ...snapshot, maybeWhenEmpty: open }
        : { ...snapshot, maybeWhenListed: open }
      return { ok: true, data: next }
    },
    advanceDays: () => ({ ok: false, error: '测试钩子未开启' }),
    observedGithubRepos: () => [],
    observedLocalLinks: () => []
  }
}
