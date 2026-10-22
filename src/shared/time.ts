export function elapsedTime(iso: string | null | undefined, now: Date): { value: number, unit: string } | null {
  const event = Date.parse(iso ?? '')
  if (!Number.isFinite(event) || !Number.isFinite(now.getTime())) return null
  const ms = Math.max(0, now.getTime() - event)
  if (ms < 60_000) return { value: 0, unit: '刚刚' }
  if (ms < 3_600_000) return { value: Math.floor(ms / 60_000), unit: '分钟' }
  if (ms < 86_400_000) return { value: Math.floor(ms / 3_600_000), unit: '小时' }
  return { value: Math.floor(ms / 86_400_000), unit: '天' }
}

export function relativeLabel(iso: string, now: Date): string {
  const ms = now.getTime() - Date.parse(iso)
  if (!Number.isFinite(ms)) return iso
  const elapsed = elapsedTime(iso, now)
  if (ms >= 0) return !elapsed || elapsed.unit === '刚刚' ? '刚刚' : `${elapsed.value} ${elapsed.unit}前`
  const future = elapsedTime(now.toISOString(), new Date(iso))
  return !future || future.unit === '刚刚' ? '刚刚' : `${future.value} ${future.unit}后`
}

export function localClock(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function localAbsolute(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).format(date)
}
