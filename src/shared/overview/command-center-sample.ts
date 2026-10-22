import { readCommandCenter } from './command-center.js'
import { retainCommandCenter } from './command-center-types.js'
import type { OverviewRow } from './types.js'

/** Fictional screenshot data. Never query or write these sample repositories. */
export function sampleCommandCenterRows(errors = false): OverviewRow[] {
  const checkedAt = '2026-10-12T02:10:00.000Z'
  const projects = [
    ['lumen', 'verification', '#42 · 工具首次接入', '真实客户端验证、PHASE ACCEPT', '请拍板人检查现场证据，再决定是否接受当前阶段。'],
    ['keel', 'blocked', '#63 · 合同调整', '#67 合同例外待 EXCEPTION ACCEPT；原冻结合同继续有效', '请拍板人审阅 #67 的影响与风险，决定是否接受合同变更。'],
    ['moor', 'implementation', '#18 · 跨项目检索', '实现与独立验证尚未完成', '实现项目索引读取，补充检索准确性的验证证据。'],
    ['tidal', '', '', '', '']
  ]
  return projects.map(([slug, status, phase, gates, next], index) => {
    const name = `harbor/${slug}`
    const url = `https://github.com/${name}`
    const stamp = new Date(Date.parse(checkedAt) - index * 15 * 60_000).toISOString()
    const body = `## 1. One-glance / 一眼状态
| Field | Value |
| --- | --- |
| Current phase | ${phase} |
| Status word | ${status} |
| Last closed phase | #12 |
| Open gates | ${gates} |
| Single Next Action | ${next} |

Updated: 2026-10-12. Chat ≠ State.

## Phase index
| Phase issue | Core problem | Status | Result |
| --- | --- | --- | --- |
| #12 | 基础能力接入 | done | 总控台记录已关闭 |
| ${phase} | 当前阶段的核心问题 | ${status} | 本阶段尚未 PHASE ACCEPT |
| #90 | 后续扩展 | backlog | 待冻结 |
`
    const center = { number: 1, title: `[Command Center] ${slug}`, url: `${url}/issues/1`, updatedAt: checkedAt, state: 'OPEN', body }
    const connection = { nodes: status ? [center] : [], totalCount: status ? 1 : 0, pageInfo: { hasNextPage: false } }
    let commandCenter = readCommandCenter({ repo: name, labeled: connection, english: { nodes: [], issueCount: 0, pageInfo: { hasNextPage: false } }, chinese: { nodes: [], issueCount: 0, pageInfo: { hasNextPage: false } }, checkedAt })
    if (errors && index === 0) commandCenter = retainCommandCenter(commandCenter, '网络连接超时', checkedAt)
    if (errors && index === 1) commandCenter = { kind: 'ambiguous', candidates: [center, { ...center, number: 2, url: `${url}/issues/2`, title: '[Command Center] 旧控制面仍开放' }], truncated: false, checkedAt }
    if (errors && index === 2) commandCenter = { kind: 'unsupported', source: center, message: '未识别唯一的当前状态摘要，请查看原总控台', checkedAt }
    return {
      name, url, lastCommitAt: stamp, lastActivityAt: stamp, openPrCount: index === 0 ? 1 : 0, ciState: 'success', warnings: [],
      group: 'active', archived: false, error: null, commandCenter,
      stallBasis: { at: stamp, source: 'commit', lastCommitAt: stamp, lastIssueActivityAt: null }
    }
  })
}
