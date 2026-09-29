export type KnownRepoSource = 'watched' | 'github' | 'local'

export interface KnownRepo {
  id: string
  label: string
  github: string | null
  path: string | null
  sources: KnownRepoSource[]
}

const SOURCE_ORDER: KnownRepoSource[] = ['watched', 'github', 'local']

const SOURCE_LABEL: Record<KnownRepoSource, string> = {
  watched: '关注列表',
  github: 'GitHub',
  local: '本地路径'
}

const SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

export function isGithubSlug(value: string): boolean {
  return SLUG.test(value)
}

export function knownRepoSourceLabel(sources: readonly KnownRepoSource[]): string {
  return SOURCE_ORDER.filter(source => sources.includes(source)).map(source => SOURCE_LABEL[source]).join('、')
}

function normPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

interface Acc {
  github: string | null
  path: string | null
  sources: Set<KnownRepoSource>
}

/**
 * Known repositories come only from data the app already has:
 * the settings watch list, repositories returned by GitHub, and local paths
 * the user configured (plus local checkouts already linked to a GitHub name).
 */
export function collectKnownRepos(input: {
  watchedRepos: readonly string[]
  githubRepos: readonly string[]
  localPaths: readonly string[]
  linked?: readonly { github: string, path: string }[]
}): KnownRepo[] {
  const items: Acc[] = []

  const findSlug = (slug: string): Acc | undefined => {
    const key = slug.toLowerCase()
    return items.find(item => item.github?.toLowerCase() === key)
  }
  const findPath = (filePath: string): Acc | undefined => {
    const key = normPath(filePath)
    return items.find(item => item.path !== null && normPath(item.path) === key)
  }
  const touchSlug = (slug: string, source: KnownRepoSource): Acc => {
    let item = findSlug(slug)
    if (!item) {
      item = { github: slug, path: null, sources: new Set() }
      items.push(item)
    }
    item.sources.add(source)
    return item
  }
  const touchPath = (filePath: string, source: KnownRepoSource): Acc => {
    let item = findPath(filePath)
    if (!item) {
      item = { github: null, path: filePath, sources: new Set() }
      items.push(item)
    }
    item.sources.add(source)
    return item
  }

  for (const slug of input.watchedRepos) {
    if (isGithubSlug(slug)) touchSlug(slug, 'watched')
  }
  for (const slug of input.githubRepos) {
    if (isGithubSlug(slug)) touchSlug(slug, 'github')
  }
  for (const filePath of input.localPaths) {
    const trimmed = filePath.trim()
    if (trimmed) touchPath(trimmed, 'local')
  }
  for (const link of input.linked ?? []) {
    const filePath = link.path.trim()
    if (!isGithubSlug(link.github) || !filePath) continue
    const slugItem = touchSlug(link.github, 'local')
    const pathItem = findPath(filePath)
    if (pathItem && pathItem !== slugItem) {
      if (!slugItem.path) slugItem.path = pathItem.path
      for (const source of pathItem.sources) slugItem.sources.add(source)
      items.splice(items.indexOf(pathItem), 1)
    } else if (!slugItem.path) {
      slugItem.path = filePath
    }
  }

  const repos: KnownRepo[] = []
  for (const item of items) {
    if (!item.github && !item.path) continue
    const id = item.github ?? item.path ?? ''
    const label = item.github && item.path ? `${item.github} · ${item.path}` : (item.github ?? item.path ?? '')
    repos.push({
      id,
      label,
      github: item.github,
      path: item.path,
      sources: SOURCE_ORDER.filter(source => item.sources.has(source))
    })
  }
  repos.sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'))
  return repos
}

export function findKnownRepo(repos: readonly KnownRepo[], value: string): KnownRepo | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const pathKey = normPath(trimmed)
  return repos.find(repo => repo.id === trimmed
    || repo.github === trimmed
    || repo.github?.toLowerCase() === trimmed.toLowerCase()
    || (repo.path !== null && normPath(repo.path) === pathKey)) ?? null
}

export function directoryChoices(repos: readonly KnownRepo[]): KnownRepo[] {
  return repos.filter(repo => repo.path)
}

export function openTargetForRepo(repo: KnownRepo):
  | { type: 'open-url', text: string }
  | { type: 'open-folder', text: string, argv: string[] } {
  if (repo.github && isGithubSlug(repo.github)) {
    return { type: 'open-url', text: `https://github.com/${repo.github}` }
  }
  if (repo.path) return { type: 'open-folder', text: repo.path, argv: [repo.path] }
  throw new Error('这个仓库没有可打开的地址')
}
