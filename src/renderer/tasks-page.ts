import { localAbsolute } from '../shared/time'
import type { KnownRepo } from '../shared/tools/repos'
import {
  TASK_AGENT_LABELS,
  TASK_AUTONOMY_LABELS,
  TASK_PRIORITY_LABELS,
  TASK_STATUS_LABELS,
  type Task,
  type TaskAgent,
  type TaskAgentStatus,
  type TaskAutonomy,
  type TaskDecision,
  type TaskDetail,
  type TaskPriority,
  type TaskRunView,
  type TaskSnapshot,
  type TaskSource,
  type TaskStatus
} from '../shared/tasks/types'

export interface TaskPrefill {
  goal: string
  repo: string | null
  title?: string
  source: TaskSource
}

export interface TasksPageOptions {
  prefill?: TaskPrefill
  taskId?: string
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: Array<Node | string> = []
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value
    else if (key === 'value' && node instanceof HTMLInputElement) node.value = value
    else node.setAttribute(key, value)
  }
  for (const child of children) node.append(child instanceof Node ? child : document.createTextNode(child))
  return node
}

function unwrap<T>(result: { ok: true, data: T } | { ok: false, error: string }): T {
  if (!result.ok) throw new Error(result.error)
  return result.data
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

function formatDuration(startedAt: string, endedAt: string | null): string {
  const end = endedAt ? Date.parse(endedAt) : Date.now()
  const ms = Math.max(0, end - Date.parse(startedAt))
  if (ms < 60_000) return Math.round(ms / 1000) + ' 秒'
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return minutes + ' 分钟'
  return Math.floor(minutes / 60) + ' 小时 ' + (minutes % 60) + ' 分'
}

function formatCost(task: Task): string {
  return task.costUsd > 0 ? '$' + task.costUsd.toFixed(2) : '—'
}

function formatTokens(task: Task): string {
  const total = task.inputTokens + task.outputTokens
  return total > 0 ? total.toLocaleString('zh-CN') + ' tokens' : '—'
}

function statusClass(status: TaskStatus): string {
  return 'task-status task-status-' + status
}

function statusPill(status: TaskStatus): HTMLElement {
  return el('span', { class: statusClass(status) }, [TASK_STATUS_LABELS[status]])
}

function checkStatusClass(status: string): string {
  return 'task-check task-check-' + status
}

function decisionTimeLeft(decision: TaskDecision): string {
  const ms = Date.parse(decision.expiresAt) - Date.now()
  if (ms <= 0) return '已过期'
  if (ms < 3_600_000) return Math.max(1, Math.round(ms / 60_000)) + ' 分钟后过期'
  return Math.round(ms / 3_600_000) + ' 小时后过期'
}

function waitTypeLabel(type: string): string {
  if (type === 'timer') return '定时'
  if (type === 'github_checks') return 'GitHub CI'
  if (type === 'github_pr') return 'GitHub PR'
  return type
}

function agentLabel(agent: TaskAgent): string {
  return TASK_AGENT_LABELS[agent]
}

interface PageState {
  snapshot: TaskSnapshot | null
  detail: TaskDetail | null
  selectedId: string
  busy: boolean
  error: string
  detailError: string
  snapshotSignature: string
  detailSignature: string
  knownRepos: KnownRepo[]
  editingScope: boolean
  feedbackDrafts: Map<string, string>
  decisionNotes: Map<string, string>
  acceptNotes: Map<string, string>
}

export async function renderTasks(host: HTMLElement, options: TasksPageOptions): Promise<() => void> {
  const state: PageState = {
    snapshot: null,
    detail: null,
    selectedId: options.taskId ?? '',
    busy: false,
    error: '',
    detailError: '',
    snapshotSignature: '',
    detailSignature: '',
    knownRepos: [],
    editingScope: false,
    feedbackDrafts: new Map(),
    decisionNotes: new Map(),
    acceptNotes: new Map()
  }
  let disposed = false
  let pollBusy = false

  const page = el('section', { class: 'page tasks-page' })
  const header = el('header', { class: 'task-header' }, [
    el('div', {}, [
      el('h1', {}, ['任务']),
      el('p', { class: 'lede' }, ['交办工作、掌握后台进度、只处理真正需要你的决定，并在这里验收成果。'])
    ]),
    el('div', { class: 'task-header-actions' })
  ])
  const errorBox = el('div', { class: 'alert error task-page-error', role: 'alert', hidden: '' })
  const noticeBox = el('div', { class: 'alert task-page-notice', role: 'status', hidden: '' })
  const decisionSection = el('section', { class: 'task-decision-section' })
  const composer = el('details', { class: 'card task-composer', open: '' })
  const listPane = el('section', { class: 'task-list-pane', 'aria-label': '任务列表' })
  const detailPane = el('section', { class: 'task-detail-pane', 'aria-live': 'polite' })
  const layout = el('div', { class: 'task-layout' }, [listPane, detailPane])
  page.append(header, errorBox, noticeBox, decisionSection, composer, layout)
  host.replaceChildren(page)

  const showError = (message: string) => {
    state.error = message
    errorBox.textContent = message
    errorBox.hidden = message.length === 0
    if (message) {
      noticeBox.hidden = true
      noticeBox.textContent = ''
    }
  }

  const showNotice = (message: string) => {
    noticeBox.textContent = message
    noticeBox.hidden = message.length === 0
  }

  const refreshButton = el('button', { type: 'button', class: 'ghost' }, ['刷新'])
  const refreshEventsButton = el('button', { type: 'button', class: 'ghost' }, ['检查等待中的事件'])
  header.querySelector('.task-header-actions')?.append(refreshButton, refreshEventsButton)

  // ---------- Composer ----------
  const goalInput = el('textarea', {
    rows: '4',
    placeholder: '要交给 AI 什么工作？写清目标、期望结果和不能碰的边界。',
    'aria-label': '任务目标',
    maxlength: '20000'
  })
  const titleInput = el('input', { type: 'text', placeholder: '标题（可选，默认取目标第一行）', 'aria-label': '任务标题', maxlength: '200' })
  const repoSelect = el('select', { 'aria-label': '关联仓库' })
  const repoCustom = el('input', { type: 'text', placeholder: 'owner/repo', 'aria-label': '自定义仓库', hidden: '' })
  const cwdSelect = el('select', { 'aria-label': '常用工作目录' })
  const cwdButton = el('button', { type: 'button', class: 'ghost' }, ['浏览…'])
  const agentSelect = el('select', { 'aria-label': '执行 Agent' })
  const autonomySelect = el('select', { 'aria-label': '授权范围' })
  const prioritySelect = el('select', { 'aria-label': '优先级' })
  const createDraftButton = el('button', { type: 'button', class: 'ghost' }, ['仅创建'])
  const createStartButton = el('button', { type: 'button', class: 'primary' }, ['创建并开始'])
  const composerFeedback = el('p', { class: 'task-composer-feedback', role: 'status' })
  let selectedCwd = ''
  let pendingAgentDefault = ''
  const prefillRepo = options.prefill?.repo ?? ''

  const composerSummary = el('summary', { class: 'task-composer-summary' }, ['交办新任务'])
  const composerBody = el('div', { class: 'task-composer-body' })
  composer.append(composerSummary, composerBody)
  if (options.prefill) {
    goalInput.value = options.prefill.goal
    if (options.prefill.title) titleInput.value = options.prefill.title
    composer.open = true
  }

  const mkField = (label: string, control: HTMLElement, hint?: string) => {
    const field = el('label', { class: 'task-field' }, [el('span', { class: 'task-field-label' }, [label]), control])
    if (hint) field.append(el('span', { class: 'hint' }, [hint]))
    return field
  }
  const quickFields = el('div', { class: 'task-form-grid' }, [
    el('div', { class: 'task-field' }, [
      el('span', { class: 'task-field-label' }, ['关联仓库（可选）']),
      repoSelect,
      repoCustom
    ]),
    el('div', { class: 'task-field' }, [
      el('span', { class: 'task-field-label' }, ['工作目录']),
      el('div', { class: 'task-cwd-row' }, [cwdSelect, cwdButton])
    ])
  ])
  const advanced = el('details', { class: 'task-advanced' }, [
    el('summary', {}, ['高级选项：Agent / 授权范围 / 优先级']),
    el('div', { class: 'task-form-grid' }, [
      mkField('执行 Agent', agentSelect),
      mkField('授权范围', autonomySelect),
      mkField('优先级', prioritySelect)
    ])
  ])
  composerBody.append(
    el('div', { class: 'task-composer-main' }, [goalInput, titleInput]),
    quickFields,
    advanced,
    el('div', { class: 'task-composer-actions' }, [
      createStartButton,
      createDraftButton,
      el('span', { class: 'hint' }, ['默认使用上次的目录 / Agent / 授权；只想先确认范围就点「仅创建」。'])
    ]),
    composerFeedback
  )

  for (const [value, label] of [
    ['read-only', TASK_AUTONOMY_LABELS['read-only']],
    ['edit', TASK_AUTONOMY_LABELS.edit],
    ['full', TASK_AUTONOMY_LABELS.full]
  ] as const) {
    autonomySelect.append(el('option', { value }, [label]))
  }
  autonomySelect.value = 'edit'
  for (const [value, label] of [['high', TASK_PRIORITY_LABELS.high], ['normal', TASK_PRIORITY_LABELS.normal], ['low', TASK_PRIORITY_LABELS.low]] as const) {
    prioritySelect.append(el('option', { value }, [label]))
  }
  prioritySelect.value = 'normal'

  const rebuildRepoOptions = () => {
    const previous = prefillRepo || repoSelect.value
    repoSelect.replaceChildren(el('option', { value: '' }, ['（不关联仓库）']))
    const seen = new Set<string>()
    for (const repo of state.knownRepos) {
      if (!repo.github) continue
      const key = repo.github.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      repoSelect.append(el('option', { value: repo.github }, [repo.label + ' · ' + repo.github]))
    }
    repoSelect.append(el('option', { value: '__custom__' }, ['自定义 owner/repo…']))
    if (previous && previous !== '__custom__' && !seen.has(previous.toLowerCase())) {
      repoSelect.append(el('option', { value: previous }, [previous]))
    }
    if (previous) repoSelect.value = previous
    repoSelect.value = previous || ''
    if (repoSelect.value === '__custom__') repoCustom.hidden = false
  }
  const applyRepoSelection = () => {
    const value = repoSelect.value
    if (value === '__custom__') {
      repoCustom.hidden = false
      return
    }
    repoCustom.hidden = true
    repoCustom.value = ''
    const known = state.knownRepos.find(item => item.github?.toLowerCase() === value.toLowerCase())
    if (known?.path) setCwd(known.path, false)
  }
  repoSelect.addEventListener('change', applyRepoSelection)

  const ensureCwdOption = (value: string, label?: string) => {
    if (!value) return
    if (![...cwdSelect.options].some(option => option.value === value)) {
      cwdSelect.append(el('option', { value }, [label ?? value]))
    }
    cwdSelect.value = value
  }

  const setCwd = (value: string, matchRepo = true) => {
    selectedCwd = value
    ensureCwdOption(value)
    if (!matchRepo) return
    const known = state.knownRepos.find(item => item.path && item.path.toLowerCase() === value.toLowerCase())
    if (known?.github) {
      if (![...repoSelect.options].some(option => option.value.toLowerCase() === known.github!.toLowerCase())) {
        repoSelect.append(el('option', { value: known.github }, [known.label + ' · ' + known.github]))
      }
      repoSelect.value = known.github
      repoCustom.hidden = true
      repoCustom.value = ''
    }
  }

  const rebuildCwdOptions = () => {
    const previous = selectedCwd
    cwdSelect.replaceChildren(el('option', { value: '' }, ['选择常用工作目录…']))
    const seen = new Set<string>()
    for (const repo of state.knownRepos) {
      if (!repo.path || seen.has(repo.path.toLowerCase())) continue
      seen.add(repo.path.toLowerCase())
      cwdSelect.append(el('option', { value: repo.path }, [repo.label + ' · ' + repo.path]))
    }
    cwdSelect.append(el('option', { value: '__pick__' }, ['浏览其他目录…']))
    if (previous) ensureCwdOption(previous)
  }

  const chooseCwd = async () => {
    try {
      const result = await window.arckeep.pickTaskDirectory()
      if (!result.ok) {
        composerFeedback.textContent = result.error
        return
      }
      if (result.data.cancelled) {
        cwdSelect.value = selectedCwd
        return
      }
      setCwd(result.data.path)
      composerFeedback.textContent = ''
    } catch (error) {
      composerFeedback.textContent = errorText(error, '无法选择工作目录')
    }
  }

  cwdSelect.addEventListener('change', () => {
    if (cwdSelect.value === '__pick__') {
      void chooseCwd()
      return
    }
    if (cwdSelect.value) setCwd(cwdSelect.value)
  })
  cwdButton.addEventListener('click', () => { void chooseCwd() })

  const refreshAgentOptions = (snapshot: TaskSnapshot) => {
    const previous = agentSelect.value || 'auto'
    agentSelect.replaceChildren(el('option', { value: 'auto' }, ['自动选择（默认 ' + TASK_AGENT_LABELS[snapshot.config.defaultAgent] + '）']))
    for (const status of snapshot.agents) {
      const suffix = status.available
        ? (status.version ? ' · ' + status.version : '')
        : ' · 未安装'
      const option = el('option', { value: status.agent }, [TASK_AGENT_LABELS[status.agent] + suffix])
      option.disabled = !status.available
      agentSelect.append(option)
    }
    if (!snapshot.agentsReady) {
      const pending = el('option', { value: 'auto' }, ['正在检测本机 Agent…'])
      pending.disabled = true
      agentSelect.append(pending)
    }
    agentSelect.value = previous
    if (agentSelect.value !== previous) agentSelect.value = 'auto'
    if (pendingAgentDefault) {
      if ([...agentSelect.options].some(option => option.value === pendingAgentDefault)) {
        agentSelect.value = pendingAgentDefault
      }
      pendingAgentDefault = ''
    }
  }

  const currentProjectRepo = (): string | null => {
    if (repoSelect.value === '__custom__') return repoCustom.value.trim() || null
    return repoSelect.value || null
  }

  const createTask = async (start: boolean) => {
    if (state.busy) return
    const goal = goalInput.value.trim()
    if (!goal) {
      composerFeedback.textContent = '请先写清任务目标'
      goalInput.focus()
      return
    }
    if (!selectedCwd) {
      composerFeedback.textContent = '请选择任务的本地工作目录'
      return
    }
    state.busy = true
    createDraftButton.disabled = true
    createStartButton.disabled = true
    composerFeedback.textContent = start ? '正在创建并排队…' : '正在创建…'
    try {
      const task = unwrap(await window.arckeep.createTask({
        goal,
        title: titleInput.value.trim() || null,
        repo: currentProjectRepo(),
        name: null,
        cwd: selectedCwd,
        agent: agentSelect.value as TaskAgent | 'auto',
        autonomy: autonomySelect.value as TaskAutonomy,
        priority: prioritySelect.value as TaskPriority,
        source: options.prefill?.source ?? 'manual',
        start
      }))
      saveTaskDefaults()
      goalInput.value = ''
      titleInput.value = ''
      composerFeedback.textContent = start ? '已创建并排队。' : '已创建，请在右侧确认范围后开始。'
      composer.open = false
      state.selectedId = task.id
      await refresh(true)
    } catch (error) {
      composerFeedback.textContent = errorText(error, '无法创建任务')
    } finally {
      state.busy = false
      createDraftButton.disabled = false
      createStartButton.disabled = false
    }
  }
  createDraftButton.addEventListener('click', () => { void createTask(false) })
  createStartButton.addEventListener('click', () => { void createTask(true) })

  // ---------- Actions ----------
  const run = async (operation: () => Promise<unknown>, success = '') => {
    if (state.busy) return
    state.busy = true
    showError('')
    showNotice('')
    try {
      await operation()
      if (success) showNotice(success)
      await refresh(true)
    } catch (error) {
      showError(errorText(error, '任务操作失败'))
    } finally {
      state.busy = false
    }
  }

  const taskAction = (task: Task, action: string) => {
    switch (action) {
      case 'start': return run(() => window.arckeep.startTask(task.id), '已开始执行')
      case 'pause': return run(() => window.arckeep.pauseTask(task.id), '已暂停')
      case 'resume': return run(() => window.arckeep.resumeTask(task.id), '已恢复')
      case 'cancel': return run(() => window.arckeep.cancelTask(task.id), '已取消')
      case 'retry': return run(() => window.arckeep.retryTask(task.id), '已重新排队')
      case 'delete': return run(async () => {
        unwrap(await window.arckeep.deleteTask(task.id))
        if (state.selectedId === task.id) state.selectedId = ''
      }, '已删除')
      case 'accept': return run(() => window.arckeep.acceptTask(task.id, state.acceptNotes.get(task.id)?.trim() || undefined), '已验收通过')
      case 'reopen': return run(() => window.arckeep.reopenTask(task.id, state.feedbackDrafts.get(task.id)?.trim() || undefined), '已提交，正在继续原任务')
      case 'takeover': return run(async () => { unwrap(await window.arckeep.openTaskTerminal(task.id)) }, '已在外部终端打开任务工作目录')
      case 'check-events': return run(() => window.arckeep.refreshTaskEvents(true), '已检查等待事件')
      default: return Promise.resolve()
    }
  }

  const quickActions = (task: Task): HTMLElement => {
    const actions = el('div', { class: 'task-quick-actions' })
    const add = (label: string, action: string, kind = 'ghost') => {
      const button = el('button', { type: 'button', class: kind }, [label])
      button.addEventListener('click', event => {
        event.stopPropagation()
        void taskAction(task, action)
      })
      actions.append(button)
    }
    if (task.status === 'draft') add('开始', 'start', 'primary')
    if (task.status === 'running' || task.status === 'queued') add('暂停', 'pause')
    if (task.status === 'paused') add('继续', 'resume', 'primary')
    if (task.status === 'waiting') {
      add('立即核对', 'check-events')
      add('暂停', 'pause')
    }
    if (task.status === 'failed' || task.status === 'cancelled') add('继续', 'retry', 'primary')
    if (task.status === 'ready') add('验收', 'accept', 'primary')
    return actions
  }

  // ---------- Decisions ----------
  const renderDecisions = () => {
    const decisions = state.snapshot?.decisions ?? []
    decisionSection.replaceChildren()
    if (decisions.length === 0) {
      decisionSection.hidden = true
      return
    }
    decisionSection.hidden = false
    decisionSection.append(el('h2', { class: 'task-section-title' }, ['需要你决定']))
    for (const decision of decisions) {
      const task = state.snapshot?.tasks.find(item => item.id === decision.taskId)
      const card = el('article', { class: 'card task-decision-card' })
      card.append(
        el('div', { class: 'task-decision-head' }, [
          el('h3', {}, [decision.question]),
          el('span', { class: 'task-decision-expiry' }, [decisionTimeLeft(decision)])
        ]),
        el('p', { class: 'task-decision-task' }, [(task?.title ?? '任务') + (task?.repo ? ' · ' + task.repo : '')])
      )
      if (decision.whyYou) card.append(el('p', { class: 'hint' }, ['为什么要你决定：' + decision.whyYou]))
      if (decision.recommendation) {
        card.append(el('p', { class: 'task-recommendation' }, ['建议：' + decision.recommendation]))
      }
      const note = el('input', {
        type: 'text',
        placeholder: '补充说明（可选）',
        'aria-label': '决定补充说明',
        maxlength: '2000'
      })
      note.value = state.decisionNotes.get(decision.id) ?? ''
      note.addEventListener('input', () => state.decisionNotes.set(decision.id, note.value))
      const options = el('div', { class: 'task-decision-options' })
      for (const option of decision.options) {
        const button = el('button', { type: 'button', class: 'task-decision-option' }, [
          el('strong', {}, [option.label]),
          el('span', {}, [option.impact || '选择后按此继续'])
        ])
        button.addEventListener('click', async () => {
          if (state.busy) return
          state.busy = true
          button.disabled = true
          try {
            unwrap(await window.arckeep.replyTaskDecision({
              decisionId: decision.id,
              optionId: option.id,
              note: note.value.trim() || null
            }))
            state.decisionNotes.delete(decision.id)
            await refresh(true)
          } catch (error) {
            showError(errorText(error, '无法提交决定'))
            await refresh(true)
          } finally {
            state.busy = false
            button.disabled = false
          }
        })
        options.append(button)
      }
      card.append(note, options)
      decisionSection.append(card)
    }
  }

  // ---------- List ----------
  const renderTaskCard = (task: Task): HTMLElement => {
    const card = el('article', {
      class: 'task-list-card' + (task.id === state.selectedId ? ' active' : '') + (task.status === 'needs_decision' ? ' needs-decision' : '')
    })
    const head = el('div', { class: 'task-list-head' }, [
      el('h3', {}, [task.title]),
      statusPill(task.status)
    ])
    const metaParts = [
      task.repo ?? task.name,
      agentLabel(task.agent),
      task.rounds > 0 ? '第 ' + task.rounds + ' 轮' : '未执行'
    ]
    const meta = el('p', { class: 'task-list-meta' }, [metaParts.join(' · ')])
    const reason = el('p', { class: 'task-list-reason' }, [task.statusReason ?? ''])
    const footer = el('div', { class: 'task-list-footer' }, [
      el('span', { class: 'task-list-time' }, [localAbsolute(task.updatedAt)]),
      quickActions(task)
    ])
    card.append(head, meta, reason, footer)
    card.addEventListener('click', () => { void selectTask(task.id) })
    return card
  }

  const groupedTasks = (): Array<{ title: string, statuses: TaskStatus[] }> => [
    { title: '进行中', statuses: ['running', 'queued'] },
    { title: '等你决定', statuses: ['needs_decision'] },
    { title: '等待事件', statuses: ['waiting'] },
    { title: '待验收', statuses: ['ready'] },
    { title: '待确认范围', statuses: ['draft'] },
    { title: '已暂停', statuses: ['paused'] },
    { title: '失败/已取消', statuses: ['failed', 'cancelled'] },
    { title: '已验收', statuses: ['done'] }
  ]

  const renderList = () => {
    const snapshot = state.snapshot
    if (!snapshot) return
    const scrollTop = listPane.scrollTop
    listPane.replaceChildren()
    if (snapshot.engineError) {
      listPane.append(el('div', { class: 'alert error', role: 'alert' }, [snapshot.engineError]))
      return
    }
    if (snapshot.tasks.length === 0) {
      listPane.append(el('div', { class: 'task-empty' }, [
        el('p', {}, ['还没有任务。']),
        el('p', { class: 'hint' }, ['在上方写清目标并选择工作目录，交给 Codex 或 Claude Code 开始。'])
      ]))
      return
    }
    for (const group of groupedTasks()) {
      const tasks = snapshot.tasks.filter(task => group.statuses.includes(task.status))
      if (tasks.length === 0) continue
      const section = el('section', { class: 'task-list-group' })
      section.append(el('h2', { class: 'task-group-title' }, [group.title + ' · ' + tasks.length]))
      for (const task of tasks) section.append(renderTaskCard(task))
      listPane.append(section)
    }
    listPane.scrollTop = scrollTop
  }

  // ---------- Detail ----------
  const selectTask = async (id: string) => {
    state.selectedId = id
    state.editingScope = false
    renderList()
    await loadDetail()
  }

  const loadDetail = async () => {
    if (!state.selectedId) {
      state.detail = null
      state.detailSignature = ''
      renderDetail()
      return
    }
    try {
      state.detail = unwrap(await window.arckeep.getTaskDetail(state.selectedId))
      state.detailError = ''
    } catch (error) {
      state.detail = null
      state.detailError = errorText(error, '无法读取任务详情')
    }
    renderDetail()
  }

  const detailAction = (label: string, action: string, kind = 'ghost') => {
    const button = el('button', { type: 'button', class: kind }, [label])
    button.addEventListener('click', () => {
      if (state.busy) return
      const task = state.detail?.task
      if (task) void taskAction(task, action)
    })
    return button
  }

  const renderScope = (task: Task): HTMLElement => {
    const card = el('section', { class: 'card task-scope' })
    card.append(el('div', { class: 'task-card-heading' }, [el('h2', {}, ['执行范围']), el('div', {}, [
      el('button', { type: 'button', class: 'ghost tiny' }, [state.editingScope ? '取消编辑' : '编辑范围'])
    ])]))
    const editButton = card.querySelector('button')
    editButton?.addEventListener('click', () => {
      state.editingScope = !state.editingScope
      renderDetail()
    })
    if (state.editingScope) {
      const goal = el('textarea', { rows: '6', maxlength: '20000', 'aria-label': '编辑任务目标' })
      goal.value = task.goal
      const repo = el('input', { type: 'text', value: task.repo ?? '', placeholder: 'owner/repo（可留空）', 'aria-label': '编辑关联仓库' })
      const cwd = el('code', { class: 'task-cwd-value' }, [task.cwd])
      let cwdValue = task.cwd
      const pick = el('button', { type: 'button', class: 'ghost' }, ['更换目录'])
      pick.addEventListener('click', async () => {
        const result = await window.arckeep.pickTaskDirectory()
        if (!result.ok) { showError(result.error); return }
        if (result.data.cancelled) return
        cwdValue = result.data.path
        cwd.textContent = cwdValue
      })
      const agent = el('select', { 'aria-label': '编辑 Agent' })
      for (const value of ['claude', 'codex'] as TaskAgent[]) {
        agent.append(el('option', { value }, [TASK_AGENT_LABELS[value]]))
      }
      agent.value = task.agent
      const autonomy = el('select', { 'aria-label': '编辑授权范围' })
      for (const value of ['read-only', 'edit', 'full'] as TaskAutonomy[]) {
        autonomy.append(el('option', { value }, [TASK_AUTONOMY_LABELS[value]]))
      }
      autonomy.value = task.autonomy
      const priority = el('select', { 'aria-label': '编辑优先级' })
      for (const value of ['high', 'normal', 'low'] as TaskPriority[]) {
        priority.append(el('option', { value }, [TASK_PRIORITY_LABELS[value]]))
      }
      priority.value = task.priority
      const save = el('button', { type: 'button', class: 'primary' }, ['保存范围'])
      save.addEventListener('click', async () => {
        try {
          unwrap(await window.arckeep.updateTask({
            id: task.id,
            goal: goal.value,
            repo: repo.value.trim() || null,
            cwd: cwdValue,
            agent: agent.value as TaskAgent,
            autonomy: autonomy.value as TaskAutonomy,
            priority: priority.value as TaskPriority
          }))
          state.editingScope = false
          await refresh(true)
        } catch (error) {
          showError(errorText(error, '无法保存任务范围'))
        }
      })
      card.append(
        el('label', { class: 'task-field' }, [el('span', { class: 'task-field-label' }, ['目标']), goal]),
        el('label', { class: 'task-field' }, [el('span', { class: 'task-field-label' }, ['仓库']), repo]),
        el('div', { class: 'task-field' }, [el('span', { class: 'task-field-label' }, ['工作目录']), el('div', { class: 'task-cwd-row' }, [cwd, pick])]),
        el('div', { class: 'task-form-grid' }, [
          el('label', { class: 'task-field' }, [el('span', { class: 'task-field-label' }, ['Agent']), agent]),
          el('label', { class: 'task-field' }, [el('span', { class: 'task-field-label' }, ['授权范围']), autonomy]),
          el('label', { class: 'task-field' }, [el('span', { class: 'task-field-label' }, ['优先级']), priority])
        ]),
        el('div', { class: 'task-composer-actions' }, [save])
      )
      return card
    }
    card.append(el('pre', { class: 'task-goal' }, [task.goal]))
    const grid = el('div', { class: 'task-meta-grid' })
    const add = (label: string, value: string) => grid.append(el('div', {}, [
      el('span', { class: 'task-meta-label' }, [label]),
      el('span', {}, [value])
    ]))
    add('项目', task.repo ? task.name + ' · ' + task.repo : task.name)
    add('工作目录', task.cwd)
    add('Agent', agentLabel(task.agent) + ' · ' + TASK_AUTONOMY_LABELS[task.autonomy])
    add('运行轮次', task.rounds + ' / ' + task.maxRuns + ' 轮')
    add('累计用量', formatCost(task) + ' · ' + formatTokens(task))
    add('会话', task.sessionId ? task.sessionAgent ? agentLabel(task.sessionAgent) + ' ' + task.sessionId.slice(0, 8) : task.sessionId.slice(0, 8) : '尚未建立')
    card.append(grid)
    if (task.status === 'draft') {
      card.append(el('div', { class: 'task-composer-actions' }, [
        detailAction('确认范围并开始', 'start', 'primary')
      ]))
    }
    return card
  }

  const renderDecisionForTask = (task: Task): HTMLElement | null => {
    if (task.status !== 'needs_decision' || !task.decisionId) return null
    const decision = state.detail?.decisions.find(item => item.id === task.decisionId)
    if (!decision || decision.status !== 'pending') return null
    const card = el('section', { class: 'card task-decision-card task-detail-decision' })
    card.append(
      el('div', { class: 'task-decision-head' }, [el('h2', {}, [decision.question]), el('span', { class: 'task-decision-expiry' }, [decisionTimeLeft(decision)])]),
      el('p', { class: 'hint' }, [decision.whyYou ? '为什么要你决定：' + decision.whyYou : '这一步需要你的取舍。']),
      ...(decision.recommendation ? [el('p', { class: 'task-recommendation' }, ['建议：' + decision.recommendation])] : [])
    )
    const note = el('input', { type: 'text', placeholder: '补充说明（可选）', maxlength: '2000', 'aria-label': '决定补充说明' })
    note.value = state.decisionNotes.get(decision.id) ?? ''
    note.addEventListener('input', () => state.decisionNotes.set(decision.id, note.value))
    const options = el('div', { class: 'task-decision-options' })
    for (const option of decision.options) {
      const button = el('button', { type: 'button', class: 'task-decision-option' }, [
        el('strong', {}, [option.label]),
        el('span', {}, [option.impact || ''])
      ])
      button.addEventListener('click', async () => {
        if (state.busy) return
        state.busy = true
        button.disabled = true
        try {
          unwrap(await window.arckeep.replyTaskDecision({ decisionId: decision.id, optionId: option.id, note: note.value.trim() || null }))
          state.decisionNotes.delete(decision.id)
          await refresh(true)
        } catch (error) {
          showError(errorText(error, '无法提交决定'))
          await refresh(true)
        } finally {
          state.busy = false
          button.disabled = false
        }
      })
      options.append(button)
    }
    card.append(note, options)
    return card
  }

  const renderWait = (task: Task): HTMLElement | null => {
    if (!task.wait) return null
    const card = el('section', { class: 'card task-wait' })
    card.append(el('div', { class: 'task-card-heading' }, [el('h2', {}, ['等待事件']), el('span', { class: 'chip' }, [waitTypeLabel(task.wait.type)])]))
    card.append(el('p', {}, [task.wait.reason || '等待外部条件变化']))
    const facts = el('div', { class: 'task-meta-grid' })
    const add = (label: string, value: string) => facts.append(el('div', {}, [
      el('span', { class: 'task-meta-label' }, [label]), el('span', {}, [value])
    ]))
    if (task.wait.type === 'timer' && task.wait.until) add('触发时间', localAbsolute(task.wait.until))
    if (task.wait.type !== 'timer' && task.wait.repo && task.wait.pr) add('目标', task.wait.repo + ' #' + task.wait.pr)
    add('最近检查', task.wait.lastCheckedAt ? localAbsolute(task.wait.lastCheckedAt) : '尚未检查')
    add('最近状态', task.wait.lastState ?? '—')
    add('超时', localAbsolute(task.wait.timeoutAt))
    card.append(facts)
    if (task.wait.lastError) card.append(el('p', { class: 'alert error' }, [task.wait.lastError]))
    card.append(el('p', { class: 'hint' }, ['Agent 已结束本轮，不会占用进程。事件变化后会先核对最新事实再继续。']))
    card.append(el('div', { class: 'task-composer-actions' }, [detailAction('立即核对', 'check-events', 'primary')]))
    return card
  }

  const renderResult = (task: Task): HTMLElement | null => {
    const result = task.result
    if (!result) return null
    const card = el('section', { class: 'card task-result' })
    card.append(el('div', { class: 'task-card-heading' }, [el('h2', {}, ['本轮成果']), el('span', { class: 'hint' }, [localAbsolute(result.receivedAt)])]))
    if (result.summary) card.append(el('pre', { class: 'task-summary' }, [result.summary]))
    if (result.protocolWarning) card.append(el('p', { class: 'alert error' }, [result.protocolWarning]))
    if (result.artifacts.length > 0) {
      card.append(el('h3', {}, ['产物']))
      const list = el('ul', { class: 'task-artifacts' })
      for (const artifact of result.artifacts) {
        const button = el('button', { type: 'button', class: 'task-artifact' }, [
          el('span', { class: 'task-artifact-kind' }, [artifact.kind]),
          el('span', {}, [artifact.label]),
          el('code', {}, [artifact.path ?? artifact.url ?? (artifact.kind === 'text' ? '点击复制文本' : '')])
        ])
        if (artifact.exists === false) {
          button.disabled = true
          button.append(el('span', { class: 'task-artifact-missing' }, ['文件不存在']))
        }
        button.addEventListener('click', async () => {
          try {
            unwrap(await window.arckeep.openTaskArtifact(task.id, artifact.id))
            if (artifact.kind === 'text') composerFeedback.textContent = '文本已复制'
          } catch (error) {
            showError(errorText(error, '无法打开产物'))
          }
        })
        list.append(el('li', {}, [button]))
      }
      card.append(list)
    }
    if (result.checks.length > 0) {
      card.append(el('h3', {}, ['检查']))
      const checks = el('ul', { class: 'task-checks' })
      for (const check of result.checks) {
        checks.append(el('li', { class: checkStatusClass(check.status) }, [
          el('span', { class: 'task-check-status' }, [check.status === 'passed' ? '通过' : check.status === 'failed' ? '失败' : check.status === 'not_run' ? '未运行' : '未知']),
          el('span', {}, [check.name]),
          ...(check.detail ? [el('span', { class: 'hint' }, [check.detail])] : [])
        ]))
      }
      card.append(checks)
    }
    if (result.unverified.length > 0) {
      card.append(el('h3', {}, ['尚未验证']))
      card.append(el('ul', { class: 'task-unverified' }, result.unverified.map(item => el('li', {}, [item]))))
    }
    return card
  }

  const renderFeedback = (task: Task): HTMLElement | null => {
    if (!['ready', 'done', 'failed'].includes(task.status)) return null
    const card = el('section', { class: 'card task-feedback' })
    card.append(el('h2', {}, [task.status === 'failed' ? '继续或返修' : '验收与反馈']))
    if (task.status === 'ready') {
      card.append(el('p', { class: 'hint' }, ['执行结束不等于验收通过。确认产物和检查后，再点验收。']))
      const acceptNote = el('input', { type: 'text', placeholder: '验收备注（可选）', maxlength: '2000', 'aria-label': '验收备注' })
      acceptNote.value = state.acceptNotes.get(task.id) ?? ''
      acceptNote.addEventListener('input', () => state.acceptNotes.set(task.id, acceptNote.value))
      card.append(acceptNote, el('div', { class: 'task-composer-actions' }, [detailAction('验收通过', 'accept', 'primary')]))
    }
    if (task.acceptance.status === 'accepted') {
      card.append(el('p', { class: 'hint' }, ['已验收' + (task.acceptance.at ? ' · ' + localAbsolute(task.acceptance.at) : '') + (task.acceptance.note ? ' · ' + task.acceptance.note : '')]))
    }
    const feedback = el('textarea', { rows: '4', maxlength: '8000', placeholder: '哪里不满意，或还要改什么？Agent 会接着原任务继续。', 'aria-label': '任务反馈' })
    feedback.value = state.feedbackDrafts.get(task.id) ?? ''
    feedback.addEventListener('input', () => state.feedbackDrafts.set(task.id, feedback.value))
    card.append(feedback, el('div', { class: 'task-composer-actions' }, [detailAction('提交修改', 'reopen', task.status === 'failed' ? 'primary' : 'ghost')]))
    return card
  }

  const renderRuns = (runs: TaskRunView[]): HTMLElement => {
    const card = el('section', { class: 'card task-runs' })
    card.append(el('h2', {}, ['执行记录']))
    if (runs.length === 0) {
      card.append(el('p', { class: 'hint' }, ['还没有执行记录。']))
      return card
    }
    for (const run of runs) {
      const item = el('article', { class: 'task-run' })
      const duration = formatDuration(run.startedAt, run.endedAt)
      item.append(el('div', { class: 'task-run-head' }, [
        el('strong', {}, ['第 ' + run.round + ' 轮 · ' + agentLabel(run.agent)]),
        el('span', { class: 'task-run-status task-run-status-' + run.status }, [run.status]),
        el('span', { class: 'hint' }, [duration + (run.usage.costUsd ? ' · $' + run.usage.costUsd.toFixed(2) : '')])
      ]))
      if (run.error) item.append(el('p', { class: 'alert error' }, [run.error]))
      if (run.status === 'running' && run.progress) {
        item.append(el('p', { class: 'task-run-progress', 'data-run-progress': run.id }, [run.progress]))
      }
      if (run.summary) item.append(el('pre', { class: 'task-run-summary' }, [run.summary]))
      const details = el('details', { class: 'task-run-log' })
      details.append(el('summary', {}, ['日志']), el('pre', { class: 'task-run-tail', 'data-run-tail': run.id }, [run.logTail || '（暂无日志）']))
      const reveal = el('button', { type: 'button', class: 'ghost tiny' }, ['打开日志所在位置'])
      reveal.addEventListener('click', async event => {
        event.preventDefault()
        try { unwrap(await window.arckeep.revealTaskRun(state.detail?.task.id ?? '', run.id)) }
        catch (error) { showError(errorText(error, '无法打开日志')) }
      })
      details.append(reveal)
      item.append(details)
      card.append(item)
    }
    return card
  }

  const renderDetail = () => {
    const task = state.detail?.task ?? null
    const signature = task
      ? JSON.stringify([
          task.updatedAt,
          task.status,
          task.decisionId,
          task.result?.receivedAt ?? null,
          state.detail?.runs.map(run => [run.id, run.status, run.endedAt, run.progress, run.summary, run.error]) ?? [],
          state.detail?.decisions.map(item => [item.id, item.status]) ?? [],
          state.editingScope
        ])
      : ''
    if (signature === state.detailSignature) {
      for (const run of state.detail?.runs ?? []) {
        const tail = detailPane.querySelector<HTMLElement>('[data-run-tail="' + run.id + '"]')
        if (tail) tail.textContent = run.logTail || '（暂无日志）'
        const progress = detailPane.querySelector<HTMLElement>('[data-run-progress="' + run.id + '"]')
        if (progress) progress.textContent = run.progress ?? ''
      }
      return
    }
    state.detailSignature = signature
    detailPane.replaceChildren()
    if (!task) {
      if (state.detailError) detailPane.append(el('div', { class: 'alert error' }, [state.detailError]))
      else detailPane.append(el('div', { class: 'task-empty' }, [el('p', {}, ['选择左侧任务查看执行范围、成果和记录。'])]))
      return
    }
    detailPane.append(
      el('div', { class: 'task-detail-head' }, [
        el('div', {}, [el('h2', {}, [task.title]), el('p', { class: 'task-detail-meta' }, [task.repo ? task.name + ' · ' + task.repo : task.name])]),
        statusPill(task.status)
      ]),
      el('p', { class: 'task-status-reason' }, [task.statusReason ?? ''])
    )
    const controls = el('div', { class: 'task-detail-actions' })
    const addControl = (label: string, action: string, kind = 'ghost') => controls.append(detailAction(label, action, kind))
    if (task.status === 'draft') addControl('开始执行', 'start', 'primary')
    if (task.status === 'running' || task.status === 'queued') addControl('暂停', 'pause')
    if (task.status === 'waiting') addControl('立即核对', 'check-events')
    if (task.status === 'paused') addControl('继续', 'resume', 'primary')
    if (task.status === 'failed' || task.status === 'cancelled') addControl('继续', 'retry', 'primary')
    if (['draft', 'waiting', 'paused', 'failed', 'ready'].includes(task.status)) addControl('接管', 'takeover')
    if (['draft', 'queued', 'running', 'waiting', 'needs_decision', 'ready', 'paused', 'failed'].includes(task.status)) addControl('取消任务', 'cancel')
    if (['draft', 'paused', 'failed', 'ready', 'done', 'cancelled'].includes(task.status)) addControl('删除', 'delete')
    if (controls.childElementCount > 0) detailPane.append(controls)
    detailPane.append(renderScope(task))
    const decisionCard = renderDecisionForTask(task)
    if (decisionCard) detailPane.append(decisionCard)
    const waitCard = renderWait(task)
    if (waitCard) detailPane.append(waitCard)
    const resultCard = renderResult(task)
    if (resultCard) detailPane.append(resultCard)
    const feedback = renderFeedback(task)
    if (feedback) detailPane.append(feedback)
    detailPane.append(renderRuns(state.detail?.runs ?? []))
    if (task.events.length > 0) {
      const events = el('details', { class: 'card task-events' })
      events.append(el('summary', {}, ['事件记录 · ' + task.events.length]))
      const list = el('ul', {})
      for (const event of [...task.events].reverse().slice(0, 20)) {
        list.append(el('li', {}, [localAbsolute(event.at) + ' · ' + event.kind + ' · ' + event.detail]))
      }
      events.append(list)
      detailPane.append(events)
    }
  }

  // ---------- Refresh ----------
  const snapshotSignature = (snapshot: TaskSnapshot): string => JSON.stringify({
    tasks: snapshot.tasks.map(task => [task.id, task.updatedAt, task.status, task.decisionId, task.rounds]),
    decisions: snapshot.decisions.map(item => [item.id, item.status]),
    config: snapshot.config,
    agents: snapshot.agents,
    engine: snapshot.engineError
  })

  const refresh = async (forceDetail = false) => {
    if (disposed) return
    try {
      const snapshot = unwrap(await window.arckeep.getTaskSnapshot())
      state.snapshot = snapshot
      const sig = snapshotSignature(snapshot)
      if (sig !== state.snapshotSignature) {
        state.snapshotSignature = sig
        refreshAgentOptions(snapshot)
        renderDecisions()
        renderList()
      }
      if (!state.selectedId && snapshot.tasks.length > 0) {
        state.selectedId = snapshot.tasks[0].id
      }
      if (state.selectedId && !snapshot.tasks.some(task => task.id === state.selectedId)) {
        state.selectedId = ''
        state.detail = null
        state.detailSignature = ''
        renderDetail()
      }
      if (state.selectedId) {
        if (forceDetail) state.detailSignature = ''
        await loadDetail()
      } else if (state.detail) {
        state.detail = null
        state.detailSignature = ''
        renderDetail()
      }
    } catch (error) {
      showError(errorText(error, '无法读取任务'))
    }
  }

  const loadTaskDefaults = (): Record<string, string> => {
    try {
      const raw = localStorage.getItem('arckeep.task-defaults.v1')
      const parsed: unknown = raw ? JSON.parse(raw) : null
      return parsed && typeof parsed === 'object' ? parsed as Record<string, string> : {}
    } catch {
      return {}
    }
  }

  const saveTaskDefaults = () => {
    try {
      localStorage.setItem('arckeep.task-defaults.v1', JSON.stringify({
        cwd: selectedCwd,
        repo: currentProjectRepo() ?? '',
        agent: agentSelect.value,
        autonomy: autonomySelect.value,
        priority: prioritySelect.value
      }))
    } catch {
      // Preferences are optional.
    }
  }

  const loadKnownRepos = async () => {
    try {
      state.knownRepos = await window.arckeep.getKnownRepos()
    } catch {
      state.knownRepos = []
    }
    rebuildRepoOptions()
    rebuildCwdOptions()
    const defaults = loadTaskDefaults()
    if (defaults.repo && [...repoSelect.options].some(option => option.value.toLowerCase() === defaults.repo.toLowerCase())) {
      repoSelect.value = defaults.repo
    }
    if (defaults.agent) pendingAgentDefault = defaults.agent
    if (defaults.autonomy && [...autonomySelect.options].some(option => option.value === defaults.autonomy)) autonomySelect.value = defaults.autonomy
    if (defaults.priority && [...prioritySelect.options].some(option => option.value === defaults.priority)) prioritySelect.value = defaults.priority
    if (defaults.cwd) setCwd(defaults.cwd)
    if (options.prefill?.repo) {
      const repo = options.prefill.repo
      if (![...repoSelect.options].some(option => option.value.toLowerCase() === repo.toLowerCase())) {
        repoSelect.append(el('option', { value: repo }, [repo]))
      }
      repoSelect.value = repo
      applyRepoSelection()
    }
  }

  refreshButton.addEventListener('click', () => { void refresh(true) })
  refreshEventsButton.addEventListener('click', () => {
    void run(() => window.arckeep.refreshTaskEvents(true), '已检查等待中的事件')
  })

  const onVisibilityChange = () => {
    if (!document.hidden) void refresh()
  }
  const onTasksChanged = window.arckeep.onTasksChanged(() => { void refresh() })
  document.addEventListener('visibilitychange', onVisibilityChange)
  await loadKnownRepos()
  await refresh()
  const timer = window.setInterval(() => {
    if (document.hidden || pollBusy) return
    pollBusy = true
    void refresh().finally(() => { pollBusy = false })
  }, 3_000)

  return () => {
    disposed = true
    window.clearInterval(timer)
    onTasksChanged()
    document.removeEventListener('visibilitychange', onVisibilityChange)
  }
}

export async function renderTaskSettings(): Promise<HTMLElement> {
  const card = el('section', { class: 'card task-settings' })
  card.append(el('h2', {}, ['AI 任务执行']), el('p', { class: 'hint' }, [
    '任务在 Arckeep 主进程内排队执行。关闭主窗口进入托盘后继续；明确退出应用会中止运行并保存现场。'
  ]))
  let snapshot: TaskSnapshot
  try {
    snapshot = unwrap(await window.arckeep.getTaskSnapshot())
  } catch (error) {
    card.append(el('div', { class: 'alert error' }, [errorText(error, '无法读取任务设置')]))
    return card
  }
  const config = snapshot.config
  const agentsBox = el('div', { class: 'task-agent-status' })
  const paintAgents = (agents: TaskAgentStatus[], ready: boolean) => {
    agentsBox.replaceChildren()
    if (!ready) {
      agentsBox.append(el('p', { class: 'hint' }, ['正在检测本机 Agent…']))
      return
    }
    for (const status of agents) {
      agentsBox.append(el('p', { class: status.available ? 'task-agent-ok' : 'task-agent-missing' }, [
        TASK_AGENT_LABELS[status.agent] + '：' + (status.available ? '可用' + (status.version ? ' · ' + status.version : '') : '未找到 CLI')
      ]))
    }
  }
  paintAgents(snapshot.agents, snapshot.agentsReady)
  const defaultAgent = el('select', { 'aria-label': '默认 Agent' })
  for (const value of ['claude', 'codex'] as TaskAgent[]) defaultAgent.append(el('option', { value }, [TASK_AGENT_LABELS[value]]))
  defaultAgent.value = config.defaultAgent
  const number = (label: string, value: number, min: number, max: number, step = '1') => {
    const input = el('input', { type: 'number', min: String(min), max: String(max), step, 'aria-label': label })
    input.value = String(value)
    return { field: el('label', { class: 'task-field' }, [el('span', { class: 'task-field-label' }, [label]), input]), input }
  }
  const concurrency = number('同时执行任务数', config.maxConcurrent, 1, 4)
  const timeout = number('单轮最长分钟', config.runTimeoutMinutes, 5, 240)
  const maxRuns = number('每任务最多轮次', config.maxRunsPerTask, 1, 30)
  const maxCost = number('每任务费用上限（USD）', config.maxCostUsdPerTask, 0.5, 200, '0.5')
  const retries = number('启动失败重试次数', config.retries, 0, 5)
  const feedback = el('p', { class: 'task-composer-feedback', role: 'status' })
  const save = el('button', { type: 'button', class: 'primary' }, ['保存任务设置'])
  save.addEventListener('click', async () => {
    save.disabled = true
    try {
      const saved = unwrap(await window.arckeep.setTaskConfig({
        defaultAgent: defaultAgent.value as TaskAgent,
        maxConcurrent: Number(concurrency.input.value),
        runTimeoutMinutes: Number(timeout.input.value),
        maxRunsPerTask: Number(maxRuns.input.value),
        maxCostUsdPerTask: Number(maxCost.input.value),
        retries: Number(retries.input.value)
      }))
      feedback.textContent = '已保存：最多 ' + saved.maxConcurrent + ' 个任务并行'
    } catch (error) {
      feedback.textContent = errorText(error, '无法保存任务设置')
    } finally {
      save.disabled = false
    }
  })
  const detect = el('button', { type: 'button', class: 'ghost' }, ['重新检测 Agent'])
  detect.addEventListener('click', async () => {
    detect.disabled = true
    try {
      paintAgents(unwrap(await window.arckeep.refreshTaskAgents()), true)
    } catch (error) {
      feedback.textContent = errorText(error, '无法检测 Agent')
    } finally {
      detect.disabled = false
    }
  })
  card.append(
    agentsBox,
    el('div', { class: 'task-form-grid' }, [
      el('label', { class: 'task-field' }, [el('span', { class: 'task-field-label' }, ['默认 Agent']), defaultAgent]),
      concurrency.field,
      timeout.field,
      maxRuns.field,
      maxCost.field,
      retries.field
    ]),
    el('div', { class: 'task-composer-actions' }, [save, detect]),
    feedback,
    el('p', { class: 'hint' }, [
      '只读分析不会改文件；可改文件会运行本地命令；完全自主允许网络与推送能力。高授权仍受任务目标和项目规则约束。'
    ])
  )
  return card
}
