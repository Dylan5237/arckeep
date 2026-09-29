/** Whole minutes between an event and now, phrased for the waiting page. */
export function relativeLabel(iso: string, now: Date): string {
  const ms = now.getTime() - Date.parse(iso)
  if (!Number.isFinite(ms)) return iso
  const minutes = Math.round(ms / 60_000)
  if (Math.abs(minutes) < 1) return '刚刚'
  if (Math.abs(minutes) < 60) return minutes > 0 ? `${minutes} 分钟前` : `${-minutes} 分钟后`
  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 24) return hours > 0 ? `${hours} 小时前` : `${-hours} 小时后`
  const days = Math.round(hours / 24)
  return days > 0 ? `${days} 天前` : `${-days} 天后`
}

/** Local wall clock, 24-hour HH:mm. */
export function localClock(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Absolute local date and time for a tooltip. */
export function localAbsolute(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).format(date)
}
