// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ArckeepApi, CaptureDraft, IdeaInput } from '../src/shared/types.js'

const html = readFileSync(path.resolve('src/renderer/capture.html'), 'utf8')
const listeners: Array<{ target: EventTarget, name: string, listener: EventListenerOrEventListenerObject }> = []

afterEach(() => {
  for (const entry of listeners.splice(0)) entry.target.removeEventListener(entry.name, entry.listener)
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

function deferred<T>(): { promise: Promise<T>, resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  return { promise: new Promise<T>(done => { resolve = done }), resolve: value => resolve(value) }
}

async function mount(overrides: Partial<ArckeepApi> = {}) {
  vi.resetModules()
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('<script'))
  for (const target of [window, document]) {
    const original = target.addEventListener.bind(target)
    vi.spyOn(target, 'addEventListener').mockImplementation((name, listener, options) => {
      if (listener) listeners.push({ target, name, listener: listener as EventListenerOrEventListenerObject })
      original(name, listener, options)
    })
  }
  const api = {
    todoRepoOptions: vi.fn(async () => ['example/demo']),
    getCaptureDraft: vi.fn(async (): Promise<CaptureDraft> => ({ text: '', repo: '', waiting: false })),
    setCaptureDraft: vi.fn(async (draft: CaptureDraft) => ({ ...draft })),
    createIdea: vi.fn(async (input: IdeaInput) => ({ ok: true as const, data: {
      ...input, id: 'idea-1', createdAt: '2026-10-04T00:00:00.000Z', updatedAt: '2026-10-04T00:00:00.000Z'
    } })),
    createTodo: vi.fn(async (input: Parameters<ArckeepApi['createTodo']>[0]) => ({ ok: true as const, data: {
      ...input, id: 'todo-1', createdAt: '2026-10-04T00:00:00.000Z', updatedAt: '2026-10-04T00:00:00.000Z',
      completed: false, waitingSince: null
    } })),
    closeCapture: vi.fn(async () => {}),
    ...overrides
  }
  window.arckeep = api as unknown as ArckeepApi
  await import('../src/renderer/capture.ts')
  await flush()
  const field = <T extends HTMLElement>(selector: string): T => {
    const node = document.querySelector<T>(selector)
    if (!node) throw new Error(`Missing ${selector}`)
    return node
  }
  const kind = field<HTMLSelectElement>('#capture-kind')
  return {
    api,
    text: field<HTMLInputElement>('#text'),
    idea: field<HTMLTextAreaElement>('#idea-text'),
    repo: field<HTMLInputElement>('#repo'),
    waiting: field<HTMLInputElement>('#waiting'),
    button: field<HTMLButtonElement>('#capture-save'),
    error: field<HTMLElement>('#error'),
    kind,
    select(value: 'idea' | 'todo') {
      kind.value = value
      kind.dispatchEvent(new Event('change', { bubbles: true }))
    }
  }
}

function enter(field: HTMLElement, options: KeyboardEventInit = {}): void {
  field.focus()
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...options }))
}

describe('idea quick capture', () => {
  it('saves literal multiline ideas separately, without todo shorthand or waiting state', async () => {
    const view = await mount()
    view.waiting.checked = true
    view.select('idea')
    view.idea.value = '  第一行 #example/demo !等我\n第二行 <script>literal</script>\n  '
    view.repo.value = 'example/demo'
    view.idea.dispatchEvent(new Event('input'))
    enter(view.idea)
    await flush()
    expect(view.api.createIdea).toHaveBeenCalledWith({ text: view.idea.value, repo: 'example/demo' })
    expect(view.api.createTodo).not.toHaveBeenCalled()
    expect(view.api.closeCapture).toHaveBeenCalledWith('saved')
    expect(document.querySelector<HTMLElement>('#capture-wait')?.hidden).toBe(true)
  })

  it('allows Shift+Enter and IME composition without saving, then saves without a repo', async () => {
    const view = await mount()
    view.select('idea')
    view.idea.value = '无需仓库也可以记下'
    enter(view.idea, { shiftKey: true })
    enter(view.idea, { isComposing: true })
    await flush()
    expect(view.api.createIdea).not.toHaveBeenCalled()
    expect(view.api.closeCapture).not.toHaveBeenCalled()
    enter(view.idea)
    await flush()
    expect(view.api.createIdea).toHaveBeenCalledWith({ text: '无需仓库也可以记下', repo: null })
  })

  it('keeps the failed body and its recoverable draft, without closing', async () => {
    const view = await mount({ createIdea: vi.fn(async () => ({ ok: false, error: '写入失败' })) })
    view.select('idea')
    view.idea.value = '保留这段\n未保存的正文'
    view.idea.dispatchEvent(new Event('input'))
    enter(view.idea)
    await flush()
    expect(view.error.textContent).toBe('写入失败')
    expect(view.idea.value).toBe('保留这段\n未保存的正文')
    expect(view.idea.disabled).toBe(false)
    expect(view.api.setCaptureDraft).toHaveBeenLastCalledWith({
      kind: 'idea', text: '保留这段\n未保存的正文', repo: '', waiting: false
    })
    expect(view.api.closeCapture).not.toHaveBeenCalled()
  })

  it('restores the idea mode and preserves it when dismissed', async () => {
    const draft: CaptureDraft = { kind: 'idea', text: `多行\n${'字'.repeat(700)}`, repo: '', waiting: false }
    const view = await mount({ getCaptureDraft: async () => draft })
    expect(view.kind.value).toBe('idea')
    expect(view.idea.value).toBe(draft.text)
    expect(document.activeElement).toBe(view.idea)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await flush()
    expect(view.api.setCaptureDraft).toHaveBeenLastCalledWith(draft)
    expect(view.api.closeCapture).toHaveBeenCalledWith('dismiss')
    expect(view.api.createIdea).not.toHaveBeenCalled()
  })

  it('prevents multiline or overlong ideas from being silently truncated into todos', async () => {
    const view = await mount()
    view.text.value = '单行内容'
    view.select('idea')
    expect(view.idea.value).toBe('单行内容')
    view.select('todo')
    expect(view.text.value).toBe('单行内容')
    view.select('idea')
    for (const body of ['多行\n正文', '字'.repeat(501)]) {
      view.idea.value = body
      view.select('todo')
      expect(view.kind.value).toBe('idea')
      expect(view.idea.value).toBe(body)
      expect(view.error.hidden).toBe(false)
    }
  })

  it('uses a fixed destination while repo options are loading and ignores duplicate saves', async () => {
    const repos = deferred<string[]>()
    const view = await mount({ todoRepoOptions: () => repos.promise })
    view.select('idea')
    view.idea.value = '固定保存为灵感'
    enter(view.idea)
    expect(view.kind.disabled).toBe(true)
    view.kind.value = 'todo'
    view.kind.dispatchEvent(new Event('change'))
    view.button.click()
    repos.resolve(['example/demo'])
    await flush()
    expect(view.api.createIdea).toHaveBeenCalledTimes(1)
    expect(view.api.createIdea).toHaveBeenCalledWith({ text: '固定保存为灵感', repo: null })
    expect(view.api.createTodo).not.toHaveBeenCalled()
  })

  it('does not restore a late draft over a newly selected mode or typed body', async () => {
    const loaded = deferred<CaptureDraft>()
    const view = await mount({ getCaptureDraft: () => loaded.promise })
    view.select('idea')
    loaded.resolve({ text: '旧待办草稿', repo: 'old/repo', waiting: true })
    await flush()
    expect(view.kind.value).toBe('idea')
    expect(view.idea.value).toBe('')
    expect(view.repo.value).toBe('')
  })

  it('retries only window closing if a saved idea could not close the capture window', async () => {
    const close = vi.fn<ArckeepApi['closeCapture']>().mockRejectedValueOnce(new Error('关闭失败')).mockResolvedValue(undefined)
    const view = await mount({ closeCapture: close })
    view.select('idea')
    view.idea.value = '只能保存一份'
    enter(view.idea)
    await flush()
    expect(view.api.createIdea).toHaveBeenCalledTimes(1)
    expect(view.button.textContent).toBe('关闭窗口')
    expect(view.idea.disabled).toBe(true)
    view.button.click()
    await flush()
    expect(view.api.createIdea).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(2)
  })

  it('keeps the existing todo shorthand in the full capture markup', async () => {
    const view = await mount()
    view.select('todo')
    view.text.value = '要做的事 #example/demo !等我'
    enter(view.text)
    await flush()
    expect(view.api.createTodo).toHaveBeenCalledWith({ text: '要做的事', repo: 'example/demo', waiting: true })
    expect(view.api.createIdea).not.toHaveBeenCalled()
  })

  it('opens in idea mode when there is no draft', async () => {
    const view = await mount()
    expect(view.kind.value).toBe('idea')
    expect(view.text.hidden).toBe(true)
    expect(view.idea.hidden).toBe(false)
    expect(document.querySelector<HTMLElement>('#capture-wait')?.hidden).toBe(true)
    expect(view.button.textContent).toBe('记下灵感')
    view.idea.value = '默认记成灵感'
    enter(view.idea)
    await flush()
    expect(view.api.createIdea).toHaveBeenCalledWith({ text: '默认记成灵感', repo: null })
    expect(view.api.createTodo).not.toHaveBeenCalled()
  })

  it('restores a legacy todo draft in todo mode instead of the new default', async () => {
    const view = await mount({
      getCaptureDraft: async () => ({ text: '旧待办正文', repo: 'example/demo', waiting: true })
    })
    expect(view.kind.value).toBe('todo')
    expect(view.text.value).toBe('旧待办正文')
    expect(view.repo.value).toBe('example/demo')
    expect(view.waiting.checked).toBe(true)
    expect(view.button.textContent).toBe('记下待办')
    expect(view.text.hidden).toBe(false)
    expect(view.idea.hidden).toBe(true)
  })
})
