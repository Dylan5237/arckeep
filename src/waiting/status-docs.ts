import { matchStatusDocText } from '../shared/waiting/status-doc.js'
import { GithubAuthError, GithubRateLimitError, rateLimitFromResponse } from '../shared/waiting/rate-limit.js'
import type { SourceError, StatusDocHit, StatusDocRule } from '../shared/waiting/types.js'

async function githubText(token: string, url: string, fetchImpl: typeof fetch, accept: string): Promise<{ status: number, headers: Headers, text: string }> {
  let response: Response
  try {
    response = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: accept,
        'User-Agent': 'Arckeep',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : '网络错误'
    throw new Error(`连不上 GitHub：${message}`)
  }
  const text = await response.text()
  if (response.status === 401) throw new GithubAuthError()
  const resetAt = rateLimitFromResponse(response.status, response.headers, text)
  if (resetAt) throw new GithubRateLimitError(resetAt)
  if (!response.ok) throw new Error(`GitHub 返回 HTTP ${response.status}`)
  return { status: response.status, headers: response.headers, text }
}

function decodeContents(payload: string): string {
  const trimmed = payload.trim()
  if (!trimmed.startsWith('{')) return payload
  try {
    const json = JSON.parse(trimmed) as { content?: string, encoding?: string }
    if (json.encoding === 'base64' && typeof json.content === 'string') {
      return Buffer.from(json.content.replace(/\n/g, ''), 'base64').toString('utf8')
    }
  } catch {
    return payload
  }
  return payload
}

function ruleLabel(rule: StatusDocRule): string {
  return `${rule.repo}:${rule.target}`
}

export async function loadStatusDocs(options: {
  token: string
  rules: readonly StatusDocRule[]
  fetchImpl?: typeof fetch
}): Promise<{ hits: StatusDocHit[], errors: SourceError[] }> {
  const fetchImpl = options.fetchImpl ?? fetch
  const hits: StatusDocHit[] = []
  const errors: SourceError[] = []
  for (const rule of options.rules) {
    try {
      const issueNumber = /^#?(\d+)$/.exec(rule.target)
      if (issueNumber?.[1]) {
        const number = issueNumber[1]
        const issueUrl = `https://api.github.com/repos/${rule.repo}/issues/${number}`
        const issue = await githubText(options.token, issueUrl, fetchImpl, 'application/vnd.github+json')
        const comments = await githubText(
          options.token,
          `${issueUrl}/comments?per_page=100`,
          fetchImpl,
          'application/vnd.github+json'
        )
        const issueJson = JSON.parse(issue.text) as { body?: string, updated_at?: string }
        const commentJson = JSON.parse(comments.text) as { body?: string }[]
        const text = [
          issueJson.body ?? '',
          ...(Array.isArray(commentJson) ? commentJson.map(comment => comment.body ?? '') : [])
        ].join('\n')
        hits.push(...matchStatusDocText(text, rule, issueJson.updated_at ?? null))
        continue
      }
      const encoded = rule.target.split('/').map(part => encodeURIComponent(part)).join('/')
      const fileResponse = await githubText(
        options.token,
        `https://api.github.com/repos/${rule.repo}/contents/${encoded}`,
        fetchImpl,
        'application/vnd.github.raw'
      )
      const file = { text: decodeContents(fileResponse.text) }
      let eventAt: string | null = null
      try {
        const commits = await githubText(
          options.token,
          `https://api.github.com/repos/${rule.repo}/commits?path=${encoded}&per_page=1`,
          fetchImpl,
          'application/vnd.github+json'
        )
        const list = JSON.parse(commits.text) as { commit?: { committer?: { date?: string } } }[]
        eventAt = list[0]?.commit?.committer?.date ?? null
      } catch {
        eventAt = null
      }
      hits.push(...matchStatusDocText(file.text, rule, eventAt))
    } catch (error) {
      const message = error instanceof GithubRateLimitError
        ? 'GitHub 速率限制，本页保留上次结果'
        : error instanceof Error ? error.message : '状态文档读取失败'
      if (error instanceof GithubAuthError || error instanceof GithubRateLimitError) throw error
      errors.push({ source: `状态文档 ${ruleLabel(rule)}`, message })
    }
  }
  return { hits, errors }
}
