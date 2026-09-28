import { draftFromReasons, classifyRecord } from './classify.js'
import { dedupeDrafts, sortDrafts } from './dedupe.js'
import { WAITING_REASONS, type GithubRecord, type LocalBranchHit, type StatusDocHit, type TodoWaitingItem, type WaitingConfig, type WaitingDraft, type WaitingJsonRow } from './types.js'

export function draftsFromStatusDocs(hits: readonly StatusDocHit[], now: Date): WaitingDraft[] {
  return hits.map(hit => {
    const issue = hit.issueNumber
    return draftFromReasons({
      id: issue ? `issue:${hit.repo}#${issue}` : `doc:${hit.repo}:${hit.target}:${hit.line}`,
      repo: hit.repo,
      number: issue,
      type: issue ? 'issue' : 'status-doc',
      title: hit.text,
      url: hit.url,
      updatedAt: hit.eventAt ?? now.toISOString(),
      reasons: [{
        reason: WAITING_REASONS.statusDoc,
        at: hit.eventAt,
        estimated: !hit.eventAt
      }]
    }, now)
  })
}

export function draftsFromBranches(hits: readonly LocalBranchHit[], now: Date): WaitingDraft[] {
  return hits.map(hit => draftFromReasons({
    id: `local:${hit.dir}:${hit.branch}`,
    repo: hit.repo,
    number: null,
    type: 'local-branch',
    title: `${hit.branch} 领先 ${hit.ahead} 个提交 · ${hit.subject}`,
    url: hit.url,
    updatedAt: hit.committedAt || now.toISOString(),
    reasons: [{
      reason: WAITING_REASONS.local,
      at: hit.committedAt || null,
      estimated: !hit.committedAt
    }]
  }, now))
}

export function draftsFromTodos(items: readonly TodoWaitingItem[], now: Date): WaitingDraft[] {
  return items.map(item => draftFromReasons({
    id: `todo:${item.id}`,
    repo: 'local/todos',
    number: null,
    type: 'todo',
    title: item.title,
    url: item.url || 'arckeep://todos',
    updatedAt: item.updatedAt,
    reasons: [{
      reason: WAITING_REASONS.todo,
      at: item.createdAt,
      estimated: false
    }]
  }, now))
}

export function assembleWaiting(input: {
  records: readonly GithubRecord[]
  statusDocs: readonly StatusDocHit[]
  branches: readonly LocalBranchHit[]
  todos: readonly TodoWaitingItem[]
  config: WaitingConfig
  now: Date
}): WaitingDraft[] {
  const github = input.records
    .map(record => classifyRecord(record, input.config, input.now))
    .filter((draft): draft is WaitingDraft => draft !== null)
  const docs = input.config.sources.statusDocs ? draftsFromStatusDocs(input.statusDocs, input.now) : []
  const branches = input.config.sources.localBranches ? draftsFromBranches(input.branches, input.now) : []
  const todos = input.config.sources.todos ? draftsFromTodos(input.todos, input.now) : []
  return sortDrafts(dedupeDrafts([...github, ...docs, ...branches, ...todos], input.now))
}

export function toWaitingJson(drafts: readonly WaitingDraft[]): WaitingJsonRow[] {
  return drafts.map(draft => ({
    repo: draft.repo,
    number: draft.number,
    type: draft.type,
    title: draft.title,
    url: draft.url,
    reasons: [...draft.reasons],
    waitingDays: draft.waitingDays,
    daysEstimated: draft.daysEstimated
  }))
}

export function mergeRecords(records: readonly GithubRecord[]): GithubRecord[] {
  const map = new Map<string, GithubRecord>()
  for (const record of records) {
    const key = `${record.repo}#${record.number}`
    const existing = map.get(key)
    if (!existing) {
      map.set(key, {
        ...record,
        labels: [...record.labels],
        comments: record.comments.map(comment => ({ ...comment })),
        labelEvents: record.labelEvents.map(event => ({ ...event }))
      })
      continue
    }
    existing.fromAssignee = existing.fromAssignee || record.fromAssignee
    existing.fromReview = existing.fromReview || record.fromReview
    existing.fromMention = existing.fromMention || record.fromMention
    existing.fromOpenPr = existing.fromOpenPr || record.fromOpenPr
    existing.inScopeRepo = existing.inScopeRepo || record.inScopeRepo
    existing.assignedAt = existing.assignedAt ?? record.assignedAt
    existing.reviewRequestedAt = existing.reviewRequestedAt ?? record.reviewRequestedAt
    existing.mentionedAt = existing.mentionedAt ?? record.mentionedAt
    existing.lastPushedAt = existing.lastPushedAt ?? record.lastPushedAt
    existing.parentNumber = existing.parentNumber ?? record.parentNumber
    if (!existing.body && record.body) existing.body = record.body
    if (record.comments.length > existing.comments.length) existing.comments = record.comments.map(comment => ({ ...comment }))
    for (const label of record.labels) {
      if (!existing.labels.includes(label)) existing.labels.push(label)
    }
    for (const event of record.labelEvents) {
      if (!existing.labelEvents.some(item => item.name === event.name && item.at === event.at)) {
        existing.labelEvents.push(event)
      }
    }
    if (record.kind === 'pr') existing.kind = 'pr'
    existing.isDraft = existing.isDraft || record.isDraft
  }
  return [...map.values()]
}
