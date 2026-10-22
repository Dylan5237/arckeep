export const CC_REPO = 'example/project'
export const CC_NOW = '2026-10-12T03:00:00.000Z'
export const CC_BODY = `## 1. One-glance / 一眼状态

| Field | Value |
| --- | --- |
| **Current phase** | [Phase #42](https://github.com/example/project/issues/42)：快速接入 |
| **Status word** | verification |
| **Last closed phase** | #12 |
| **Open gates** | #43 合同例外待 EXCEPTION ACCEPT；用户现场验证未完成 |
| **Single Next Action** | 由拍板人审阅证据并决定是否 PHASE ACCEPT |

Updated: 2026-10-12. Chat ≠ State.

## Phase index

| Phase issue | Core problem | Status | Result |
| --- | --- | --- | --- |
| #12 | 基础接入 | done | 总控台记录已关闭 |
| #42 | 快速接入 | verification | 技术验证完成，未验收 |
| #44 | 后续扩展 | backlog | 待冻结 |

## Open exceptions / blocks

| Issue / block | Phase | Status |
| --- | --- | --- |
| [#43](https://github.com/example/project/issues/43) 合同变更 | #42 | DECISION PENDING |
`

export function ccNode(patch: Record<string, unknown> = {}) {
  return { number: 1, title: '[Command Center] example', url: `https://github.com/${CC_REPO}/issues/1`, updatedAt: CC_NOW, body: CC_BODY, state: 'OPEN', repository: { nameWithOwner: CC_REPO }, ...patch }
}

export function labelConnection(nodes: unknown[] = [], totalCount = nodes.length) {
  return { nodes, totalCount, pageInfo: { hasNextPage: totalCount > nodes.length } }
}
export function searchConnection(nodes: unknown[] = [], issueCount = nodes.length) {
  return { nodes, issueCount, pageInfo: { hasNextPage: issueCount > nodes.length } }
}
