import { describe, expect, it } from 'vitest'
import { maybeRelatedLabel, maybeSectionOpen, rememberMaybeSection, rowActionLabel, waitingEmptyCopy } from '../src/renderer/waiting-page.js'
import { readDismissalState, writeDismissalState } from '../src/shared/waiting/snooze.js'

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

  it('opens an empty main list only until that choice is saved', () => {
    const fresh = { whenEmpty: null, whenListed: null }
    expect(maybeSectionOpen(0, fresh)).toBe(true)
    expect(maybeSectionOpen(12, fresh)).toBe(false)
    const collapsed = rememberMaybeSection(0, false, fresh)
    expect(collapsed).toEqual({ whenEmpty: false, whenListed: null })
    expect(maybeSectionOpen(0, collapsed)).toBe(false)
    expect(maybeSectionOpen(12, collapsed)).toBe(false)
    const expanded = rememberMaybeSection(4, true, fresh)
    expect(expanded).toEqual({ whenEmpty: null, whenListed: true })
    expect(maybeSectionOpen(4, expanded)).toBe(true)
    expect(maybeSectionOpen(0, expanded)).toBe(true)
  })

  it('remembers a collapse in the dismissal file', () => {
    const written = writeDismissalState({ items: {}, hiddenRepos: [], maybeWhenEmpty: false })
    expect(written.maybeWhenEmpty).toBe(false)
    expect(readDismissalState(written).maybeWhenEmpty).toBe(false)
    expect(readDismissalState({ version: 2, items: {}, hiddenRepos: [] }).maybeWhenEmpty).toBe(null)
    expect(readDismissalState({ version: 2, items: {}, hiddenRepos: [] }).maybeWhenListed).toBe(null)
  })

  it('labels a mention-only row and leaves strong rows on their action', () => {
    expect(rowActionLabel({ tier: 'weak', action: '要你动手', reasons: ['提及'] })).toBe('只是提及')
    expect(rowActionLabel({ tier: 'weak', action: '要你动手', reasons: ['要人动手'] })).toBeNull()
    expect(rowActionLabel({ tier: 'strong', action: '要你动手', reasons: ['要人动手'] })).toBe('要你动手')
    expect(rowActionLabel({ tier: 'strong', action: '待你审合', reasons: ['请求 review'] })).toBe('待你审合')
  })

  it('uses the all-clear line only when both tiers are empty', () => {
    const text = waitingEmptyCopy(0)
    expect(text).toBe('没有等你处理的事项')
    expect(text.includes('全部处理完了')).toBe(false)
    expect(text.includes('可能相关')).toBe(false)
  })
})
