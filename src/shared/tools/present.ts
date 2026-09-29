import { TOOL_TYPE_LABEL, type ToolAction } from './types.js'

export type RunPhase = 'running' | 'done' | 'aborted'
export type RunTone = 'running' | 'ok' | 'failed' | 'aborted'

export function runStatus(phase: RunPhase, exitCode: number | null): {
  tone: RunTone
  label: string
  stderrFirst: boolean
} {
  if (phase === 'running') return { tone: 'running', label: '运行中', stderrFirst: false }
  if (phase === 'aborted') return { tone: 'aborted', label: '已终止', stderrFirst: false }
  if (exitCode === 0) return { tone: 'ok', label: '完成', stderrFirst: false }
  const code = exitCode === null ? '无' : String(exitCode)
  return { tone: 'failed', label: `失败（退出码 ${code}）`, stderrFirst: true }
}

export function copyFeedback(ok: boolean): string {
  return ok ? '已复制' : '复制失败'
}

export function errorLine(message: string): number | null {
  const match = /第\s*(\d+)\s*行/.exec(message)
  if (!match) return null
  const line = Number(match[1])
  return Number.isInteger(line) && line > 0 ? line : null
}

export function filterActions(actions: readonly ToolAction[], query: string): ToolAction[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [...actions]
  return actions.filter(action => {
    const hay = `${action.title}\n${action.description ?? ''}\n${TOOL_TYPE_LABEL[action.type]}`.toLowerCase()
    return hay.includes(needle)
  })
}
