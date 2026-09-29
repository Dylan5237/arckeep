import { describe, expect, it } from 'vitest'
import { foldTodoLines } from '../src/shared/todos/fold.js'
import { screenshotTodoLog } from '../src/main/screenshot-todos.js'

describe('screenshot todo fixture', () => {
  it('folds forty synthetic todos with a mix of done, undone, and 等我', () => {
    const now = new Date('2026-09-28T07:00:00.000Z')
    const items = foldTodoLines(screenshotTodoLog(now))
    expect(items).toHaveLength(40)
    expect(items.filter(item => !item.completed)).toHaveLength(12)
    expect(items.filter(item => item.completed)).toHaveLength(28)
    expect(items.filter(item => item.waiting && !item.completed).length).toBeGreaterThan(0)
    expect(new Set(items.map(item => item.repo)).size).toBeGreaterThan(3)
    expect(items.some(item => item.text.startsWith('示例仓库待办'))).toBe(true)
    expect(items.some(item => item.repo === null)).toBe(true)
    expect(items.findIndex(item => item.completed)).toBe(12)
  })
})
