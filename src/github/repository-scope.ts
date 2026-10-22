import { githubData, githubErrorMessages } from './client.js'

/** Scope reads must not turn a partial API failure into a successful empty scan. */
export function repositoryScopeData(payload: unknown): Record<string, unknown> {
  const errors = githubErrorMessages(payload)
  const partial = !!payload && typeof payload === 'object' && 'errors' in payload
    && payload.errors !== undefined && (!Array.isArray(payload.errors) || payload.errors.length > 0)
  if (partial) throw new Error(`仓库范围读取失败：${errors.map(error => error.message).join('；') || 'GitHub 返回了不完整的范围数据'}`)
  return githubData(payload)
}

export function repositoryScopePage(value: unknown): { nodes: unknown[], cursor: string | null } {
  if (!value || typeof value !== 'object' || !('nodes' in value) || !Array.isArray(value.nodes)
    || !('pageInfo' in value) || !value.pageInfo || typeof value.pageInfo !== 'object'
    || !('hasNextPage' in value.pageInfo) || typeof value.pageInfo.hasNextPage !== 'boolean'
    || value.pageInfo.hasNextPage && (!('endCursor' in value.pageInfo) || typeof value.pageInfo.endCursor !== 'string' || !value.pageInfo.endCursor)) {
    throw new Error('GitHub 返回的仓库范围数据不完整，已保留上次结果')
  }
  return { nodes: value.nodes, cursor: value.pageInfo.hasNextPage && 'endCursor' in value.pageInfo && typeof value.pageInfo.endCursor === 'string' ? value.pageInfo.endCursor : null }
}
