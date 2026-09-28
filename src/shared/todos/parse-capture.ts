const NAME = '[A-Za-z0-9_.-]+'
const FULL_REPO = new RegExp(`^${NAME}/${NAME}$`)
const SHORT_REPO = new RegExp(`^${NAME}$`)
const HASH_TOKEN = new RegExp(`(^|\\s)#(\\S+)`, 'g')
const WAITING_TOKEN = /(^|\s)!等我(?=\s|$)/g

export interface CaptureParseInput {
  text: string
  repoField: string
  waitingField: boolean
  knownRepos: readonly string[]
}

export interface CaptureParseResult {
  text: string
  repo: string | null
  waiting: boolean
}

function canonicalRepo(token: string, knownRepos: readonly string[]): string | null {
  const folded = token.toLowerCase()
  return knownRepos.find(repo => repo.toLowerCase() === folded) ?? null
}

function uniqueShortRepo(token: string, knownRepos: readonly string[]): string | null {
  const folded = token.toLowerCase()
  const matches = knownRepos.filter(repo => {
    const name = repo.slice(repo.indexOf('/') + 1)
    return name.toLowerCase() === folded
  })
  return matches.length === 1 ? matches[0] ?? null : null
}

/** Resolve a `#owner/repo` or `#repo` token. Null means leave it in the text. */
export function resolveRepoToken(token: string, knownRepos: readonly string[]): string | null {
  if (FULL_REPO.test(token)) return canonicalRepo(token, knownRepos) ?? token
  if (!SHORT_REPO.test(token)) return null
  return uniqueShortRepo(token, knownRepos)
}

function resolveRepoField(field: string, knownRepos: readonly string[]): string | null {
  const value = field.trim()
  if (!value) return null
  return resolveRepoToken(value, knownRepos)
}

function collapse(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').replace(/[ \t]{2,}/g, ' ').trim()
}

/**
 * Pulls `#owner/repo`, a unique `#repo` short name, and `!等我` out of the
 * capture line. Unknown short names stay in the text. Nothing here throws:
 * a repo field that does not resolve becomes "no tag" and still lets the
 * line save.
 */
export function parseCaptureShorthand(input: CaptureParseInput): CaptureParseResult {
  const knownRepos = input.knownRepos.filter(repo => FULL_REPO.test(repo))
  let waiting = input.waitingField
  let repoFromText: string | null = null

  const withoutWaiting = input.text.replace(WAITING_TOKEN, () => {
    waiting = true
    return ' '
  })

  const withoutRepo = withoutWaiting.replace(HASH_TOKEN, (full, lead: string, token: string) => {
    const resolved = resolveRepoToken(token, knownRepos)
    if (!resolved) return full
    repoFromText = resolved
    return lead === '' ? '' : ' '
  })

  return {
    text: collapse(withoutRepo),
    repo: repoFromText ?? resolveRepoField(input.repoField, knownRepos),
    waiting
  }
}
