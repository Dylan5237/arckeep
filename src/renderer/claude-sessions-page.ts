import { localAbsolute } from '../shared/time'
import type { ClaudeSession, ClaudeSessionTranscript } from '../shared/claude-sessions'

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: Array<Node | string> = []
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value
    else node.setAttribute(key, value)
  }
  for (const child of children) node.append(child instanceof Node ? child : document.createTextNode(child))
  return node
}

export interface ClaudeSessionsPageOptions {
  repo?: string
  sessionId?: string
}

export async function renderClaudeSessions(
  host: HTMLElement,
  options: ClaudeSessionsPageOptions
): Promise<() => void> {
  let disposed = false
  let pollBusy = false
  let filterRefreshQueued = false
  let selectionVersion = 0
  let sessionMutationVersion = 0
  let sessions: ClaudeSession[] = []
  let paintedSessions: ClaudeSession[] = []
  let paintedSelectedId = ''
  let paintedListReady = false
  let repoOptionSnapshot = ''
  let repoFilter = options.repo ?? ''
  let selectedId = options.sessionId ?? ''
  let nameByRepo = new Map<string, string>()
  let paintedTranscript: ClaudeSessionTranscript | null = null
  let paintedTranscriptSelection = ''
  let paintedTranscriptReady = false

  const page = el('section', { class: 'page claude-sessions' }, [
    el('h1', {}, ['Claude 会话']),
    el('p', { class: 'lede' }, ['按项目和实际工作目录查看 Arckeep 启动的 Claude 会话。'])
  ])
  const toolbar = el('div', { class: 'claude-toolbar' })
  const repoSelect = el('select', { 'aria-label': '筛选项目' })
  const workspaceButton = el('button', { type: 'button', class: 'ghost' }, ['更换工作目录'])
  const startButton = el('button', { type: 'button', class: 'primary' }, ['使用 Claude 工作'])
  toolbar.append(repoSelect, workspaceButton, startButton)
  const feedback = el('p', { class: 'claude-feedback', role: 'status', 'aria-live': 'polite' })
  const layout = el('div', { class: 'claude-layout' })
  const sessionList = el('aside', { class: 'claude-session-list', 'aria-label': '项目和会话' })
  const transcript = el('section', { class: 'claude-transcript', 'aria-live': 'polite' })
  layout.append(sessionList, transcript)
  page.append(toolbar, feedback, layout)
  host.replaceChildren(page)

  const showFeedback = (message: string, error = false) => {
    feedback.textContent = message
    feedback.classList.toggle('error', error)
  }

  const selectedSession = () => sessions.find(item => item.id === selectedId) ?? null

  const populateRepoSelect = () => {
    const previous = repoFilter
    const repos = [...new Set(sessions.map(item => item.repo))]
    if (options.repo && !repos.some(repo => repo.toLowerCase() === options.repo?.toLowerCase())) repos.unshift(options.repo)
    if (previous && !repos.some(repo => repo.toLowerCase() === previous.toLowerCase())) repos.unshift(previous)
    nameByRepo = new Map(sessions.map(item => [item.repo.toLowerCase(), item.name]))
    const repoOptions = repos.map(repo => ({ repo, label: (nameByRepo.get(repo.toLowerCase()) ?? repo) + ' · ' + repo }))
    const snapshot = JSON.stringify(repoOptions)
    if (snapshot !== repoOptionSnapshot) {
      repoOptionSnapshot = snapshot
      repoSelect.replaceChildren(el('option', { value: '' }, ['全部项目']))
      for (const optionData of repoOptions) {
        repoSelect.append(el('option', { value: optionData.repo }, [optionData.label]))
      }
    }
    repoSelect.value = previous
  }

  const sameSession = (left: ClaudeSession, right: ClaudeSession) =>
    left.id === right.id && left.repo === right.repo && left.name === right.name
      && left.cwd === right.cwd && left.startedAt === right.startedAt

  const sameTranscript = (left: ClaudeSessionTranscript | null, right: ClaudeSessionTranscript | null) => {
    if (left === right) return true
    if (!left || !right || !sameSession(left.session, right.session)
      || left.truncated !== right.truncated
      || left.messages.length !== right.messages.length) return false
    return left.messages.every((message, index) => {
      const other = right.messages[index]
      return Boolean(other && message.id === other.id && message.role === other.role
        && message.text === other.text && message.at === other.at)
    })
  }

  const paintList = () => {
    if (paintedListReady && paintedSelectedId === selectedId && paintedSessions.length === sessions.length
      && paintedSessions.every((item, index) => {
        const other = sessions[index]
        return Boolean(other && sameSession(item, other))
      })) return
    const scrollTop = sessionList.scrollTop
    sessionList.replaceChildren()
    paintedSessions = sessions.map(item => ({ ...item }))
    paintedSelectedId = selectedId
    paintedListReady = true
    if (sessions.length === 0) {
      sessionList.append(el('p', { class: 'claude-empty' }, ['还没有 Claude 会话。到项目总览选择一个项目并启动。']))
      sessionList.scrollTop = scrollTop
      return
    }
    const grouped = new Map<string, ClaudeSession[]>()
    for (const item of sessions) {
      const key = item.repo.toLowerCase()
      const group = grouped.get(key) ?? []
      group.push(item)
      grouped.set(key, group)
    }
    for (const [key, group] of grouped) {
      const first = group[0]
      const section = el('section', { class: 'claude-project-group' })
      section.append(el('h2', {}, [first.name]), el('p', { class: 'claude-repo-name' }, [first.repo]))
      for (const item of group) {
        const card = el('article', { class: 'claude-session-card' + (item.id === selectedId ? ' active' : '') })
        const select = el('button', { type: 'button', class: 'claude-session-select' })
        select.append(
          el('strong', {}, [localAbsolute(item.startedAt)]),
          el('span', {}, [item.cwd]),
          el('code', {}, [item.id.slice(0, 8)])
        )
        select.addEventListener('click', () => { void showTranscript(item.id) })
        const resume = el('button', { type: 'button', class: 'ghost tiny' }, ['恢复'])
        resume.title = '在相同目录恢复此会话'
        resume.addEventListener('click', () => { void startSession(item.repo, item.name, item.id) })
        card.append(select, resume)
        section.append(card)
      }
      sessionList.append(section)
      if (!nameByRepo.has(key)) nameByRepo.set(key, first.name)
    }
    sessionList.scrollTop = scrollTop
  }

  const paintTranscript = (record: ClaudeSessionTranscript | null, followLatest = false) => {
    if (paintedTranscriptReady && paintedTranscriptSelection === selectedId && sameTranscript(paintedTranscript, record)) {
      paintedTranscript = record
      const updated = transcript.querySelector<HTMLElement>('.claude-transcript-updated')
      if (updated) updated.textContent = record?.updatedAt
        ? '最近记录 ' + localAbsolute(record.updatedAt)
        : '等待 Claude 写入会话记录'
      if (followLatest) transcript.querySelector('.claude-messages')?.lastElementChild?.scrollIntoView({ block: 'nearest' })
      return
    }
    const scrollTop = transcript.scrollTop
    const wasAtBottom = transcript.scrollHeight - transcript.clientHeight - scrollTop <= 48
    transcript.replaceChildren()
    paintedTranscript = record
    paintedTranscriptSelection = selectedId
    paintedTranscriptReady = true
    const selected = selectedSession()
    if (!selected) {
      transcript.append(el('div', { class: 'claude-empty transcript-empty' }, ['选择一个会话查看记录']))
      return
    }
    const heading = el('header', { class: 'claude-transcript-head' }, [
      el('div', {}, [
        el('h2', {}, [selected.name]),
        el('p', {}, [selected.cwd]),
        el('code', {}, [selected.id])
      ]),
      el('span', { class: 'claude-transcript-updated' }, [
        record?.updatedAt ? '最近记录 ' + localAbsolute(record.updatedAt) : '等待 Claude 写入会话记录'
      ])
    ])
    transcript.append(heading)
    if (!record || record.messages.length === 0) {
      transcript.append(el('div', { class: 'claude-empty transcript-empty' }, [
        record?.truncated
          ? '记录较大，读取范围内暂时没有可展示的文字消息。'
          : 'Claude 首次响应后，文字消息会显示在这里。'
      ]))
      return
    }
    if (record.truncated) transcript.append(el('p', { class: 'claude-truncated' }, ['仅显示最近一段记录']))
    const messages = el('div', { class: 'claude-messages' })
    for (const item of record.messages) {
      const article = el('article', { class: 'claude-message claude-message-' + item.role })
      const label = item.role === 'user' ? '你' : item.role === 'assistant' ? 'Claude' : '工具'
      article.append(el('header', {}, [
        el('strong', {}, [label]),
        el('time', {}, [item.at ? localAbsolute(item.at) : ''])
      ]))
      article.append(el('pre', {}, [item.text]))
      messages.append(article)
    }
    transcript.append(messages)
    if (followLatest || wasAtBottom) messages.lastElementChild?.scrollIntoView({ block: 'nearest' })
    else transcript.scrollTop = scrollTop
  }

  const showTranscript = async (id: string, successMessage = '') => {
    selectedId = id
    const version = ++selectionVersion
    paintList()
    const pending = selectedSession()
    if (pending) paintTranscript(null)
    const result = await window.arckeep.readClaudeSession(id)
    if (disposed || version !== selectionVersion) return
    if (!result.ok) {
      showFeedback(result.error, true)
      return
    }
    showFeedback(successMessage)
    paintTranscript(result.data, true)
  }

  const refresh = async () => {
    if (disposed || document.hidden || pollBusy) return
    pollBusy = true
    const requestedRepo = repoFilter
    const observedMutationVersion = sessionMutationVersion
    try {
      const result = await window.arckeep.listClaudeSessions(requestedRepo || undefined)
      if (disposed) return
      if (requestedRepo !== repoFilter) return
      if (!result.ok) {
        showFeedback(result.error, true)
        return
      }
      if (observedMutationVersion === sessionMutationVersion) {
        sessions = result.data
      } else {
        const merged = new Map(sessions.map(item => [item.id, item]))
        for (const item of result.data) merged.set(item.id, item)
        sessions = [...merged.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      }
      populateRepoSelect()
      if (!selectedId || !sessions.some(item => item.id === selectedId)) {
        selectedId = sessions[0]?.id ?? ''
      }
      paintList()
      if (selectedId) {
        const version = ++selectionVersion
        const result = await window.arckeep.readClaudeSession(selectedId)
        if (disposed || version !== selectionVersion) return
        if (result.ok) paintTranscript(result.data)
        else showFeedback(result.error, true)
      } else {
        paintTranscript(null)
      }
    } catch (error) {
      if (!disposed) showFeedback(error instanceof Error ? error.message : '无法读取 Claude 会话', true)
    } finally {
      pollBusy = false
      if (filterRefreshQueued && !disposed) {
        filterRefreshQueued = false
        void refresh()
      }
    }
  }

  const startSession = async (repo: string, name: string, resumeId?: string) => {
    startButton.disabled = true
    try {
      const result = await window.arckeep.startClaudeSession(repo, name, resumeId)
      if (!result.ok) {
        showFeedback(result.error, true)
        return
      }
      const session = result.data
      sessionMutationVersion += 1
      if (repoFilter !== session.repo && pollBusy) filterRefreshQueued = true
      repoFilter = session.repo
      selectedId = session.id
      options.repo = session.repo
      sessions = [session, ...sessions.filter(item => item.id !== session.id)]
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      populateRepoSelect()
      paintList()
      await showTranscript(session.id, '已向外部终端发送 Claude 启动请求；请确认 Claude 已就绪')
    } catch (error) {
      showFeedback(error instanceof Error ? error.message : 'Claude 启动失败', true)
    } finally {
      startButton.disabled = false
    }
  }

  repoSelect.addEventListener('change', () => {
    repoFilter = repoSelect.value
    selectedId = ''
    if (pollBusy) filterRefreshQueued = true
    else void refresh()
  })
  const refreshWhenVisible = () => {
    if (!document.hidden) void refresh()
  }
  document.addEventListener('visibilitychange', refreshWhenVisible)
  startButton.addEventListener('click', () => {
    if (!repoFilter) {
      showFeedback('请先选择项目，或从项目总览启动 Claude', true)
      return
    }
    void startSession(repoFilter, nameByRepo.get(repoFilter.toLowerCase()) ?? repoFilter)
  })
  workspaceButton.addEventListener('click', async () => {
    if (!repoFilter) {
      showFeedback('请先选择项目', true)
      return
    }
    const name = nameByRepo.get(repoFilter.toLowerCase()) ?? repoFilter
    workspaceButton.disabled = true
    try {
      const result = await window.arckeep.chooseClaudeWorkspace(repoFilter, name)
      showFeedback(result.ok ? '项目工作目录已更新：' + result.data.path : result.error, !result.ok)
    } catch (error) {
      showFeedback(error instanceof Error ? error.message : '无法更新 Claude 工作目录', true)
    } finally {
      workspaceButton.disabled = false
    }
  })

  await refresh()
  const timer = window.setInterval(() => { void refresh() }, 2500)
  return () => {
    disposed = true
    selectionVersion += 1
    window.clearInterval(timer)
    document.removeEventListener('visibilitychange', refreshWhenVisible)
  }
}

