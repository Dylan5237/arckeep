// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderTodos } from '../src/renderer/todos-page.js'
import type { ArckeepApi, TodoItem } from '../src/shared/types.js'

function todo(id: string, text: string): TodoItem {
  return {
    id,
    text,
    repo: 'example/demo',
    waiting: false,
    waitingSince: null,
    createdAt: '2026-09-28T01:00:00.000Z',
    updatedAt: '2026-09-28T01:00:00.000Z',
    completed: false
  }
}

function showing(): string[] {
  return [...document.querySelectorAll<HTMLElement>('.todo-row.show-actions')].map(row => row.dataset.rowId ?? '')
}

describe('todo row actions', () => {
  it('shows actions on only one row when another row is focused and this one is hovered', async () => {
    document.body.replaceChildren()
    const content = document.createElement('main')
    document.body.append(content)
    const items = [todo('row-a', '先聚焦这一行'), todo('row-b', '鼠标停在这一行')]
    window.arckeep = {
      listTodos: async () => items,
      todoRepoOptions: async () => ['example/demo'],
      onTodosChanged: () => () => {}
    } as ArckeepApi

    const release = await renderTodos(content)
    const rows = [...document.querySelectorAll<HTMLElement>('.todo-row')]
    const edit = rows[0]?.querySelector<HTMLButtonElement>('[data-action="edit"]')
    const checkbox = rows[0]?.querySelector<HTMLInputElement>('input.todo-check')
    const remove = rows[1]?.querySelector<HTMLButtonElement>('[data-action="delete"]')
    if (!edit || !checkbox || !remove || !rows[1]) throw new Error('todo rows did not render')

    edit.focus()
    expect(showing()).toEqual(['row-a'])

    rows[1].dispatchEvent(new PointerEvent('pointermove', { bubbles: true }))
    expect(document.activeElement).toBe(edit)
    expect(showing()).toEqual(['row-b'])

    checkbox.focus()
    expect(showing()).toEqual(['row-a'])
    expect(document.querySelectorAll('.todo-row.show-actions')).toHaveLength(1)

    rows[1].dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    expect(showing()).toEqual(['row-b'])
    expect(remove.className).toBe(edit.className)
    expect(remove.classList.contains('danger')).toBe(false)

    const css = readFileSync(path.join(process.cwd(), 'src/renderer/styles.css'), 'utf8')
    expect(css).not.toContain('.todo-actions button.danger')
    expect(css).not.toContain('.todo-row:hover .todo-actions')
    expect(css).not.toContain('.todo-row:focus-within .todo-actions')
    expect(css).toContain('.todo-row.show-actions .todo-actions')
    release()
  })
})