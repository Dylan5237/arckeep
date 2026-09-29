import type { ToolFixture } from '../shared/tools/fixture'
import { createRunGate, formatDuration } from '../shared/tools/preview'
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

interface Shelf { mode: 'shelf', actions: ToolAction[] }
interface Params { mode: 'params', actions: ToolAction[], action: ToolAction, values: Record<string, string>, error?: string }
interface PreviewState { mode: 'preview', actions: ToolAction[], action: ToolAction, values: Record<string, string>, preview: ActionPreview, gate: Gate }
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
interface Quiet { mode: 'quiet', actions: ToolAction[], message: string }
interface Problem { mode: 'problem', error: string }
interface Empty { mode: 'empty' }
interface Loading { mode: 'loading' }

type Session = Loading | Problem | Empty | Shelf | Params | PreviewState | Running | Quiet

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

function statusText(state: Running): string {
  if (state.phase === 'running') return '运行中'
  if (state.phase === 'aborted') return '已终止'
  const code = state.exitCode === null ? '无' : String(state.exitCode)
  return `退出码 ${code} · 用时 ${formatDuration(state.durationMs)}`
}

function outputText(lines: Line[]): string {
  return lines.map(line => line.text).join('')
}

function paintShelf(page: HTMLElement, actions: ToolAction[], narrow = false): void {
  page.classList.toggle('tools-narrow', narrow)
  page.append(
    el('h1', {}, ['工具架']),
    el('p', { class: 'lede' }, [`${actions.length} 个动作。先填参数，再看展开结果，确认才会执行。`])
  )
  const list = el('div', { class: 'tool-list' })
  for (const action of actions) {
    const use = el('button', { type: 'button', class: 'primary' }, ['使用'])
    use.addEventListener('click', () => { void openAction(action, actions) })
    list.append(el('article', { class: 'tool-card' }, [
      el('div', { class: 'tool-top' }, [
        el('h2', {}, [action.title]),
        el('span', { class: `chip chip-tool chip-${action.type}` }, [TOOL_TYPE_LABEL[action.type]])
      ]),
      el('p', {}, [action.description ?? '']),
      use
    ]))
  }
  page.append(list)
}

async function openAction(action: ToolAction, actions: ToolAction[]): Promise<void> {
  const params = action.params ?? []
  if (params.length > 0) {
    session = { mode: 'params', actions, action, values: defaults(action) }
    if (host) paint(host)
    return
  }
  await showPreview(action, actions, {})
}

async function showPreview(action: ToolAction, actions: ToolAction[], values: Record<string, string>): Promise<void> {
  const result = await window.arckeep.previewTool(action.id, values)
  if (!result.ok) {
    session = { mode: 'params', actions, action, values, error: result.error }
    if (host) paint(host)
    return
  }
  const gate = createRunGate()
  gate.stage()
  session = { mode: 'preview', actions, action, values, preview: result.data, gate }
  if (host) paint(host)
}

function paintParams(page: HTMLElement, state: Params): void {
  page.append(
    el('h1', {}, [state.action.title]),
    el('p', { class: 'lede' }, ['填写参数。下一步只生成预览，还不会执行。'])
  )
  const form = el('section', { class: 'card' }, [el('h2', {}, ['参数'])])
  const inputs = new Map<string, HTMLTextAreaElement>()
  for (const param of state.action.params ?? []) {
    const input = el('textarea', { 'aria-label': param.label, rows: '2' })
    input.value = state.values[param.key] ?? ''
    inputs.set(param.key, input)
    form.append(el('label', { class: 'tool-field' }, [param.label, input]))
  }
  if (state.error) form.append(el('div', { class: 'alert error', role: 'alert' }, [state.error]))
  const back = el('button', { type: 'button', class: 'ghost' }, ['返回'])
  const next = el('button', { type: 'button', class: 'primary' }, ['预览'])
  back.addEventListener('click', () => {
    session = { mode: 'shelf', actions: state.actions }
    if (host) paint(host)
  })
  next.addEventListener('click', () => {
    const values: Record<string, string> = {}
    for (const [key, input] of inputs) values[key] = input.value
    void showPreview(state.action, state.actions, values)
  })
  form.append(el('div', { class: 'actions' }, [back, next]))
  page.append(form)
}

function paintPreview(page: HTMLElement, state: PreviewState): void {
  paintShelf(page, state.actions)
  const lines = [state.preview.text]
  if (state.preview.shell) lines.unshift(`shell: ${SHELL_LABEL[state.preview.shell]}`)
  if (state.preview.type === 'run-command' && state.preview.cwd) lines.splice(state.preview.shell ? 1 : 0, 0, `工作目录: ${state.preview.cwd}`)
  const cancel = el('button', { type: 'button', class: 'ghost' }, ['取消'])
  const confirm = el('button', { type: 'button', class: 'primary' }, ['确认执行'])
  cancel.addEventListener('click', () => {
    state.gate.cancel()
    session = state.action.params?.length
      ? { mode: 'params', actions: state.actions, action: state.action, values: state.values }
      : { mode: 'shelf', actions: state.actions }
    if (host) paint(host)
  })
  confirm.addEventListener('click', () => { void confirmPreview(state, confirm) })
  const dialog = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': '即将执行' }, [
    el('h2', {}, ['即将执行']),
    el('p', { class: 'hint' }, ['下面是展开后的内容。取消不会运行。']),
    el('pre', { class: 'tool-pre' }, [lines.join('\n')]),
    el('div', { class: 'actions' }, [cancel, confirm])
  ])
  page.append(el('div', { class: 'modal-backdrop' }, [dialog]))
  removeEscape?.()
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return
    removeEscape?.()
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
    session = { mode: 'quiet', actions: state.actions, message: '已复制' }
  } else {
    session = { mode: 'quiet', actions: state.actions, message: '已打开' }
  }
  if (host) paint(host)
}

function paintRunning(page: HTMLElement, state: Running): void {
  const stdout = state.lines.filter(line => line.stream === 'stdout').map(line => line.text).join('')
  const stderr = state.lines.filter(line => line.stream === 'stderr').map(line => line.text).join('')
  page.append(
    el('h1', {}, [state.action.title]),
    el('p', { class: 'waiting-summary' }, [statusText(state)]),
    el('pre', { class: 'tool-pre' }, [state.preview.text])
  )
  if (state.error) page.append(el('div', { class: 'alert error', role: 'alert' }, [state.error]))
  const output = el('section', { class: 'card tool-output-card' })
  output.append(el('h2', {}, ['标准输出']), el('pre', { class: 'tool-pre tool-live', id: 'tool-stdout' }, [stdout || '（无）']))
  output.append(el('h2', {}, ['标准错误']), el('pre', { class: 'tool-pre tool-live tool-stderr', id: 'tool-stderr' }, [stderr || '（无）']))
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
      session = { mode: 'shelf', actions: state.actions }
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
  } else if (session.mode === 'shelf') paintShelf(page, session.actions)
  else if (session.mode === 'params') paintParams(page, session)
  else if (session.mode === 'preview') paintPreview(page, session)
  else if (session.mode === 'running') paintRunning(page, session)
  else if (session.mode === 'quiet') {
    const actions = session.actions
    page.append(
      el('h1', {}, ['工具架']),
      el('div', { class: 'alert', role: 'status' }, [session.message]),
      el('div', { class: 'actions' }, [(() => {
        const back = el('button', { type: 'button', class: 'primary' }, ['返回工具架'])
        back.addEventListener('click', () => {
          session = { mode: 'shelf', actions }
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

function paintFixture(target: HTMLElement, fixture: Exclude<ToolFixture, { page: 'settings' }>): void {
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
    paintShelf(page, fixture.actions, fixture.scene === 'narrow')
  } else if (fixture.scene === 'params') {
    paintParams(page, {
      mode: 'params',
      actions: [fixture.action],
      action: fixture.action,
      values: fixture.values
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
      values: {},
      gate,
      preview: {
        actionId: action.id,
        title: action.title,
        type: 'run-command',
        text: fixture.previewText,
        shell: 'powershell',
        cwd: fixture.cwd
      }
    })
  } else if (fixture.scene === 'running' || fixture.scene === 'exit' || fixture.scene === 'aborted') {
    const action = shelfStub(fixture.title)
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
      phase: fixture.scene === 'running' ? 'running' : fixture.scene === 'aborted' ? 'aborted' : 'done',
      exitCode: fixture.scene === 'exit' ? 3 : null,
      durationMs: fixture.scene === 'exit' ? 1400 : 0
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
    if (!catalog.ok) session = { mode: 'problem', error: catalog.error }
    else if (catalog.actions.length === 0) session = { mode: 'empty' }
    else if (session.mode !== 'shelf') session = { mode: 'shelf', actions: catalog.actions }
    else session = { mode: 'shelf', actions: catalog.actions }
  }
  paint(target)
}
