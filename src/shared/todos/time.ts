function localDayDiff(then: Date, now: Date): number {
  const startNow = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startThen = new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime()
  return Math.round((startNow - startThen) / 86_400_000)
}

function localDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** Relative local-time label, for example「3 天前」. */
export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const diffMs = now.getTime() - date.getTime()
  if (diffMs < 0) return localDate(date)
  if (diffMs < 60_000) return '刚刚'
  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 60) return `${minutes} 分钟前`
  const days = localDayDiff(date, now)
  if (days <= 0) return `${Math.floor(minutes / 60)} 小时前`
  if (days === 1) return '昨天'
  if (days < 30) return `${days} 天前`
  return localDate(date)
}
