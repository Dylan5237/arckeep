// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PromptInput, PromptItem, PromptUpdate } from '../src/shared/prompts/types.js'
import type { ArckeepApi, IpcResult } from '../src/shared/types.js'

let page: typeof import('../src/renderer/prompts-page.js')

function prompt(id: string, title: string, text = `${title} 正文`, tags: string[] = [], pinned = false): PromptItem {
  return { id, title, text, tags, pinned, createdAt: '2026-10-08T01:00:00.000Z', updatedAt: '2026-10-08T01:00:00.000Z' }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(complete => { resolve = complete })
  return { promise, resolve }
}

function makeHarness(initial: PromptItem[] = []) {
  let items = [...initial]
  let listener: (() => void) | null = null
  let unsubscribeCount = 0
  const raw = {
    listPrompts: vi.fn(async (): Promise<IpcResult<PromptItem[]>> => ({ ok: true, data: [...items] })),
    createPrompt: vi.fn(async (input: PromptInput): Promise<IpcResult<PromptItem>> => {
      const saved = { ...prompt('new', input.title), ...input }
      items = [saved, ...items]
      listener?.()
      return { ok: true, data: saved }
    }),
    updatePrompt: vi.fn(async (input: PromptUpdate): Promise<IpcResult<PromptItem>> => {
      const saved = { ...items.find(item => item.id === input.id)!, ...input }
      items = items.map(item => item.id === saved.id ? saved : item)
      listener?.()
      return { ok: true, data: saved }
    }),
    deletePrompt: vi.fn(async (id: string): Promise<IpcResult<{ id: string }>> => {
      items = items.filter(item => item.id !== id)
      listener?.()
      return { ok: true, data: { id } }
    }),
    setPromptPinned: vi.fn(async (id: string, pinned: boolean): Promise<IpcResult<PromptItem>> => {
      const saved = { ...items.find(item => item.id === id)!, pinned }
      items = items.map(item => item.id === id ? saved : item)
      listener?.()
      return { ok: true, data: saved }
    }),
    copyText: vi.fn(async (_text: string): Promise<IpcResult<true>> => ({ ok: true, data: true })),
    onPromptsChanged: vi.fn((changed: () => void) => {
      listener = changed
      return () => { unsubscribeCount++; listener = null }
    })
  }
  return {
    raw, api: raw as unknown as ArckeepApi, notify: () => listener?.(),
    replace: (next: PromptItem[]) => { items = next; listener?.() },
    unsubscribeCount: () => unsubscribeCount
  }
}

async function mount(api: ArckeepApi): Promise<HTMLElement> {
  document.body.replaceChildren()
  const target = document.createElement('main')
  document.body.append(target)
  window.arckeep = api
  await page.renderPrompts(target)
  return target
}

function click(target: HTMLElement, action: string): void {
  target.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!.click()
}

function input(target: HTMLElement, selector: string, value: string): HTMLInputElement | HTMLTextAreaElement {
  const field = target.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!
  field.value = value
  field.dispatchEvent(new Event('input', { bubbles: true }))
  return field
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

beforeEach(async () => {
  vi.resetModules()
  page = await import('../src/renderer/prompts-page.js')
})

afterEach(() => {
  page.deactivatePrompts()
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('prompt library page', () => {
  it('keeps the list compact, views safe text, and copies the exact original repeatedly', async () => {
    const original = '  <img src=x onerror=alert(1)>\r\n\tKeep  spaces\n' + 'long '.repeat(100)
    const harness = makeHarness([prompt('one', '<script>review</script>', original)])
    const target = await mount(harness.api)
    expect(document.activeElement).toBe(target.querySelector('.prompt-search'))
    expect(target.querySelector('.prompt-preview')?.textContent).toBe(original.slice(0, 240))
    expect(target.querySelector('.prompt-full-text')).toBeNull()
    expect(target.querySelector('script')).toBeNull()
    click(target, 'view-prompt')
    expect(target.querySelector('.prompt-full-text')?.textContent).toBe(original)
    expect(target.querySelector('.prompt-full-text img')).toBeNull()
    click(target, 'copy-prompt')
    await settle()
    expect(harness.raw.copyText).toHaveBeenCalledWith(original)
    expect(target.querySelector('[data-action="copy-prompt"]')?.textContent).toBe('已复制')
    click(target, 'copy-prompt')
    await settle()
    expect(harness.raw.copyText).toHaveBeenCalledTimes(2)
  })

  it('searches titles, body and tags with local case-insensitive AND and phrases', async () => {
    const harness = makeHarness([
      prompt('one', 'Review CODE', 'strict adversarial review', ['工程']),
      prompt('two', 'Review doc', 'review carefully', ['文档'])
    ])
    const target = await mount(harness.api)
    input(target, '.prompt-search', 'code 工程 "adversarial review"')
    expect([...target.querySelectorAll<HTMLElement>('.prompt-entry')].map(row => row.dataset.promptId)).toEqual(['one'])
    input(target, '.prompt-search', 'REVIEW 文档')
    expect(target.querySelector<HTMLElement>('.prompt-entry')?.dataset.promptId).toBe('two')
    expect(harness.raw.listPrompts).toHaveBeenCalledTimes(1)
    input(target, '.prompt-search', 'does-not-exist')
    expect(target.querySelector('.prompts-empty')?.textContent).toContain('没有匹配')
  })

  it('waits for IME completion before filtering and supports tag selection', async () => {
    const harness = makeHarness([prompt('one', '审查', '正文', ['代码']), prompt('two', '写作', '正文', ['文档'])])
    const target = await mount(harness.api)
    const search = target.querySelector<HTMLInputElement>('.prompt-search')!
    search.dispatchEvent(new Event('compositionstart'))
    input(target, '.prompt-search', '审查')
    expect(target.querySelectorAll('.prompt-entry')).toHaveLength(2)
    search.dispatchEvent(new Event('compositionend'))
    expect(target.querySelectorAll('.prompt-entry')).toHaveLength(1)
    input(target, '.prompt-search', '')
    const tags = target.querySelector<HTMLSelectElement>('[aria-label="筛选提示词标签"]')!
    tags.value = '文档'
    tags.dispatchEvent(new Event('change'))
    expect(target.querySelector<HTMLElement>('.prompt-entry')?.dataset.promptId).toBe('two')
  })

  it('sorts pinned entries first and persists toggles', async () => {
    const harness = makeHarness([prompt('one', 'A'), prompt('two', 'B', '正文', [], true)])
    const target = await mount(harness.api)
    expect(target.querySelector<HTMLElement>('.prompt-entry')?.dataset.promptId).toBe('two')
    click(target, 'pin-prompt')
    await settle()
    expect(harness.raw.setPromptPinned).toHaveBeenCalledWith('two', false)
    expect(target.querySelector<HTMLElement>('.prompt-entry')?.dataset.promptId).toBe('one')
  })

  it('opens a new form explicitly and saves tags, pinning and untouched body whitespace', async () => {
    const harness = makeHarness()
    const target = await mount(harness.api)
    expect(target.querySelector('.prompt-editor')).toBeNull()
    click(target, 'new-prompt')
    input(target, '#prompt-title', '代码审查')
    const original = '  First line\n\n\tlast line  '
    input(target, '#prompt-text', original)
    input(target, '#prompt-tags', '工程, 审查，工程')
    const pinned = target.querySelector<HTMLInputElement>('#prompt-pinned')!
    pinned.checked = true
    pinned.dispatchEvent(new Event('change'))
    click(target, 'save-prompt')
    await settle()
    expect(harness.raw.createPrompt).toHaveBeenCalledWith({ title: '代码审查', text: original, tags: ['工程', '审查'], pinned: true })
    expect(target.querySelector('.prompt-editor')).toBeNull()
    expect(target.querySelector('.prompt-title')?.textContent).toBe('代码审查')
  })

  it('preserves failed creation input and unlocks the form for retry', async () => {
    const harness = makeHarness()
    harness.raw.createPrompt.mockResolvedValue({ ok: false, error: '磁盘写入失败' })
    const target = await mount(harness.api)
    click(target, 'new-prompt')
    input(target, '#prompt-title', '未保存标题')
    const text = input(target, '#prompt-text', '保留的正文\n第二行')
    input(target, '#prompt-tags', '草稿')
    click(target, 'save-prompt')
    await settle()
    expect(target.querySelector('#prompt-text')).toBe(text)
    expect(text.value).toBe('保留的正文\n第二行')
    expect(text.disabled).toBe(false)
    expect(target.querySelector('[role="alert"]')?.textContent).toBe('磁盘写入失败')
  })

  it('shows tag limits and prevents an invalid save', async () => {
    const target = await mount(makeHarness().api)
    click(target, 'new-prompt')
    input(target, '#prompt-title', '标题')
    input(target, '#prompt-text', '正文')
    input(target, '#prompt-tags', Array.from({ length: 13 }, (_, index) => `tag-${index}`).join(','))
    expect(target.querySelector<HTMLButtonElement>('[data-action="save-prompt"]')?.disabled).toBe(true)
    expect(target.querySelector('.prompt-validation')?.textContent).toBe('最多 12 个标签。')
  })

  it('deduplicates tag case variants before validation and keeps the first spelling', async () => {
    const harness = makeHarness()
    const target = await mount(harness.api)
    click(target, 'new-prompt')
    input(target, '#prompt-title', '标题')
    input(target, '#prompt-text', '正文')
    input(target, '#prompt-tags', ['Review', ...Array.from({ length: 13 }, () => 'review'), 'CODE', 'code'].join(','))
    expect(target.querySelector<HTMLButtonElement>('[data-action="save-prompt"]')?.disabled).toBe(false)
    click(target, 'save-prompt')
    await settle()
    expect(harness.raw.createPrompt.mock.calls[0][0].tags).toEqual(['Review', 'CODE'])
  })

  it('keeps the edit draft and focus through change notifications', async () => {
    const harness = makeHarness([prompt('one', '旧标题')])
    const target = await mount(harness.api)
    click(target, 'edit-prompt')
    const text = input(target, '#prompt-text', '正在写的正文\n不要覆盖')
    text.focus()
    harness.replace([prompt('one', '外部更新', '外部正文')])
    await settle()
    expect(target.querySelector('#prompt-text')).toBe(text)
    expect(text.value).toBe('正在写的正文\n不要覆盖')
    expect(document.activeElement).toBe(text)
    click(target, 'save-prompt')
    await settle()
    expect(harness.raw.updatePrompt).toHaveBeenCalledWith({ id: 'one', title: '旧标题', text: '正在写的正文\n不要覆盖', tags: [], pinned: false })
  })

  it('preserves original CRLF when only a title is edited', async () => {
    const original = '  first\r\n\r\n\tlast  '
    const harness = makeHarness([prompt('one', '标题', original)])
    const target = await mount(harness.api)
    click(target, 'edit-prompt')
    input(target, '#prompt-title', '新标题')
    click(target, 'save-prompt')
    await settle()
    expect(harness.raw.updatePrompt.mock.calls[0][0].text).toBe(original)
  })

  it('edits and copies the saved body even while the post-save list refresh is pending', async () => {
    const original = prompt('one', '标题', 'ORIGINAL')
    const harness = makeHarness([original])
    const target = await mount(harness.api)
    const pendingList = deferred<IpcResult<PromptItem[]>>()
    harness.raw.listPrompts.mockImplementation(() => pendingList.promise)
    let saved = original
    harness.raw.updatePrompt.mockImplementation(async input => {
      saved = { ...saved, ...input }
      return { ok: true, data: saved }
    })
    click(target, 'edit-prompt')
    input(target, '#prompt-text', 'SAVED NEW BODY')
    click(target, 'save-prompt')
    await settle()
    expect(target.querySelector('.prompt-preview')?.textContent).toBe('SAVED NEW BODY')
    click(target, 'copy-prompt')
    await settle()
    expect(harness.raw.copyText).toHaveBeenCalledWith('SAVED NEW BODY')
    click(target, 'edit-prompt')
    expect(target.querySelector<HTMLTextAreaElement>('#prompt-text')?.value).toBe('SAVED NEW BODY')
    pendingList.resolve({ ok: true, data: [saved] })
    await settle()
    expect(target.querySelector<HTMLTextAreaElement>('#prompt-text')?.value).toBe('SAVED NEW BODY')
    click(target, 'save-prompt')
    await settle()
    expect(harness.raw.updatePrompt.mock.calls[1][0].text).toBe('SAVED NEW BODY')
  })

  it('locks pending edits, ignores repeated save and keeps input after failure', async () => {
    const pending = deferred<IpcResult<PromptItem>>()
    const harness = makeHarness([prompt('one', '标题')])
    harness.raw.updatePrompt.mockImplementation(() => pending.promise)
    const target = await mount(harness.api)
    click(target, 'edit-prompt')
    const text = input(target, '#prompt-text', '不能丢失的修改')
    click(target, 'save-prompt')
    click(target, 'save-prompt')
    click(target, 'cancel-prompt')
    expect(harness.raw.updatePrompt).toHaveBeenCalledTimes(1)
    expect(text.disabled).toBe(true)
    pending.resolve({ ok: false, error: '更新失败' })
    await settle()
    expect(text.value).toBe('不能丢失的修改')
    expect(text.disabled).toBe(false)
    expect(target.querySelector('[role="alert"]')?.textContent).toBe('更新失败')
  })

  it('confirms deletion with a summary and keeps the item on failure', async () => {
    const harness = makeHarness([prompt('one', '审查提示', '谨慎删除正文')])
    const target = await mount(harness.api)
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    click(target, 'delete-prompt')
    expect(harness.raw.deletePrompt).not.toHaveBeenCalled()
    expect(confirm.mock.calls[0][0]).toContain('审查提示')
    expect(confirm.mock.calls[0][0]).toContain('谨慎删除正文')
    confirm.mockReturnValue(true)
    harness.raw.deletePrompt.mockResolvedValueOnce({ ok: false, error: '删除失败' })
    click(target, 'delete-prompt')
    await settle()
    expect(target.querySelector('.prompt-entry')).not.toBeNull()
    expect(target.querySelector('[role="alert"]')?.textContent).toBe('删除失败')
    click(target, 'delete-prompt')
    await settle()
    expect(target.querySelector('.prompt-entry')).toBeNull()
  })

  it('blocks new writes on initial load failure and offers a real retry', async () => {
    const harness = makeHarness()
    harness.raw.listPrompts.mockResolvedValueOnce({ ok: false, error: '文件损坏' })
    const target = await mount(harness.api)
    expect(target.querySelector('[role="alert"]')?.textContent).toBe('文件损坏')
    expect(target.querySelector<HTMLButtonElement>('[data-action="new-prompt"]')?.disabled).toBe(true)
    expect(target.querySelector('.prompts-load-error')).not.toBeNull()
    click(target, 'retry-prompts')
    await settle()
    expect(target.querySelector('[role="alert"]')).toBeNull()
    expect(target.querySelector<HTMLButtonElement>('[data-action="new-prompt"]')?.disabled).toBe(false)
  })

  it('reports copy failure and allows a successful repeat without stale failure feedback', async () => {
    const harness = makeHarness([prompt('one', '标题')])
    harness.raw.copyText.mockResolvedValueOnce({ ok: false, error: '剪贴板不可用' })
    const target = await mount(harness.api)
    click(target, 'copy-prompt')
    await settle()
    expect(target.querySelector('[data-action="copy-prompt"]')?.textContent).toBe('复制')
    expect(target.querySelector('[role="alert"]')?.textContent).toContain('剪贴板不可用')
    click(target, 'copy-prompt')
    await settle()
    expect(target.querySelector('[data-action="copy-prompt"]')?.textContent).toBe('已复制')
    expect(target.querySelector('[role="alert"]')).toBeNull()
  })

  it('settles copying against the current row after local search redraws', async () => {
    const pending = deferred<IpcResult<true>>()
    const harness = makeHarness([prompt('one', '标题')])
    harness.raw.copyText.mockImplementation(() => pending.promise)
    const target = await mount(harness.api)
    click(target, 'copy-prompt')
    input(target, '.prompt-search', '标题')
    pending.resolve({ ok: true, data: true })
    await settle()
    expect(target.querySelector<HTMLButtonElement>('[data-action="copy-prompt"]')?.disabled).toBe(false)
    expect(target.querySelector('[data-action="copy-prompt"]')?.textContent).toBe('已复制')
  })

  it('does not mark a changed body as copied when an older copy reply arrives', async () => {
    const pending = deferred<IpcResult<true>>()
    const harness = makeHarness([prompt('one', '标题', '旧正文')])
    harness.raw.copyText.mockImplementation(() => pending.promise)
    const target = await mount(harness.api)
    click(target, 'copy-prompt')
    harness.replace([prompt('one', '标题', '新正文')])
    await settle()
    pending.resolve({ ok: true, data: true })
    await settle()
    expect(harness.raw.copyText).toHaveBeenCalledWith('旧正文')
    expect(target.querySelector('[data-action="copy-prompt"]')?.textContent).toBe('复制')
    expect(target.querySelector<HTMLButtonElement>('[data-action="copy-prompt"]')?.disabled).toBe(false)
  })

  it('ignores copy replies after leaving and removes change and keyboard listeners', async () => {
    const pending = deferred<IpcResult<true>>()
    const harness = makeHarness([prompt('one', '标题')])
    harness.raw.copyText.mockImplementation(() => pending.promise)
    const target = await mount(harness.api)
    click(target, 'copy-prompt')
    const oldButton = target.querySelector('[data-action="copy-prompt"]')!
    page.deactivatePrompts()
    target.replaceChildren(document.createTextNode('其他页面'))
    pending.resolve({ ok: false, error: '迟到失败' })
    await settle()
    expect(target.textContent).toBe('其他页面')
    expect(oldButton.textContent).toBe('复制中…')
    expect(harness.unsubscribeCount()).toBe(1)
    harness.notify()
    expect(harness.raw.listPrompts).toHaveBeenCalledTimes(1)
    const key = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, cancelable: true })
    window.dispatchEvent(key)
    expect(key.defaultPrevented).toBe(false)
  })

  it('ignores list responses after navigation', async () => {
    const pending = deferred<IpcResult<PromptItem[]>>()
    const harness = makeHarness()
    harness.raw.listPrompts.mockImplementation(() => pending.promise)
    const target = document.createElement('main')
    document.body.append(target)
    window.arckeep = harness.api
    const rendering = page.renderPrompts(target)
    page.deactivatePrompts()
    target.replaceChildren(document.createTextNode('另一页'))
    pending.resolve({ ok: true, data: [prompt('late', '迟到的数据')] })
    await rendering
    expect(target.textContent).toBe('另一页')
    expect(harness.unsubscribeCount()).toBe(1)
  })

  it('restores unfinished drafts after leaving and does not restore a save that already succeeded', async () => {
    const harness = makeHarness()
    let target = await mount(harness.api)
    click(target, 'new-prompt')
    input(target, '#prompt-title', '会话草稿')
    input(target, '#prompt-text', '保留到返回模块')
    page.deactivatePrompts()
    target = await mount(harness.api)
    expect(target.querySelector<HTMLInputElement>('#prompt-title')?.value).toBe('会话草稿')
    expect(target.querySelector<HTMLTextAreaElement>('#prompt-text')?.value).toBe('保留到返回模块')
    const pending = deferred<IpcResult<PromptItem>>()
    harness.raw.createPrompt.mockImplementation(() => pending.promise)
    click(target, 'save-prompt')
    const oldForm = target.querySelector('.prompt-editor')!
    page.deactivatePrompts()
    target.replaceChildren(document.createTextNode('其他页面'))
    pending.resolve({ ok: true, data: prompt('saved', '会话草稿', '保留到返回模块') })
    await settle()
    expect(target.textContent).toBe('其他页面')
    expect(oldForm.querySelector<HTMLButtonElement>('[data-action="save-prompt"]')?.disabled).toBe(true)
    target = await mount(harness.api)
    expect(target.querySelector('.prompt-editor')).toBeNull()
  })
})
