// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderTodos } from '../src/renderer/todos-page.js'
import type { ArckeepApi, TodoItem } from '../src/shared/types.js'

function todo(id: string, text: string, patch: Partial<TodoItem> = {}): TodoItem {
  return {
    id,
    text,
    repo: 'example/demo',
    waiting: false,
    waitingSince: null,
    createdAt: '2026-09-28T01:00:00.000Z',
    updatedAt: '2026-09-28T01:00:00.000Z',
    completed: false,
    ...patch
  }
}

function installApi(initial: TodoItem[]): {
  items: TodoItem[]
  content: HTMLElement
  api: ArckeepApi & { restoreTodo: ReturnType<typeof vi.fn>, updateTodo: ReturnType<typeof vi.fn> }
} {
  const items = [...initial]
  const api = {
    listTodos: vi.fn(async () => [...items]),
    todoRepoOptions: vi.fn(async () => ['example/demo']),
    onTodosChanged: vi.fn(() => () => {}),
    deleteTodo: vi.fn(async (id: string) => {
      const index = items.findIndex(item => item.id === id)
      if (index >= 0) items.splice(index, 1)
      return { ok: true }
    }),
    restoreTodo: vi.fn(async (item: TodoItem) => {
      items.push(item)
      return { ok: true }
    }),
    updateTodo: vi.fn(async () => ({ ok: true })),
    setTodoCompleted: vi.fn(async () => ({ ok: true }))
  } as unknown as ArckeepApi & { restoreTodo: ReturnType<typeof vi.fn>, updateTodo: ReturnType<typeof vi.fn> }
  window.arckeep = api
  const content = document.createElement('main')
  document.body.replaceChildren(content)
  return { items, content, api }
}

async function flushPromises(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve()
}

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  document.body.replaceChildren()
})

describe('todo edit and delete lifecycle', () => {
  it('keeps the focused editor node, selection and composition when undo expires', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-30T09:30:00.000Z'))
    const { content, api } = installApi([todo('todo-focus-a', '删除 A'), todo('todo-focus-b', '编辑 B')])
    const dispose = await renderTodos(content)
    content.querySelector<HTMLButtonElement>('[data-row-id="todo-focus-a"] [data-action="delete"]')!.click()
    await flushPromises()
    const staleUndo = content.querySelector<HTMLButtonElement>('[data-action="undo-delete"]')!
    content.querySelector<HTMLButtonElement>('[data-row-id="todo-focus-b"] [data-action="edit"]')!.click()
    await flushPromises()
    const editor = content.querySelector<HTMLInputElement>('[data-row-id="todo-focus-b"] input[type="text"]')!
    editor.value = '中文候选草稿'
    editor.dispatchEvent(new Event('input', { bubbles: true }))
    editor.focus()
    editor.setSelectionRange(2, 4)
    editor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    await vi.advanceTimersByTimeAsync(5_100)
    await flushPromises()
    expect(content.querySelector('[data-action="undo-delete"]')).toBeNull()
    expect(editor.isConnected).toBe(true)
    expect(document.activeElement).toBe(editor)
    expect(editor.selectionStart).toBe(2)
    expect(editor.selectionEnd).toBe(4)
    staleUndo.click()
    await flushPromises()
    expect(api.restoreTodo).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(editor)
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }))
    expect(api.updateTodo).not.toHaveBeenCalled()
    dispose()
  })

  it('keeps the original undo deadline when leaving and returning to the page', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-30T10:00:00.000Z'))
    const { content, api } = installApi([todo('todo-a', '删除 A')])
    const leaveFirstPage = await renderTodos(content)

    content.querySelector<HTMLButtonElement>('[data-row-id="todo-a"] [data-action="delete"]')?.click()
    await flushPromises()
    expect(content.querySelector('[data-action="undo-delete"]')).not.toBeNull()

    leaveFirstPage()
    content.replaceChildren(document.createElement('section'))
    await vi.advanceTimersByTimeAsync(4_000)

    const leaveReturnedPage = await renderTodos(content)
    const undoButton = content.querySelector<HTMLButtonElement>('[data-action="undo-delete"]')
    expect(undoButton).not.toBeNull()

    await vi.advanceTimersByTimeAsync(1_000)
    await flushPromises()
    expect(content.querySelector('[data-action="undo-delete"]')).toBeNull()
    undoButton?.click()
    await flushPromises()
    expect(api.restoreTodo).not.toHaveBeenCalled()
    leaveReturnedPage()
  })

  it('does not restore after returning only after the absolute deadline', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-30T10:30:00.000Z'))
    const { content, api } = installApi([todo('todo-a', '删除 A')])
    const leaveFirstPage = await renderTodos(content)

    content.querySelector<HTMLButtonElement>('[data-row-id="todo-a"] [data-action="delete"]')?.click()
    await flushPromises()
    const staleUndoButton = content.querySelector<HTMLButtonElement>('[data-action="undo-delete"]')
    expect(staleUndoButton).not.toBeNull()

    leaveFirstPage()
    content.replaceChildren(document.createElement('section'))
    await vi.advanceTimersByTimeAsync(6_576)
    const leaveReturnedPage = await renderTodos(content)

    expect(content.querySelector('[data-action="undo-delete"]')).toBeNull()
    staleUndoButton?.click()
    await flushPromises()
    expect(api.restoreTodo).not.toHaveBeenCalled()
    leaveReturnedPage()
  })

  it('preserves all unsaved editor fields when the undo bar expires and redraws', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-30T11:00:00.000Z'))
    const { content, api } = installApi([
      todo('todo-a', '删除 A'),
      todo('todo-b', '原内容', { repo: 'example/original', waiting: false })
    ])
    const leave = await renderTodos(content)

    content.querySelector<HTMLButtonElement>('[data-row-id="todo-a"] [data-action="delete"]')?.click()
    await flushPromises()
    content.querySelector<HTMLButtonElement>('[data-row-id="todo-b"] [data-action="edit"]')?.click()
    await flushPromises()

    const text = content.querySelector<HTMLInputElement>('[data-row-id="todo-b"] input[aria-label="待办内容"]')
    const repo = content.querySelector<HTMLInputElement>('[data-row-id="todo-b"] input[aria-label="仓库标签"]')
    const waiting = content.querySelector<HTMLInputElement>('[data-row-id="todo-b"] .capture-wait input')
    expect(text).not.toBeNull()
    expect(repo).not.toBeNull()
    expect(waiting).not.toBeNull()
    if (!text || !repo || !waiting) throw new Error('todo editor did not render')

    text.value = '未保存的新文字'
    text.dispatchEvent(new Event('input', { bubbles: true }))
    repo.value = 'owner/new-repo'
    repo.dispatchEvent(new Event('input', { bubbles: true }))
    waiting.checked = true
    waiting.dispatchEvent(new Event('change', { bubbles: true }))

    await vi.advanceTimersByTimeAsync(5_000)
    await flushPromises()

    const redrawnText = content.querySelector<HTMLInputElement>('[data-row-id="todo-b"] input[aria-label="待办内容"]')
    const redrawnRepo = content.querySelector<HTMLInputElement>('[data-row-id="todo-b"] input[aria-label="仓库标签"]')
    const redrawnWaiting = content.querySelector<HTMLInputElement>('[data-row-id="todo-b"] .capture-wait input')
    expect(redrawnText?.value).toBe('未保存的新文字')
    expect(redrawnRepo?.value).toBe('owner/new-repo')
    expect(redrawnWaiting?.checked).toBe(true)
    expect(content.querySelector('[data-action="undo-delete"]')).toBeNull()

    content.querySelector<HTMLButtonElement>('[data-row-id="todo-b"] .todo-edit-actions .primary')?.click()
    await flushPromises()
    expect(api.updateTodo).toHaveBeenCalledWith({
      id: 'todo-b',
      text: '未保存的新文字',
      repo: 'owner/new-repo',
      waiting: true
    })
    leave()
  })

  it('restores the most recently deleted item with its original attributes', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-30T12:00:00.000Z'))
    const first = todo('todo-a', '先删除')
    const second = todo('todo-b', '后删除', {
      repo: 'owner/repo',
      waiting: true,
      waitingSince: '2026-09-29T08:00:00.000Z',
      completed: true,
      updatedAt: '2026-09-29T08:00:00.000Z'
    })
    const { content, api } = installApi([first, second])
    const leave = await renderTodos(content)

    content.querySelector<HTMLButtonElement>('[data-row-id="todo-a"] [data-action="delete"]')?.click()
    await flushPromises()
    content.querySelector<HTMLButtonElement>('[data-row-id="todo-b"] [data-action="delete"]')?.click()
    await flushPromises()
    content.querySelector<HTMLButtonElement>('[data-action="undo-delete"]')?.click()
    await flushPromises()

    expect(api.restoreTodo).toHaveBeenCalledTimes(1)
    expect(api.restoreTodo).toHaveBeenCalledWith(second)
    expect(content.querySelector('[data-action="undo-delete"]')).toBeNull()
    leave()
  })

  it('does not submit while Enter is composing, but saves on ordinary Enter', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-30T13:00:00.000Z'))
    const { content, api } = installApi([todo('todo-a', '原内容')])
    const leave = await renderTodos(content)
    content.querySelector<HTMLButtonElement>('[data-row-id="todo-a"] [data-action="edit"]')?.click()
    await flushPromises()

    const text = content.querySelector<HTMLInputElement>('[data-row-id="todo-a"] input[aria-label="待办内容"]')
    if (!text) throw new Error('todo text editor did not render')
    text.value = '输入法选词中'
    text.dispatchEvent(new Event('input', { bubbles: true }))

    const composingEnter = new KeyboardEvent('keydown', {
      key: 'Enter',
      isComposing: true,
      bubbles: true,
      cancelable: true
    })
    text.dispatchEvent(composingEnter)
    await flushPromises()
    expect(api.updateTodo).not.toHaveBeenCalled()
    expect(composingEnter.defaultPrevented).toBe(false)

    const ordinaryEnter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    text.dispatchEvent(ordinaryEnter)
    await flushPromises()
    expect(api.updateTodo).toHaveBeenCalledTimes(1)
    expect(api.updateTodo).toHaveBeenCalledWith({
      id: 'todo-a',
      text: '输入法选词中',
      repo: 'example/demo',
      waiting: false
    })
    expect(ordinaryEnter.defaultPrevented).toBe(true)
    leave()
  })
})
