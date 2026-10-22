import { describe, expect, it } from 'vitest'
import { elapsedTime, relativeLabel } from '../src/shared/time.js'
import { orderList } from '../src/shared/list-order.js'
import { draftFromReasons } from '../src/shared/waiting/classify.js'
import { partitionDismissals } from '../src/shared/waiting/snooze.js'

const now = new Date('2026-10-12T03:00:00Z')
describe('shared list ordering and elapsed time', () => {
  it('sorts by exact event time with deterministic ties, without mutating input', () => {
    const rows = [
      { id: '12', name: 'a', at: '2026-10-12T02:00:00Z' },
      { id: '3', name: 'a', at: '2026-10-12T02:00:00Z' },
      { id: '1', name: 'z', at: '2026-10-12T02:01:00Z' },
      { id: '0', name: '0', at: 'invalid' }
    ]
    const fields = { time: (row: typeof rows[number]) => row.at, name: (row: typeof rows[number]) => row.name, id: (row: typeof rows[number]) => row.id }
    expect(orderList(rows, 'newest', fields).map(row => row.id)).toEqual(['1', '3', '12', '0'])
    expect(orderList(rows, 'oldest', fields).map(row => row.id)).toEqual(['3', '12', '1', '0'])
    expect(orderList(rows, 'name', fields).map(row => row.id)).toEqual(['0', '3', '12', '1'])
    expect(rows.map(row => row.id)).toEqual(['12', '3', '1', '0'])
  })

  it.each([
    [0, { value: 0, unit: '刚刚' }],
    [59_999, { value: 0, unit: '刚刚' }],
    [60_000, { value: 1, unit: '分钟' }],
    [3_599_999, { value: 59, unit: '分钟' }],
    [3_600_000, { value: 1, unit: '小时' }],
    [86_399_999, { value: 23, unit: '小时' }],
    [86_400_000, { value: 1, unit: '天' }]
  ])('uses elapsed floors at %i milliseconds instead of rounding into another unit', (age, result) => {
    expect(elapsedTime(new Date(now.getTime() - age).toISOString(), now)).toEqual(result)
  })

  it('does not invent precision for missing times or show a negative waiting duration', () => {
    expect(elapsedTime(null, now)).toBeNull()
    expect(elapsedTime('invalid', now)).toBeNull()
    expect(elapsedTime('2026-10-13T03:00:00Z', now)).toEqual({ value: 0, unit: '刚刚' })
    expect(relativeLabel('2026-10-12T03:02:00Z', now)).toBe('2 分钟后')
  })

  it('transports the reason timestamp rather than unrelated updatedAt for a zero-day wait', () => {
    const draft = draftFromReasons({ id: 'test', repo: 'ada/demo', number: 7, type: 'issue', title: 'test', url: '',
      updatedAt: '2026-10-12T02:59:00Z', reasons: [{ reason: '指派', at: '2026-10-12T01:30:00Z', estimated: false }] }, now)
    const row = partitionDismissals([draft], {}, now, false).rows[0]
    expect(row?.waitingDays).toBe(0)
    expect(row?.waitingSince).toBe('2026-10-12T01:30:00Z')
    expect(elapsedTime(row?.waitingSince, now)).toEqual({ value: 1, unit: '小时' })
  })
})
