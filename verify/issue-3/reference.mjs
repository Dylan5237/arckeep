#!/usr/bin/env node
// Independent reference-data collector for the Arckeep Issue #3 acceptance run.
//
// This script is deliberately NOT importing anything from `src/**`. It re-derives the
// classification rules from the public issue description / PR text only, so the
// comparison in the report is a genuine independent check, not a re-run of the app's
// own code against itself.
//
// Auth: uses ONLY the token in process.env.GITHUB_TOKEN (the workflow's own ephemeral
// GITHUB_TOKEN — see hard rule #3 in verify/reports/issue-3-dddb958.md). No PAT, no
// secret, no other credential is read here.
//
// Output: writes JSON to the path given as argv[2] (default: reference.json in CWD).

import { writeFileSync } from 'node:fs'

const TOKEN = process.env.GITHUB_TOKEN
const OUT = process.argv[2] || 'reference.json'
const NOW = new Date()

// Same page-size contract the app documents in src/overview/load.ts (REPO_FIELDS):
// pullRequests(states: OPEN, first: 40, orderBy: CREATED_AT ASC), contexts(first: 10).
const PR_WINDOW = 40
const CONTEXT_WINDOW = 10
const REVIEW_WAIT_DAYS_DEFAULT = 3
const STALE_DAYS_DEFAULT = 14
const STALE_REPO_DAYS_DEFAULT = 90

function log(...args) {
  console.error('[reference]', ...args)
}

async function gql(query, variables = {}) {
  if (!TOKEN) throw new Error('GITHUB_TOKEN is not set')
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'arckeep-issue-3-verify'
    },
    body: JSON.stringify({ query, variables })
  })
  const text = await res.text()
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error(`GraphQL response was not JSON (status ${res.status}): ${text.slice(0, 500)}`)
  }
  if (!res.ok) {
    throw new Error(`GraphQL HTTP ${res.status}: ${text.slice(0, 500)}`)
  }
  return payload
}

async function rest(path) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `bearer ${TOKEN}`,
      'User-Agent': 'arckeep-issue-3-verify',
      Accept: 'application/vnd.github+json'
    }
  })
  const text = await res.text()
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    payload = text
  }
  return { status: res.status, ok: res.ok, payload }
}

function daysBetween(iso, now = NOW) {
  if (!iso) return null
  const then = Date.parse(iso)
  if (!Number.isFinite(then)) return null
  return Math.floor((now.getTime() - then) / 86_400_000)
}

const REPO_QUERY = `
  nameWithOwner
  url
  isEmpty
  isArchived
  diskUsage
  pushedAt
  defaultBranchRef {
    target {
      oid
      ... on Commit {
        committedDate
        statusCheckRollup {
          state
          contexts(first: ${CONTEXT_WINDOW}) {
            nodes {
              ... on CheckRun { name conclusion detailsUrl }
              ... on StatusContext { context state targetUrl }
            }
          }
        }
      }
    }
  }
  pullRequests(states: OPEN, first: ${PR_WINDOW}, orderBy: {field: CREATED_AT, direction: ASC}) {
    totalCount
    nodes {
      number
      url
      isDraft
      createdAt
      reviewDecision
      reviews(states: APPROVED, first: 1) { totalCount }
    }
  }
`

async function fetchRepo(full) {
  const [owner, name] = full.split('/')
  const payload = await gql(`query($o: String!, $n: String!) { repository(owner: $o, name: $n) { ${REPO_QUERY} } }`, { o: owner, n: name })
  if (payload.errors) {
    return { full, error: payload.errors.map(e => e.message).join('; ') }
  }
  return { full, repo: payload.data.repository }
}

function ciState(rollupState) {
  if (!rollupState) return 'none'
  const value = rollupState.toUpperCase()
  if (value === 'SUCCESS') return 'success'
  if (value === 'FAILURE' || value === 'ERROR') return 'failure'
  if (value === 'PENDING' || value === 'EXPECTED') return 'pending'
  return 'none'
}

function failingContextUrl(rollup, repoUrl) {
  const fallback = `${repoUrl.replace(/\/$/, '')}/actions`
  const nodes = rollup?.contexts?.nodes ?? []
  for (const node of nodes) {
    const conclusion = node?.conclusion ?? ''
    const state = node?.state ?? ''
    if (conclusion === 'FAILURE' || conclusion === 'ERROR' || state === 'FAILURE' || state === 'ERROR') {
      return node.detailsUrl || node.targetUrl || fallback
    }
  }
  return { fallback, sampledContexts: nodes.length, note: nodes.length >= CONTEXT_WINDOW ? `only first ${CONTEXT_WINDOW} contexts sampled; a failing context may exist beyond this window` : 'no failing context in sample' }
}

function reviewWaitAnalysis(repo, reviewWaitDays = REVIEW_WAIT_DAYS_DEFAULT) {
  const nodes = repo.pullRequests?.nodes ?? []
  const stuck = []
  for (const pr of nodes) {
    if (pr.isDraft) continue
    const approved = pr.reviews?.totalCount ?? 0
    if (approved > 0) continue
    if (pr.reviewDecision === 'APPROVED' || pr.reviewDecision === 'CHANGES_REQUESTED') continue
    const days = daysBetween(pr.createdAt)
    if (days === null || days < reviewWaitDays) continue
    stuck.push({ number: pr.number, url: pr.url, days })
  }
  stuck.sort((a, b) => b.days - a.days || a.number - b.number)
  return {
    totalOpenPrCount: repo.pullRequests?.totalCount ?? 0,
    sampledPrCount: nodes.length,
    sampleTruncated: (repo.pullRequests?.totalCount ?? 0) > nodes.length,
    stuckInSample: stuck,
    longest: stuck[0] ?? null,
    otherStuckCount: Math.max(0, stuck.length - 1)
  }
}

function isEmptyRepo(repo) {
  if (repo.isEmpty) return true
  if (repo.diskUsage === 0) return true
  const hasCommit = Boolean(repo.defaultBranchRef?.target?.oid || repo.defaultBranchRef?.target?.committedDate)
  return !hasCommit
}

function classifySnapshot(repo, config = {}) {
  const staleDays = config.staleDays ?? STALE_DAYS_DEFAULT
  const staleRepoDays = config.staleRepoDays ?? STALE_REPO_DAYS_DEFAULT
  const reviewWaitDays = config.reviewWaitDays ?? REVIEW_WAIT_DAYS_DEFAULT
  const empty = isEmptyRepo(repo)
  const pushedDays = daysBetween(repo.pushedAt)
  const isStaleGroup = !empty && pushedDays !== null && pushedDays >= staleRepoDays
  const commit = repo.defaultBranchRef?.target
  const lastCommitAt = commit?.committedDate ?? null
  const lastCommitDays = daysBetween(lastCommitAt)
  const isStalled = !empty && !isStaleGroup && lastCommitDays !== null && lastCommitDays >= staleDays
  const rollup = commit?.statusCheckRollup ?? null
  const state = ciState(rollup?.state)
  const review = reviewWaitAnalysis(repo, reviewWaitDays)
  const ciFailure = state === 'failure' ? failingContextUrl(rollup, repo.url) : null
  return {
    name: repo.nameWithOwner,
    url: repo.url,
    archived: repo.isArchived,
    empty,
    pushedAt: repo.pushedAt,
    pushedDays,
    lastCommitAt,
    lastCommitDays,
    ciState: state,
    ciFailure,
    isStaleGroup,
    isStalled,
    stalledDays: isStalled ? lastCommitDays : null,
    reviewWait: review,
    openPrCount: repo.pullRequests?.totalCount ?? 0
  }
}

// ---- Candidate discovery per scenario -------------------------------------------------

async function firstMatch(candidates, predicate, label) {
  const attempts = []
  for (const full of candidates) {
    let result
    try {
      result = await fetchRepo(full)
    } catch (error) {
      attempts.push({ full, error: error instanceof Error ? error.message : String(error) })
      continue
    }
    if (result.error) {
      attempts.push({ full, error: result.error })
      continue
    }
    const snap = classifySnapshot(result.repo)
    const verdict = predicate(snap, result.repo)
    attempts.push({ full, snapshot: snap, matched: Boolean(verdict), reason: typeof verdict === 'string' ? verdict : undefined })
    if (verdict) {
      log(`${label}: picked ${full}`)
      return { picked: full, snapshot: snap, repo: result.repo, attempts }
    }
  }
  log(`${label}: NO candidate matched`, JSON.stringify(attempts))
  return { picked: null, snapshot: null, repo: null, attempts }
}

async function findEmptyRepoViaSearch() {
  const searchResult = await rest('/search/repositories?q=size%3A0+is%3Apublic&sort=updated&order=desc&per_page=30')
  if (!searchResult.ok || !Array.isArray(searchResult.payload?.items)) {
    return { picked: null, attempts: [{ error: `search API failed: HTTP ${searchResult.status}` }] }
  }
  const attempts = []
  for (const item of searchResult.payload.items) {
    const full = item.full_name
    let result
    try {
      result = await fetchRepo(full)
    } catch (error) {
      attempts.push({ full, error: error instanceof Error ? error.message : String(error) })
      continue
    }
    if (result.error) {
      attempts.push({ full, error: result.error })
      continue
    }
    const repo = result.repo
    const noBranches = !repo.defaultBranchRef
    const matched = repo.isEmpty === true && repo.isArchived === false && noBranches
    attempts.push({ full, isEmpty: repo.isEmpty, isArchived: repo.isArchived, diskUsage: repo.diskUsage, hasDefaultBranch: !noBranches, matched })
    if (matched) {
      return { picked: full, snapshot: classifySnapshot(repo), repo, attempts }
    }
  }
  return { picked: null, attempts }
}

async function main() {
  const result = { generatedAt: NOW.toISOString(), tokenPresent: Boolean(TOKEN), scenarios: {} }

  if (!TOKEN) {
    result.error = 'GITHUB_TOKEN not set; cannot query GitHub for reference data.'
    writeFileSync(OUT, JSON.stringify(result, null, 2))
    console.log(JSON.stringify(result, null, 2))
    return
  }

  // Sanity check: confirm the ephemeral token can read a public repo it has no
  // installation relationship with at all. If this fails we record the raw error and
  // stop — hard rule #3 requires falling back to fixture-only checks in that case.
  try {
    const probe = await gql('query { repository(owner: "octocat", name: "Hello-World") { nameWithOwner } }')
    result.publicReadProbe = probe.errors
      ? { ok: false, errors: probe.errors }
      : { ok: true, repository: probe.data.repository }
  } catch (error) {
    result.publicReadProbe = { ok: false, error: error instanceof Error ? error.message : String(error) }
  }

  result.scenarios.ciSuccess = await firstMatch(
    ['cli/cli', 'jekyll/jekyll', 'caolan/async', 'twbs/bootstrap', 'rails/rails'],
    snap => snap.ciState === 'success' && !snap.archived,
    'ciSuccess'
  )

  result.scenarios.ciFailure = await firstMatch(
    ['apache/superset', 'jashkenas/backbone', 'home-assistant/core'],
    snap => snap.ciState === 'failure' && !snap.archived,
    'ciFailure'
  )

  result.scenarios.noCi = await firstMatch(
    ['torvalds/linux', 'octocat/Spoon-Knife', 'sindresorhus/awesome'],
    snap => snap.ciState === 'none' && !snap.archived,
    'noCi'
  )

  result.scenarios.reviewWait = await firstMatch(
    ['microsoft/vscode', 'cli/cli', 'jashkenas/backbone'],
    snap => Boolean(snap.reviewWait.longest) && !snap.archived,
    'reviewWait'
  )

  result.scenarios.archived = await firstMatch(
    ['atom/atom'],
    snap => snap.archived === true,
    'archived'
  )

  result.scenarios.stalePure = await firstMatch(
    ['schacon/grit', 'defunkt/github-gem', 'mislav/hub'],
    snap => !snap.archived && snap.openPrCount === 0 && snap.pushedDays !== null && snap.pushedDays >= 7,
    'stalePure'
  )

  result.scenarios.thresholdWindow = await firstMatch(
    ['cli/cli', 'd3/d3', 'caolan/async'],
    snap => !snap.archived && snap.lastCommitDays !== null && snap.lastCommitDays >= 1 && snap.lastCommitDays < 7,
    'thresholdWindow (1<=lastCommitDays<7, for staleDays 1 -> 7 disappear test)'
  )

  result.scenarios.nonexistent = { picked: 'Dylan5237/definitely-not-a-repo-xyz', verified: null }
  try {
    const check = await fetchRepo('Dylan5237/definitely-not-a-repo-xyz')
    result.scenarios.nonexistent.verified = check.error ? { doesNotExist: true, message: check.error } : { doesNotExist: false, repo: check.repo }
  } catch (error) {
    result.scenarios.nonexistent.verified = { error: error instanceof Error ? error.message : String(error) }
  }

  result.scenarios.emptyRepo = await findEmptyRepoViaSearch()

  writeFileSync(OUT, JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
}

main().catch(error => {
  console.error('[reference] fatal:', error)
  writeFileSync(OUT, JSON.stringify({ fatal: error instanceof Error ? error.message : String(error) }, null, 2))
  process.exitCode = 1
})
