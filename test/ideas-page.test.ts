// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { deactivateIdeas, renderIdeas } from '../src/renderer/ideas-page.js'
import type { ArckeepApi, IdeaInput, IdeaItem, IdeaUpdate } from '../src/shared/types.js'

function idea(id: string, text: string, createdAt = '2026-10-01T09:00:00.000Z', repo: string | null = null): IdeaItem {
  return { id, text, repo, createdAt, updatedAt: createdAt }
}

function makeHarness(initial: IdeaItem[] = []) {
  let items = [...initial]
  let listener: (() => void) | null = null
  let unsubscribeCount = 0
  let nextId = 1
  const api = {
    listIdeas: vi.fn(async () => ({ ok: true as const, data: [...items] })),
    createIdea: vi.fn(async (input: IdeaInput) => {
      const saved = idea(`new-${nextId++}`, input.text, `2026-10-04T0${nextId}:00:00.000Z`, input.repo)
      items = [saved, ...items]
      listener?.()
      return { ok: true as const, data: saved }
    }),
    updateIdea: vi.fn(async (input: IdeaUpdate) => {
      const saved = { ...items.find(item => item.id === input.id)!, ...input, updatedAt: '2026-10-04T10:00:00.000Z' }
      items = items.map(item => item.id === saved.id ? saved : item)
      listener?.()
      return { ok: true as const, data: saved }
    }),
    deleteIdea: vi.fn(async (id: string) => {
      items = items.filter(item => item.id !== id)
      listener?.()
      return { ok: true as const, data: { id } }
    }),
    onIdeasChanged: vi.fn((changed: () => void) => {
      listener = changed
      return () => {
        unsubscribeCount++
        listener = null
      }
    })
  }

  return {
    api: api as unknown as ArckeepApi,
    notify: () => listener?.(),
    unsubscribeCount: () => unsubscribeCount,
    listCallCount: () => api.listIdeas.mock.calls.length
  }
}

async function mount(api: ArckeepApi): Promise<HTMLElement> {
  document.body.replaceChildren()
  const target = document.createElement('main')
  document.body.append(target)
  window.arckeep = api
  await renderIdeas(target)
  return target
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

afterEach(() => {
  deactivateIdeas()
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('ideas page', () => {
  it('records multiline text and an optional repo tag', async () => {
    const harness = makeHarness()
    const target = await mount(harness.api)
    const text = target.querySelector<HTMLTextAreaElement>('[aria-label="灵感内容"]')!
    const repo = target.querySelector<HTMLInputElement>('[aria-label="仓库标签（可选）"]')!
    const draftText = '第一行想法\n补充细节\n最后一个问题'
    text.value = draftText
    repo.value = 'example/ideas'
    text.dispatchEvent(new Event('input', { bubbles: true }))
    repo.dispatchEvent(new Event('input', { bubbles: true }))
    target.querySelector<HTMLButtonElement>('[data-action="create"]')!.click()
    await settle()

    expect(harness.api.createIdea).toHaveBeenCalledWith({ text: draftText, repo: 'example/ideas' })
    expect(target.querySelector('.idea-entry-text')?.textContent).toBe(draftText)
    expect(text.value).toBe('')
    expect(repo.value).toBe('')
  })

  it('keeps the new draft when saving fails', async () => {
    const harness = makeHarness()
    harness.api.createIdea = vi.fn(async () => ({ ok: false as const, error: '本地保存失败' })) as unknown as ArckeepApi['createIdea']
    const target = await mount(harness.api)
    const text = target.querySelector<HTMLTextAreaElement>('[aria-label="灵感内容"]')!
    const repo = target.querySelector<HTMLInputElement>('[aria-label="仓库标签（可选）"]')!
    text.value = '失败后要留下来的想法\n还有第二行'
    repo.value = 'example/draft'
    text.dispatchEvent(new Event('input', { bubbles: true }))
    target.querySelector<HTMLButtonElement>('[data-action="create"]')!.click()
    await settle()

    expect(text.value).toBe('失败后要留下来的想法\n还有第二行')
    expect(repo.value).toBe('example/draft')
    expect(target.querySelector('[role="alert"]')?.textContent).toBe('本地保存失败')
  })

  it('locks the new draft during a delayed save and ignores repeated clicks', async () => {
    const harness = makeHarness()
    let completeCreate: ((result: { ok: true, data: IdeaItem }) => void) | undefined
    harness.api.createIdea = vi.fn(() => new Promise(resolve => {
      completeCreate = result => resolve(result)
    })) as unknown as ArckeepApi['createIdea']
    const target = await mount(harness.api)
    const text = target.querySelector<HTMLTextAreaElement>('[aria-label="灵感内容"]')!
    const repo = target.querySelector<HTMLInputElement>('[aria-label="仓库标签（可选）"]')!
    const draft = '保存时不能被覆盖的内容\n第二行'
    text.value = draft
    repo.value = 'example/locked'
    text.dispatchEvent(new Event('input', { bubbles: true }))
    target.querySelector<HTMLButtonElement>('[data-action="create"]')!.click()
    target.querySelector<HTMLButtonElement>('[data-action="create"]')!.click()

    expect(harness.api.createIdea).toHaveBeenCalledTimes(1)
    expect(text.disabled).toBe(true)
    expect(repo.disabled).toBe(true)
    expect(text.value).toBe(draft)
    completeCreate?.({ ok: true, data: idea('delayed', draft, '2026-10-04T10:00:00.000Z', 'example/locked') })
    await settle()
    expect(text.value).toBe('')
    expect(repo.value).toBe('')
  })

  it('shows a retry state instead of an empty list when loading fails', async () => {
    const harness = makeHarness()
    harness.api.listIdeas = vi.fn(async () => ({ ok: false as const, error: '列表读取失败' })) as unknown as ArckeepApi['listIdeas']
    const target = await mount(harness.api)
    expect(target.querySelector('[role="alert"]')?.textContent).toBe('列表读取失败')
    expect(target.querySelector('.ideas-load-error')).not.toBeNull()
    expect(target.querySelector('.ideas-empty')).toBeNull()

    harness.api.listIdeas = vi.fn(async () => ({ ok: true as const, data: [] })) as unknown as ArckeepApi['listIdeas']
    target.querySelector<HTMLButtonElement>('[data-action="retry"]')!.click()
    await settle()
    expect(target.querySelector('.ideas-load-error')).toBeNull()
    expect(target.querySelector('.ideas-empty')?.textContent).toContain('还没有灵感')
    expect(target.querySelector('[role="alert"]')).toBeNull()
  })

  it('edits and continues displaying the saved multiline text', async () => {
    const original = idea('one', '旧灵感\n原来的补充')
    const harness = makeHarness([original])
    const target = await mount(harness.api)
    target.querySelector<HTMLButtonElement>('[data-action="edit"]')!.click()
    const editor = target.querySelector<HTMLTextAreaElement>('.idea-editor textarea')!
    editor.value = '更新后的灵感\n保留第二行'
    editor.dispatchEvent(new Event('input', { bubbles: true }))
    target.querySelector<HTMLButtonElement>('[data-action="save-edit"]')!.click()
    await settle()

    expect(harness.api.updateIdea).toHaveBeenCalledWith({ id: 'one', text: '更新后的灵感\n保留第二行', repo: null })
    expect(target.querySelector('.idea-entry-text')?.textContent).toBe('更新后的灵感\n保留第二行')
  })

  it('keeps the edit text in place when the asynchronous save fails', async () => {
    const harness = makeHarness([idea('one', '原灵感')])
    let completeUpdate: ((result: { ok: false, error: string }) => void) | undefined
    harness.api.updateIdea = vi.fn(() => new Promise(resolve => {
      completeUpdate = result => resolve(result)
    })) as unknown as ArckeepApi['updateIdea']
    const target = await mount(harness.api)
    target.querySelector<HTMLButtonElement>('[data-action="edit"]')!.click()
    const editor = target.querySelector<HTMLTextAreaElement>('.idea-editor textarea')!
    const repo = target.querySelector<HTMLInputElement>('.idea-editor input')!
    editor.value = '需要保留下来的编辑\n第二行正文'
    repo.value = 'example/edited'
    editor.dispatchEvent(new Event('input', { bubbles: true }))
    const save = target.querySelector<HTMLButtonElement>('[data-action="save-edit"]')!
    const cancel = target.querySelector<HTMLButtonElement>('[data-action="cancel-edit"]')!
    save.click()
    save.click()
    cancel.click()

    expect(harness.api.updateIdea).toHaveBeenCalledTimes(1)
    expect(editor.disabled).toBe(true)
    expect(repo.disabled).toBe(true)
    expect(save.disabled).toBe(true)
    expect(cancel.disabled).toBe(true)
    completeUpdate?.({ ok: false, error: '灵感保存失败' })
    await settle()

    expect(target.querySelector('.idea-editor textarea')).toBe(editor)
    expect(editor.value).toBe('需要保留下来的编辑\n第二行正文')
    expect(repo.value).toBe('example/edited')
    expect(editor.disabled).toBe(false)
    expect(repo.disabled).toBe(false)
    expect(target.querySelector('[role="alert"]')?.textContent).toBe('灵感保存失败')
    expect(save.disabled).toBe(false)
    expect(cancel.disabled).toBe(false)
  })

  it('asks before deleting and honors both cancel and confirm', async () => {
    const harness = makeHarness([idea('one', '谨慎删除')])
    const target = await mount(harness.api)
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    target.querySelector<HTMLButtonElement>('[data-action="delete"]')!.click()
    await settle()

    expect(confirm).toHaveBeenCalledWith('确定删除这条灵感吗？\n\n谨慎删除\n\n删除后无法恢复。')
    expect(harness.api.deleteIdea).not.toHaveBeenCalled()
    expect(target.querySelector('.idea-entry')).not.toBeNull()

    confirm.mockReturnValue(true)
    target.querySelector<HTMLButtonElement>('[data-action="delete"]')!.click()
    await settle()
    expect(harness.api.deleteIdea).toHaveBeenCalledWith('one')
    expect(target.querySelector('.idea-entry')).toBeNull()
    expect(target.textContent).toContain('还没有灵感')
  })

  it('keeps the compose and edit drafts focused through external changes', async () => {
    const harness = makeHarness([idea('one', '待编辑')])
    const target = await mount(harness.api)
    const compose = target.querySelector<HTMLTextAreaElement>('[aria-label="灵感内容"]')!
    compose.value = '新建草稿\n不要清掉'
    compose.dispatchEvent(new Event('input', { bubbles: true }))
    compose.focus()
    harness.notify()
    await settle()
    expect(target.querySelector('[aria-label="灵感内容"]')).toBe(compose)
    expect(document.activeElement).toBe(compose)
    expect(compose.value).toBe('新建草稿\n不要清掉')

    target.querySelector<HTMLButtonElement>('[data-action="edit"]')!.click()
    const editor = target.querySelector<HTMLTextAreaElement>('.idea-editor textarea')!
    editor.value = '正在编辑的草稿\n仍要保留'
    editor.dispatchEvent(new Event('input', { bubbles: true }))
    editor.focus()
    harness.notify()
    await settle()
    expect(target.querySelector('.idea-editor textarea')).toBe(editor)
    expect(document.activeElement).toBe(editor)
    expect(editor.value).toBe('正在编辑的草稿\n仍要保留')
    expect(compose.value).toBe('新建草稿\n不要清掉')
  })

  it('shows idea text as plain text and sorts the newest creation first', async () => {
    const injection = '<img src=x onerror=alert(1)>'
    const harness = makeHarness([
      idea('old', '更早', '2026-10-01T08:00:00.000Z'),
      idea('new', injection, '2026-10-03T08:00:00.000Z')
    ])
    const target = await mount(harness.api)

    expect([...target.querySelectorAll<HTMLElement>('.idea-entry')].map(row => row.dataset.ideaId)).toEqual(['new', 'old'])
    expect(target.querySelector('.idea-entry-text')?.textContent).toBe(injection)
    expect(target.querySelector('.idea-entry-text img')).toBeNull()
  })

  it('ignores a list response that arrives after navigation and unsubscribes', async () => {
    let resolveList: ((value: { ok: true, data: IdeaItem[] }) => void) | undefined
    const harness = makeHarness()
    harness.api.listIdeas = vi.fn(() => new Promise(resolve => { resolveList = resolve })) as unknown as ArckeepApi['listIdeas']
    document.body.replaceChildren()
    const target = document.createElement('main')
    document.body.append(target)
    window.arckeep = harness.api
    const pending = renderIdeas(target)
    const marker = document.createElement('p')
    marker.textContent = '另一页'
    deactivateIdeas()
    target.replaceChildren(marker)
    resolveList?.({ ok: true, data: [idea('late', '迟到的数据')] })
    await pending

    expect(target.firstElementChild).toBe(marker)
    expect(harness.unsubscribeCount()).toBe(1)
    const callsBeforeNotify = harness.listCallCount()
    harness.notify()
    expect(harness.listCallCount()).toBe(callsBeforeNotify)
  })
})
