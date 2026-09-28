const DAY_MS = 86_400_000

export interface WaitingClock {
  now(): Date
  advanceDays(days: number): void
}

export function createWaitingClock(base: () => Date = () => new Date()): WaitingClock {
  let offsetMs = 0
  return {
    now() {
      return new Date(base().getTime() + offsetMs)
    },
    advanceDays(days: number) {
      if (!Number.isFinite(days) || days <= 0 || days > 3650) throw new Error('模拟天数无效')
      offsetMs += days * DAY_MS
    }
  }
}
