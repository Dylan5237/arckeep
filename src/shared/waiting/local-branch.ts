import type { LocalBranchHit } from './types.js'

export function githubWebUrl(remote: string | null, branch: string): string {
  if (!remote) return ''
  const cleaned = remote.trim().replace(/\.git$/, '')
  let slug = ''
  const ssh = /^(?:ssh:\/\/)?git@github\.com:([^/\s]+)\/([^/\s]+)$/.exec(cleaned)
  const https = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)$/.exec(cleaned)
  const sshUrl = /^ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s]+)$/.exec(cleaned)
  if (ssh) slug = `${ssh[1]}/${ssh[2]}`
  else if (sshUrl) slug = `${sshUrl[1]}/${sshUrl[2]}`
  else if (https) slug = `${https[1]}/${https[2]}`
  if (!slug) return ''
  const safeBranch = branch.split('/').map(part => encodeURIComponent(part)).join('/')
  return `https://github.com/${slug}/tree/${safeBranch}`
}

export function repoSlugFromRemote(remote: string | null, dir: string): string {
  const url = githubWebUrl(remote, 'main')
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\//.exec(url)
  if (match?.[1]) return match[1]
  const base = dir.split(/[\\/]/).filter(Boolean).pop() ?? 'repo'
  return `local/${base}`
}

/**
 * `git for-each-ref` output with NUL fields:
 * name, upstream, track, committer date, short sha, subject.
 */
export function parseAheadRefLines(output: string, dir: string, remote: string | null): LocalBranchHit[] {
  const repo = repoSlugFromRemote(remote, dir)
  const hits: LocalBranchHit[] = []
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue
    const [branch, upstream, track, committedAt, sha, subject] = line.split('\0')
    if (!branch || !upstream) continue
    const aheadMatch = /ahead (\d+)/.exec(track ?? '')
    const ahead = aheadMatch ? Number(aheadMatch[1]) : 0
    if (!Number.isFinite(ahead) || ahead <= 0) continue
    hits.push({
      dir,
      repo,
      branch,
      ahead,
      subject: (subject ?? sha ?? branch).trim().slice(0, 160),
      committedAt: committedAt || '',
      url: githubWebUrl(remote, branch)
    })
  }
  return hits
}
