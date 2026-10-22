import type { ToolRunEvent } from './types.js'

interface BufferedRunEvents {
  stdout: string
  stderr: string
  done?: ToolRunEvent
}

/** Holds fast command events until the renderer learns which runId the IPC call returned. */
export function createToolRunEventBuffer(maxRuns = 8): {
  push(event: ToolRunEvent): void
  take(runId: string): ToolRunEvent[]
} {
  const pending = new Map<string, BufferedRunEvents>()
  return {
    push(event) {
      let run = pending.get(event.runId)
      if (!run) {
        while (pending.size >= maxRuns) {
          const oldest = pending.keys().next().value as string | undefined
          if (!oldest) break
          pending.delete(oldest)
        }
        run = { stdout: '', stderr: '' }
        pending.set(event.runId, run)
      }
      if (event.type === 'output' && event.text) {
        if (event.stream === 'stderr') run.stderr += event.text
        else if (event.stream === 'stdout') run.stdout += event.text
      } else if (event.type === 'done') {
        run.done = event
      }
    },
    take(runId) {
      const run = pending.get(runId)
      if (!run) return []
      pending.delete(runId)
      const events: ToolRunEvent[] = []
      if (run.stdout) events.push({ type: 'output', runId, stream: 'stdout', text: run.stdout })
      if (run.stderr) events.push({ type: 'output', runId, stream: 'stderr', text: run.stderr })
      if (run.done) events.push(run.done)
      return events
    }
  }
}
