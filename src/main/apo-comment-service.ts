import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { readHttpResponse } from '../github/http-request.js'
import { pendingApoActions, APO_COMMENT_TOKENS, isApoRepoName, type ApoQuickAction, type ApoCommentOutcome } from '../shared/waiting/apo-actions.js'
import { blankRecord } from '../shared/waiting/parse-github.js'
import { apoDecision, apoDisposerMatches, apoWithdraws } from '../shared/waiting/apo-prose.js'
import type { GithubRecord } from '../shared/waiting/types.js'
import type { IpcResult } from '../shared/types.js'
import { throwIfCancelled, type TaskScope } from '../shared/task-scope.js'

interface Receipt extends ApoCommentOutcome {
  startedAt: string
  binding: string
}
type JsonObject = Record<string, unknown>
const object = (value: unknown): JsonObject => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}
const str = (value: unknown) => typeof value === 'string' ? value : ''
const keyOf = (action: ApoQuickAction) => createHash('sha256').update(action.id).digest('hex')
const bindingOf = (action: ApoQuickAction) => JSON.stringify([action.viewerLogin.toLowerCase(), action.target.repo.toLowerCase(), action.target.number, action.token])

/** One user click, one POST at most. Unknown outcomes survive restarts and cannot be replayed. */
export class ApoCommentService {
  private receipts: Record<string, Receipt> = {}
  private readonly flights = new Map<string, Promise<IpcResult<ApoCommentOutcome>>>()
  private journalValid = true

  constructor(private readonly deps: {
    file: string
    tasks: TaskScope
    resolveToken: (signal: AbortSignal) => Promise<string | null>
    fetchImpl?: typeof fetch
  }) {
    try {
      const raw = object(JSON.parse(readFileSync(deps.file, 'utf8')))
      if (raw.version !== 1 || !raw.receipts || typeof raw.receipts !== 'object' || Array.isArray(raw.receipts)) throw new Error('invalid journal')
      for (const [key, value] of Object.entries(object(raw.receipts))) {
        const item = object(value)
        if (!/^[a-f0-9]{64}$/.test(key) || !['sent', 'unknown'].includes(str(item.state))
          || !str(item.binding) || !Number.isFinite(Date.parse(str(item.startedAt)))) throw new Error('invalid receipt')
        this.receipts[key] = { state: item.state as Receipt['state'], startedAt: str(item.startedAt), binding: str(item.binding), ...(str(item.url) ? { url: str(item.url) } : {}) }
      }
    } catch (error) {
      // A corrupt existing journal must not silently lose a possibly sent comment.
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') this.journalValid = false
    }
  }

  state(action: ApoQuickAction): ApoCommentOutcome['state'] | undefined {
    if (!this.journalValid) return 'unknown'
    return this.receipts[keyOf(action)]?.state ?? (this.unknownReceipt(action) ? 'unknown' : undefined)
  }

  private unknownReceipt(action: ApoQuickAction): Receipt | undefined {
    return Object.values(this.receipts).find(receipt => receipt.state === 'unknown' && receipt.binding === bindingOf(action))
  }

  check(action: ApoQuickAction): Promise<IpcResult<ApoCommentOutcome>> {
    if (!this.journalValid) return Promise.resolve({ ok: false, error: '快捷评论记录无法读取，请在 GitHub 上核对评论' })
    const receipt = this.receipts[keyOf(action)] ?? this.unknownReceipt(action)
    if (!receipt) return Promise.resolve({ ok: true, data: { state: 'unknown' } })
    if (receipt.state === 'sent') return Promise.resolve({ ok: true, data: { state: 'sent', ...(receipt.url ? { url: receipt.url } : {}) } })
    return this.deps.tasks.run(signal => this.checkReceipt(action, receipt, signal), '核对 APO 评论结果')
      .catch(() => ({ ok: false, error: '无法核对评论结果，请在 GitHub 上查看' }))
  }

  submit(action: ApoQuickAction): Promise<IpcResult<ApoCommentOutcome>> {
    if (!this.journalValid) return Promise.resolve({ ok: false, error: '快捷评论记录无法读取，请先核对 GitHub 上的评论' })
    if (!APO_COMMENT_TOKENS.includes(action.token) || !isApoRepoName(action.source.repo) || !isApoRepoName(action.target.repo)
      || !Number.isSafeInteger(action.source.number) || action.source.number < 1
      || !Number.isSafeInteger(action.target.number) || action.target.number < 1) {
      return Promise.resolve({ ok: false, error: '快捷评论目标无效' })
    }
    const saved = this.receipts[keyOf(action)]
    if (saved?.state === 'sent') return Promise.resolve({ ok: true, data: { state: saved.state, ...(saved.url ? { url: saved.url } : {}) } })
    const uncertain = this.unknownReceipt(action)
    const flightKey = `${action.target.repo.toLowerCase()}#${action.target.number}:${action.token}`
    const active = this.flights.get(flightKey)
    if (active) return Promise.resolve({ ok: false, error: '同一目标的评论正在提交，请等待结果' })
    const promise = this.deps.tasks.run(signal => uncertain ? this.checkReceipt(action, uncertain, signal) : this.perform(action, signal), 'APO 快捷评论')
      .catch((): IpcResult<ApoCommentOutcome> => ({ ok: false, error: '快捷评论已取消或无法完成' }))
      .finally(() => this.flights.delete(flightKey))
    this.flights.set(flightKey, promise)
    return promise
  }

  private async request(token: string, endpoint: string, signal: AbortSignal, body?: string): Promise<{ status: number, data: unknown }> {
    const response = await readHttpResponse(`https://api.github.com${endpoint}`, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json', 'User-Agent': 'Arckeep', 'X-GitHub-Api-Version': '2022-11-28' },
      ...(body === undefined ? {} : { body: JSON.stringify({ body }) })
    }, this.deps.fetchImpl ?? fetch, { signal, timeoutMs: 15_000 }).catch(() => {
      // Adapter errors can contain request details; never surface credentials or arbitrary remote text.
      throw new Error('无法连接 GitHub，请稍后重试')
    })
    let data: unknown
    try { data = JSON.parse(response.bodyText) as unknown } catch { data = null }
    return { status: response.response.status, data }
  }

  private async readThread(token: string, target: { repo: string, number: number }, login: string, signal: AbortSignal, requireOpen = true): Promise<GithubRecord> {
    const endpoint = `/repos/${target.repo}/issues/${target.number}`
    const response = await this.request(token, endpoint, signal)
    if (response.status !== 200) throw new Error(this.readError(response.status))
    const item = object(response.data)
    if (item.number !== target.number || (requireOpen && item.state !== 'open')) throw new Error('目标已经关闭或发生变化，请刷新列表')
    const count = item.comments
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count > 1000) {
      throw new Error('无法完整核对评论，请在 GitHub 上处理这项请求')
    }
    const comments: GithubRecord['comments'] = []
    // Always read one page, even for zero comments, to check decisions arriving after the issue GET.
    for (let page = 1; page <= 11; page++) {
      const result = await this.request(token, `${endpoint}/comments?per_page=100&page=${page}`, signal)
      if (result.status !== 200) throw new Error(this.readError(result.status))
      if (!Array.isArray(result.data)) throw new Error('GitHub 评论响应无效')
      for (const raw of result.data) {
        const comment = object(raw)
        if (!str(comment.body) || !Number.isFinite(Date.parse(str(comment.created_at)))) throw new Error('GitHub 评论信息不完整')
        comments.push({ body: str(comment.body), createdAt: str(comment.created_at), authorLogin: str(object(comment.user).login) })
      }
      if (result.data.length < 100) break
      if (page === 11) throw new Error('评论太多，无法完整核对，请在 GitHub 上处理')
    }
    return blankRecord({
      repo: target.repo, number: target.number, kind: item.pull_request ? 'pr' : 'issue', title: str(item.title),
      body: str(item.body), createdAt: str(item.created_at), updatedAt: str(item.updated_at),
      authorLogin: str(object(item.user).login), viewerLogin: login, comments,
      commentsTruncated: false,
      url: str(item.html_url)
    })
  }

  private readError(status: number): string {
    if (status === 401) return 'GitHub 认证无效或已过期，请检查设置'
    if (status === 403) return 'GitHub 权限不足或请求受限，请检查认证权限'
    if (status === 404) return '找不到目标或没有访问权限，请刷新列表'
    if (status === 429) return 'GitHub 请求受限，请稍后重试'
    return `核对 GitHub 请求失败（HTTP ${status}）`
  }

  private async verifyRevision(token: string, record: GithubRecord, signal: AbortSignal): Promise<void> {
    const response = await this.request(token, `/repos/${record.repo}/issues/${record.number}`, signal)
    if (response.status !== 200) throw new Error(this.readError(response.status))
    const item = object(response.data)
    if (item.state !== 'open' || item.number !== record.number || Date.parse(str(item.updated_at)) !== Date.parse(record.updatedAt)
      || str(item.body) !== record.body || item.comments !== record.comments.length) {
      throw new Error('评论请求或目标在核对期间发生变化，请刷新列表')
    }
  }

  private targetDecision(record: GithubRecord, action: ApoQuickAction): 'sent' | 'rejected' | 'returned' | 'withdrawn' | null {
    let result: 'sent' | 'rejected' | 'returned' | 'withdrawn' | null = null
    for (const comment of [...record.comments].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))) {
      if (Date.parse(comment.createdAt) < Date.parse(action.requestAt)) continue
      if (apoWithdraws(comment.body, action.token)) { result = 'withdrawn'; continue }
      if (comment.authorLogin?.toLowerCase() !== action.viewerLogin.toLowerCase()) continue
      const decision = apoDecision(comment.body)
      if (decision === action.token) result = 'sent'
      else if (action.token === 'EXCEPTION ACCEPT' && decision === 'EXCEPTION REJECT') result = 'rejected'
      else if (action.token === 'PHASE ACCEPT' && decision === 'PHASE RETURN') result = 'returned'
    }
    return result
  }

  private save(): void {
    mkdirSync(path.dirname(this.deps.file), { recursive: true })
    const temporary = `${this.deps.file}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify({ version: 1, receipts: this.receipts }), { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, this.deps.file)
  }

  private async checkReceipt(action: ApoQuickAction, receipt: Receipt, signal: AbortSignal): Promise<IpcResult<ApoCommentOutcome>> {
    const token = await this.deps.resolveToken(signal)
    if (!token) return { ok: false, error: '未配置 GitHub 认证，请先去设置' }
    const user = await this.request(token, '/user', signal)
    const login = str(object(user.data).login)
    if (user.status !== 200 || login.toLowerCase() !== action.viewerLogin.toLowerCase()) return { ok: false, error: '无法核对评论账号，请刷新列表' }
    const target = await this.readThread(token, action.target, login, signal, false)
    const found = target.comments.some(comment => comment.authorLogin?.toLowerCase() === login.toLowerCase()
      && apoDecision(comment.body) === action.token && Date.parse(comment.createdAt) >= Math.floor(Date.parse(receipt.startedAt) / 1000) * 1000)
    if (!found) return { ok: true, data: { state: 'unknown' } }
    for (const item of Object.values(this.receipts)) if (item.binding === receipt.binding && item.state === 'unknown') item.state = 'sent'
    this.save()
    return { ok: true, data: { state: 'sent' } }
  }

  private async perform(action: ApoQuickAction, signal: AbortSignal): Promise<IpcResult<ApoCommentOutcome>> {
    const key = keyOf(action)
    let sending = false
    try {
      const token = await this.deps.resolveToken(signal)
      if (!token) return { ok: false, error: '未配置 GitHub 认证，请先去设置' }
      const user = await this.request(token, '/user', signal)
      if (user.status !== 200) return { ok: false, error: this.readError(user.status) }
      const login = str(object(user.data).login)
      if (!login || login.toLowerCase() !== action.viewerLogin.toLowerCase()) return { ok: false, error: 'GitHub 账号已变化，请刷新列表后处理' }
      const source = await this.readThread(token, action.source, login, signal)
      if (source.kind !== action.source.kind || !pendingApoActions(source).some(candidate => candidate.id === action.id)) {
        return { ok: false, error: '这项评论请求已变化或已处理，请刷新列表' }
      }
      const sameTarget = action.source.repo.toLowerCase() === action.target.repo.toLowerCase() && action.source.number === action.target.number
      const target = sameTarget ? source : await this.readThread(token, action.target, login, signal)
      if (target.kind !== 'issue') return { ok: false, error: 'APO 确认应评论到 Phase 或架构例外 Issue，请核对目标' }
      if (!apoDisposerMatches(target.body, login)) return { ok: false, error: '当前 GitHub 账号不是目标 Issue 的处置人，请核对身份' }
      const decision = this.targetDecision(target, action)
      if (decision === 'withdrawn') return { ok: false, error: '目标 Issue 已撤回这项评论请求，请刷新列表后处理' }
      if (decision === 'rejected' || decision === 'returned') return { ok: false, error: `目标 Issue 已${decision === 'rejected' ? '拒绝例外' : '退回阶段'}，请刷新列表后处理` }
      if (decision === 'sent') {
        this.receipts[key] = { state: 'sent', startedAt: new Date().toISOString(), binding: bindingOf(action) }
        this.save()
        return { ok: true, data: { state: 'sent' } }
      }
      throwIfCancelled(signal)
      if (await this.deps.resolveToken(signal) !== token) return { ok: false, error: 'GitHub 认证已变化，请刷新列表后处理' }
      await this.verifyRevision(token, source, signal)
      if (!sameTarget) await this.verifyRevision(token, target, signal)
      this.receipts[key] = { state: 'unknown', startedAt: new Date().toISOString(), binding: bindingOf(action) }
      this.save() // Durable attempt marker must precede the write.
      throwIfCancelled(signal)
      sending = true
      const response = await this.request(token, `/repos/${action.target.repo}/issues/${action.target.number}/comments`, signal, action.token)
      const data = object(response.data)
      if (response.status === 201 && str(data.body) === action.token && str(object(data.user).login).toLowerCase() === login.toLowerCase()) {
        const url = str(data.html_url)
        this.receipts[key] = { state: 'sent', startedAt: this.receipts[key]?.startedAt ?? new Date().toISOString(), binding: bindingOf(action), ...(url ? { url } : {}) }
        this.save()
        return { ok: true, data: { state: 'sent', ...(url ? { url } : {}) } }
      }
      if ([401, 403, 404, 422, 429].includes(response.status)) {
        delete this.receipts[key]
        this.save()
        return { ok: false, error: response.status === 422 ? 'GitHub 拒绝了评论，请核对目标与权限' : this.readError(response.status) }
      }
      return { ok: true, data: { state: 'unknown' } }
    } catch (error) {
      if (sending) {
        this.receipts[key] ??= { state: 'unknown', startedAt: new Date().toISOString(), binding: bindingOf(action) }
        return { ok: true, data: { state: 'unknown' } }
      }
      delete this.receipts[key]
      return { ok: false, error: error instanceof Error && error.name !== 'TimeoutError' && !/fetch|network/i.test(error.message)
        ? error.message : '无法核对 GitHub，未发送评论，请稍后重试' }
    }
  }
}
