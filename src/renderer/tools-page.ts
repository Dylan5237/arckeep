import type { ToolFixture, ToolFixtureInvalid } from '../shared/tools/fixture'
import { paramKind } from '../shared/tools/params'
import { createRunGate, formatDuration } from '../shared/tools/preview'
import { confirmButtonLabel, copyFeedback, filterActions, runStatus } from '../shared/tools/present'
import {
  directoryChoices,
  findKnownRepo,
  knownRepoSourceLabel,
  openTargetForRepo,
  type KnownRepo
} from '../shared/tools/repos'
import { SHELL_LABEL, TOOL_TYPE_LABEL, type ActionPreview, type ToolAction, type ToolRunEvent } from '../shared/tools/types'

type Gate = ReturnType<typeof createRunGate>

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

interface Line { stream: 'stdout' | 'stderr', text: string }

interface Shelf { mode: 'shelf', actions: ToolAction[], query: string }
interface Params {
  mode: 'params'
  actions: ToolAction[]
  action: ToolAction
  values: Record<string, string>
  knownRepos: KnownRepo[]
  error?: string
}
interface PreviewState {
  mode: 'preview'
  actions: ToolAction[]
  action: ToolAction
  values: Record<string, string>
  knownRepos: KnownRepo[]
  preview: ActionPreview
  gate: Gate
  notice?: string
}
interface Running {
  mode: 'running'
  actions: ToolAction[]
  action: ToolAction
  preview: ActionPreview
  runId: string
  lines: Line[]
  phase: 'running' | 'done' | 'aborted'
  exitCode: number | null
  durationMs: number
  error?: string
  notice?: string
}
interface Copied { mode: 'copied', actions: ToolAction[], title: string, text: string, notice: string }
interface Quiet { mode: 'quiet', actions: ToolAction[], message: string }
interface Problem { mode: 'problem', error: string }
interface Empty { mode: 'empty' }
interface Loading { mode: 'loading' }

type Session = Loading | Problem | Empty | Shelf | Params | PreviewState | Running | Copied | Quiet

let session: Session = { mode: 'loading' }
let host: HTMLElement | null = null
let listening = false
let goSettings: (() => void) | null = null
let removeEscape: (() => void) | null = null

function defaults(action: ToolAction): Record<string, string> {
  const values: Record<string, string> = {}
  for (const param of action.params ?? []) values[param.key] = param.default ?? ''
  return values
}

function ensureListener(): void {
  if (listening) return
  listening = true
  window.arckeep.onToolEvent(event => {
    applyRunEvent(event)
    if (host && session.mode === 'running') paint(host)
  })
}

function applyRunEvent(event: ToolRunEvent): void {
  if (session.mode !== 'running' || session.runId !== event.runId) return
  if (event.type === 'output' && event.text && event.stream) {
    session.lines.push({ stream: event.stream, text: event.text })
    return
  }
  if (event.type === 'done') {
    session.phase = event.aborted ? 'aborted' : 'done'
    session.exitCode = event.exitCode ?? null
    session.durationMs = event.durationMs ?? 0
    session.error = event.error
  }
}

function outputText(lines: Line[]): string {
  return lines.map(line => line.text).join('')
}

function paintShelf(
  page: HTMLElement,
  actions: ToolAction[],
  options: { narrow?: boolean, query?: string, onQuery?: (query: string) => void, onOpen?: (action: ToolAction) => void } = {}
): void {
  page.classList.toggle('tools-narrow', Boolean(options.narrow))
  const query = options.query ?? ''
  const shown = filterActions(actions, query)
  page.append(
    el('h1', {}, ['工具架']),
    el('p', { class: 'lede' }, [`${actions.length} 个动作。输入即筛选。确认前不会执行。`])
  )
  const search = el('input', {
    type: 'search',
    class: 'tool-search',
    placeholder: '搜索动作',
    'aria-label': '搜索动作'
  })
  search.value = query
  search.addEventListener('input', () => options.onQuery?.(search.value))
  page.append(el('label', { class: 'tool-search-label' }, ['搜索', search]))
  if (shown.length === 0) {
    page.append(el('p', { class: 'hint' }, ['没有匹配的动作']))
    return
  }
  const list = el('div', { class: 'tool-list' })
  for (const action of shown) {
    const card = el('button', { type: 'button', class: 'tool-card' }, [
      el('span', { class: 'tool-top' }, [
        el('span', { class: 'tool-title' }, [action.title]),
        el('span', { class: `chip chip-tool chip-${action.type}` }, [TOOL_TYPE_LABEL[action.type]])
      ]),
      el('span', { class: 'tool-desc' }, [action.description ?? ''])
    ])
    card.addEventListener('click', () => options.onOpen?.(action))
    list.append(card)
  }
  page.append(list)
}

async function openAction(action: ToolAction, actions: ToolAction[]): Promise<void> {
  const params = action.params ?? []
  const needsRepos = params.some(param => {
    const kind = paramKind(param)
    return kind === 'repo' || kind === 'directory'
  })
  const knownRepos = needsRepos ? await window.arckeep.getKnownRepos() : []
  if (params.length > 0) {
    session = { mode: 'params', actions, action, values: defaults(action), knownRepos }
    if (host) paint(host)
    return
  }
  await showPreview(action, actions, {})
}

async function showPreview(action: ToolAction, actions: ToolAction[], values: Record<string, string>): Promise<void> {
  const result = await window.arckeep.previewTool(action.id, values)
  if (!result.ok) {
    const knownRepos = session.mode === 'params' ? session.knownRepos : []
    session = { mode: 'params', actions, action, values, knownRepos, error: result.error }
    if (host) paint(host)
    return
  }
  const gate = createRunGate()
  gate.stage()
  const knownRepos = session.mode === 'params' ? session.knownRepos : []
  session = { mode: 'preview', actions, action, values, knownRepos, preview: result.data, gate }
  if (host) paint(host)
}

function choiceValue(kind: ReturnType<typeof paramKind>, repo: KnownRepo): string {
  if (kind === 'directory') return repo.path ?? ''
  return repo.id
}

function repoOpenHint(repos: readonly KnownRepo[], value: string): string {
  const repo = findKnownRepo(repos, value)
  if (!repo) return '从已知仓库里选一个。列表来自关注列表、GitHub 拉到的仓库和本地路径。'
  const target = openTargetForRepo(repo)
  return target.type === 'open-url' ? `将打开 ${target.text}` : `将打开文件夹 ${target.text}`
}

function paintParams(page: HTMLElement, state: Params): void {
  page.append(
    el('h1', {}, [state.action.title]),
    el('p', { class: 'lede' }, ['填写参数。下一步只生成预览，还不会执行。'])
  )
  const form = el('section', { class: 'card' }, [el('h2', {}, ['参数'])])
  const values: Record<string, string> = { ...state.values }
  const fields = new Map<string, HTMLInputElement | HTMLTextAreaElement>()
  for (const param of state.action.params ?? []) {
    const kind = paramKind(param)
    const block = el('div', { class: 'tool-field' }, [el('span', {}, [param.label])])
    if (kind === 'repo' || kind === 'directory') {
      const repos = kind === 'directory' ? directoryChoices(state.knownRepos) : state.knownRepos
      const extra: KnownRepo[] = []
      const current = values[param.key] ?? ''
      if (kind === 'directory' && current && !repos.some(repo => repo.path === current)) {
        extra.push({ id: current, label: current, github: null, path: current, sources: ['local'] })
      }
      const group = el('div', { class: 'repo-choices', role: 'radiogroup', 'aria-label': param.label })
      const choices = [...repos, ...extra]
      if (choices.length === 0) {
        group.append(el('p', { class: 'hint' }, [
          kind === 'directory'
            ? '还没有已知的本地路径，可以浏览文件夹。'
            : '还没有已知仓库。它们来自关注列表、GitHub 拉到的仓库和设置里的本地路径。'
        ]))
      }
      for (const repo of choices) {
        const value = choiceValue(kind, repo)
        const radio = el('input', { type: 'radio', name: `param-${param.key}`, value }) as HTMLInputElement
        radio.checked = current === value || current === repo.id || (repo.github !== null && current === repo.github)
        radio.addEventListener('change', () => {
          values[param.key] = value
          const hint = block.querySelector('.repo-open-hint')
          if (hint && kind === 'repo') hint.textContent = repoOpenHint(state.knownRepos, value)
        })
        group.append(el('label', { class: 'repo-choice' }, [
          radio,
          el('span', { class: 'repo-choice-label' }, [repo.label]),
          el('span', { class: 'repo-choice-source' }, [knownRepoSourceLabel(repo.sources)])
        ]))
      }
      block.append(group)
      if (kind === 'repo') block.append(el('p', { class: 'hint repo-open-hint' }, [repoOpenHint(state.knownRepos, current)]))
      if (kind === 'directory') {
        const browse = el('button', { type: 'button', class: 'ghost' }, ['浏览文件夹'])
        browse.addEventListener('click', () => {
          void window.arckeep.pickFolder().then(result => {
            if (!result.ok || result.data.cancelled) return
            values[param.key] = result.data.path
            state.values = { ...values }
            if (host) paint(host)
          })
        })
        block.append(browse)
      }
    } else if (kind === 'multiline') {
      const input = el('textarea', { 'aria-label': param.label, rows: '6' })
      input.value = values[param.key] ?? ''
      fields.set(param.key, input)
      block.append(input)
    } else {
      const input = el('input', { type: 'text', 'aria-label': param.label })
      input.value = values[param.key] ?? ''
      fields.set(param.key, input)
      block.append(input)
    }
    form.append(block)
  }
  if (state.error) form.append(el('div', { class: 'alert error', role: 'alert' }, [state.error]))
  const back = el('button', { type: 'button', class: 'ghost' }, ['返回'])
  const next = el('button', { type: 'button', class: 'primary' }, ['预览'])
  back.addEventListener('click', () => {
    session = { mode: 'shelf', actions: state.actions, query: '' }
    if (host) paint(host)
  })
  next.addEventListener('click', () => {
    for (const [key, input] of fields) values[key] = input.value
    void showPreview(state.action, state.actions, values)
  })
  form.append(el('div', { class: 'actions' }, [back, next]))
  page.append(form)
}

function previewBody(preview: ActionPreview): HTMLElement[] {
  const nodes: HTMLElement[] = []
  if (preview.shell) nodes.push(el('p', { class: 'hint' }, [`shell: ${SHELL_LABEL[preview.shell]}`]))
  if (preview.cwd && preview.type === 'run-command') nodes.push(el('p', { class: 'hint' }, [`工作目录: ${preview.cwd}`]))
  if (preview.type === 'run-command' && preview.dryRun) {
    nodes.push(el('h3', {}, ['预览（不会改动文件）']))
    nodes.push(el('pre', { class: 'tool-pre' }, [preview.dryRun]))
    nodes.push(el('h3', {}, ['确认后将执行的命令']))
    nodes.push(el('pre', { class: 'tool-pre' }, [preview.text]))
    return nodes
  }
  if (preview.type === 'run-command') nodes.push(el('h3', {}, ['确认后将执行的命令']))
  if (preview.type === 'template') nodes.push(el('h3', {}, ['将复制到剪贴板']))
  nodes.push(el('pre', { class: 'tool-pre' }, [preview.text]))
  return nodes
}

function paintPreview(page: HTMLElement, state: PreviewState): void {
  const isTemplate = state.preview.type === 'template'
  const cancel = el('button', { type: 'button', class: 'ghost' }, ['取消'])
  const confirm = el('button', { type: 'button', class: 'primary' }, [confirmButtonLabel(state.action, state.values)])
  cancel.addEventListener('click', () => {
    state.gate.cancel()
    removeEscape?.()
    session = state.action.params?.length
      ? {
          mode: 'params',
          actions: state.actions,
          action: state.action,
          values: state.values,
          knownRepos: state.knownRepos
        }
      : { mode: 'shelf', actions: state.actions, query: '' }
    if (host) paint(host)
  })
  confirm.addEventListener('click', () => { void confirmPreview(state, confirm) })
  const dialog = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': '即将执行' }, [
    el('h2', {}, [isTemplate ? '复制到剪贴板' : '即将执行']),
    el('p', { class: 'hint' }, [isTemplate ? '确认前不会写入剪贴板。' : '取消不会运行。确认前不会改动文件。']),
    ...previewBody(state.preview),
    el('div', { class: 'actions' }, [cancel, confirm])
  ])
  if (state.notice) dialog.append(el('p', { class: 'run-status run-ok', role: 'status' }, [state.notice]))
  page.append(
    el('h1', {}, [state.action.title]),
    el('div', { class: 'modal-backdrop' }, [dialog])
  )
  removeEscape?.()
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return
    cancel.click()
  }
  document.addEventListener('keydown', onKey)
  removeEscape = () => document.removeEventListener('keydown', onKey)
}

async function confirmPreview(state: PreviewState, button: HTMLButtonElement): Promise<void> {
  if (!state.gate.confirm()) return
  button.disabled = true
  const result = await window.arckeep.runTool(state.action.id, state.values)
  if (!result.ok) {
    const gate = createRunGate()
    gate.stage()
    session = { ...state, gate }
    if (host) paint(host)
    const alert = el('div', { class: 'alert error', role: 'alert' }, [result.error])
    host?.querySelector('.modal')?.append(alert)
    return
  }
  if (result.data.kind === 'run') {
    session = {
      mode: 'running',
      actions: state.actions,
      action: state.action,
      preview: state.preview,
      runId: result.data.runId,
      lines: [],
      phase: 'running',
      exitCode: null,
      durationMs: 0
    }
  } else if (result.data.kind === 'template') {
    session = {
      mode: 'copied',
      actions: state.actions,
      title: state.action.title,
      text: state.preview.text,
      notice: copyFeedback(true)
    }
  } else {
    session = { mode: 'quiet', actions: state.actions, message: '已打开' }
  }
  if (host) paint(host)
}

function paintCopied(page: HTMLElement, state: Copied): void {
  const again = el('button', { type: 'button', class: 'primary' }, ['复制'])
  again.addEventListener('click', async () => {
    const copied = await window.arckeep.copyText(state.text)
    state.notice = copyFeedback(copied.ok)
    if (host) paint(host)
  })
  const close = el('button', { type: 'button', class: 'ghost' }, ['返回工具架'])
  close.addEventListener('click', () => {
    session = { mode: 'shelf', actions: state.actions, query: '' }
    if (host) paint(host)
  })
  page.append(
    el('h1', {}, [state.title]),
    el('p', { class: `run-status ${state.notice === '已复制' ? 'run-ok' : 'run-failed'}`, role: 'status' }, [state.notice]),
    el('section', { class: 'card' }, [
      el('h2', {}, ['将复制到剪贴板']),
      el('pre', { class: 'tool-pre' }, [state.text]),
      el('div', { class: 'actions' }, [again, close])
    ])
  )
}

function streamBlock(title: string, text: string, stderr: boolean): HTMLElement[] {
  return [
    el('h2', {}, [title]),
    el('pre', { class: stderr ? 'tool-pre tool-live tool-stderr' : 'tool-pre tool-live' }, [text || '（无）'])
  ]
}

function paintRunning(page: HTMLElement, state: Running): void {
  const status = runStatus(state.phase, state.exitCode)
  const stdout = state.lines.filter(line => line.stream === 'stdout').map(line => line.text).join('')
  const stderr = state.lines.filter(line => line.stream === 'stderr').map(line => line.text).join('')
  page.append(
    el('h1', {}, [state.action.title]),
    el('p', { class: `run-status run-${status.tone}`, role: 'status' }, [status.label])
  )
  if (state.phase !== 'running' && state.durationMs > 0) {
    page.append(el('p', { class: 'hint' }, [`用时 ${formatDuration(state.durationMs)}`]))
  }
  page.append(el('pre', { class: 'tool-pre' }, [state.preview.text]))
  if (state.error) page.append(el('div', { class: 'alert error', role: 'alert' }, [state.error]))
  const output = el('section', { class: 'card tool-output-card' })
  const blocks = status.stderrFirst
    ? streamBlock('标准错误', stderr, true).concat(streamBlock('标准输出', stdout, false))
    : streamBlock('标准输出', stdout, false).concat(streamBlock('标准错误', stderr, true))
  output.append(...blocks)
  const actions = el('div', { class: 'actions' })
  if (state.phase === 'running') {
    const stop = el('button', { type: 'button', class: 'danger' }, ['中止'])
    stop.addEventListener('click', () => { void window.arckeep.abortTool(state.runId) })
    actions.append(stop)
  } else {
    const copy = el('button', { type: 'button', class: 'primary' }, ['复制输出'])
    copy.addEventListener('click', async () => {
      const copied = await window.arckeep.copyText(outputText(state.lines))
      state.notice = copied.ok ? '已复制' : copied.error
      if (host) paint(host)
    })
    const close = el('button', { type: 'button', class: 'ghost' }, ['关闭'])
    close.addEventListener('click', () => {
      session = { mode: 'shelf', actions: state.actions, query: '' }
      if (host) paint(host)
    })
    actions.append(copy, close)
  }
  if (state.notice) actions.append(el('span', { class: 'hint' }, [state.notice]))
  output.append(actions)
  page.append(output)
  for (const pre of output.querySelectorAll('pre')) pre.scrollTop = pre.scrollHeight
}

function paint(target: HTMLElement): void {
  const page = el('section', { class: 'page tools' })
  if (session.mode === 'loading') page.append(el('h1', {}, ['工具架']), el('p', { class: 'lede' }, ['正在读取动作']))
  else if (session.mode === 'problem') {
    page.append(
      el('h1', {}, ['工具架']),
      el('div', { class: 'alert error', role: 'alert' }, [session.error]),
      settingsButton()
    )
  } else if (session.mode === 'empty') {
    page.append(
      el('h1', {}, ['工具架']),
      el('section', { class: 'card' }, [
        el('h2', {}, ['工具架还是空的']),
        el('p', { class: 'hint' }, ['在设置里写入动作 JSON，或填入示例后再保存。']),
        settingsButton()
      ])
    )
  } else if (session.mode === 'shelf') {
    paintShelf(page, session.actions, {
      query: session.query,
      onQuery: query => {
        session = { mode: 'shelf', actions: session.mode === 'shelf' ? session.actions : [], query }
        if (host) {
          paint(host)
          const input = host.querySelector<HTMLInputElement>('.tool-search')
          if (input) {
            input.focus()
            const end = input.value.length
            input.setSelectionRange(end, end)
          }
        }
      },
      onOpen: action => {
        const actions = session.mode === 'shelf' ? session.actions : []
        void openAction(action, actions)
      }
    })
  } else if (session.mode === 'params') paintParams(page, session)
  else if (session.mode === 'preview') paintPreview(page, session)
  else if (session.mode === 'running') paintRunning(page, session)
  else if (session.mode === 'copied') paintCopied(page, session)
  else if (session.mode === 'quiet') {
    const actions = session.actions
    page.append(
      el('h1', {}, ['工具架']),
      el('div', { class: 'alert', role: 'status' }, [session.message]),
      el('div', { class: 'actions' }, [(() => {
        const back = el('button', { type: 'button', class: 'primary' }, ['返回工具架'])
        back.addEventListener('click', () => {
          session = { mode: 'shelf', actions, query: '' }
          if (host) paint(host)
        })
        return back
      })()])
    )
  }
  target.replaceChildren(page)
}

function settingsButton(): HTMLButtonElement {
  const button = el('button', { type: 'button', class: 'primary' }, ['去设置'])
  button.addEventListener('click', () => goSettings?.())
  return button
}

function paintFixture(target: HTMLElement, fixture: Exclude<ToolFixture, ToolFixtureInvalid>): void {
  const page = el('section', { class: 'page tools' })
  if (fixture.scene === 'empty') {
    page.append(
      el('h1', {}, ['工具架']),
      el('section', { class: 'card' }, [
        el('h2', {}, ['工具架还是空的']),
        el('p', { class: 'hint' }, ['在设置里写入动作 JSON，或填入示例后再保存。']),
        el('button', { type: 'button', class: 'primary' }, ['去设置'])
      ])
    )
  } else if (fixture.scene === 'shelf' || fixture.scene === 'narrow') {
    paintShelf(page, fixture.actions, { narrow: fixture.scene === 'narrow', query: fixture.query ?? '' })
  } else if (fixture.scene === 'params') {
    paintParams(page, {
      mode: 'params',
      actions: [fixture.action],
      action: fixture.action,
      values: fixture.values,
      knownRepos: fixture.knownRepos
    })
  } else if (fixture.scene === 'preview') {
    const gate = createRunGate()
    gate.stage()
    const action = fixture.action
    if (action.type !== 'run-command') return
    paintPreview(page, {
      mode: 'preview',
      actions: [action],
      action,
      values: fixture.values,
      knownRepos: [],
      gate,
      preview: {
        actionId: action.id,
        title: action.title,
        type: 'run-command',
        text: fixture.previewText,
        dryRun: fixture.dryRun,
        shell: 'powershell',
        cwd: fixture.cwd
      }
    })
  } else if (fixture.scene === 'copied') {
    paintCopied(page, {
      mode: 'copied',
      actions: [],
      title: fixture.title,
      text: fixture.text,
      notice: copyFeedback(true)
    })
  } else if (
    fixture.scene === 'running'
    || fixture.scene === 'success'
    || fixture.scene === 'failed'
    || fixture.scene === 'aborted'
  ) {
    const action = shelfStub(fixture.title)
    const phase = fixture.scene === 'running' ? 'running' : fixture.scene === 'aborted' ? 'aborted' : 'done'
    const exitCode = fixture.scene === 'failed' ? 3 : fixture.scene === 'success' ? 0 : null
    paintRunning(page, {
      mode: 'running',
      actions: [],
      action,
      preview: {
        actionId: action.id,
        title: fixture.title,
        type: 'run-command',
        text: fixture.command,
        shell: 'powershell',
        cwd: 'C:\\work\\demo'
      },
      runId: 'fixture',
      lines: fixture.lines,
      phase,
      exitCode,
      durationMs: fixture.scene === 'failed' || fixture.scene === 'success' ? 1400 : 0
    })
  }
  target.replaceChildren(page)
}

function shelfStub(title: string): ToolAction {
  return {
    id: 'fixture-run',
    title,
    type: 'run-command',
    shell: 'powershell',
    command: 'echo fixture'
  }
}

export async function renderTools(target: HTMLElement, settings: () => void): Promise<void> {
  host = target
  goSettings = settings
  ensureListener()
  const fixture = await window.arckeep.getToolFixture()
  if (fixture && fixture.page === 'tools') {
    paintFixture(target, fixture)
    return
  }
  if (session.mode === 'loading' || session.mode === 'shelf' || session.mode === 'empty' || session.mode === 'problem') {
    const catalog = await window.arckeep.getToolCatalog()
    const query = session.mode === 'shelf' ? session.query : ''
    if (!catalog.ok) session = { mode: 'problem', error: catalog.error }
    else if (catalog.actions.length === 0) session = { mode: 'empty' }
    else session = { mode: 'shelf', actions: catalog.actions, query }
  }
  paint(target)
}
