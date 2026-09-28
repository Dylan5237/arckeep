export function requireSender(
  event: { sender: { id: number } },
  expectedWebContents: { id: number } | null | undefined
): void {
  if (!expectedWebContents || event.sender.id !== expectedWebContents.id) {
    throw new Error('Blocked IPC from an unexpected renderer')
  }
}

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

export function normalizeWatchedRepos(input: unknown): string[] {
  if (!Array.isArray(input)) throw new Error('关注仓库列表无效')
  if (input.length > 200) throw new Error('关注仓库过多')
  const repos: string[] = []
  for (const item of input) {
    if (typeof item !== 'string') throw new Error('关注仓库无效')
    const value = item.trim()
    if (!value) continue
    if (value.length > 200 || !REPO_PATTERN.test(value)) {
      throw new Error(`关注仓库格式应为 owner/repo：${value}`)
    }
    if (!repos.includes(value)) repos.push(value)
  }
  return repos
}

export function normalizePat(input: unknown): string {
  if (typeof input !== 'string') throw new Error('PAT 无效')
  const token = input.trim()
  if (!token) throw new Error('PAT 不能为空')
  if (token.length > 512) throw new Error('PAT 过长')
  if (/\s/.test(token)) throw new Error('PAT 不能包含空白字符')
  return token
}
