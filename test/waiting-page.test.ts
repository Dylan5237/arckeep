import { describe, expect, it } from 'vitest'
import { maybeRelatedLabel, waitingEmptyCopy } from '../src/renderer/waiting-page.js'

describe('waiting list empty states', () => {
  it('puts a count on the collapsed section header', () => {
    expect(maybeRelatedLabel(6)).toBe('可能相关 · 6')
    expect(maybeRelatedLabel(1)).toBe('可能相关 · 1')
  })

  it('does not say everything is done when only weak rows remain', () => {
    const text = waitingEmptyCopy(6)
    expect(text).toBe('没有明确等你的事 · 另有 6 条可能相关')
    expect(text.includes('全部处理完了')).toBe(false)
    expect(text.includes('没有等你处理的事项')).toBe(false)
  })

  it('uses the all-clear line only when both tiers are empty', () => {
    const text = waitingEmptyCopy(0)
    expect(text).toBe('没有等你处理的事项')
    expect(text.includes('全部处理完了')).toBe(false)
    expect(text.includes('可能相关')).toBe(false)
  })
})
