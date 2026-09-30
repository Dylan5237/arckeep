import { describe, expect, it } from 'vitest'
import { createToolRunEventBuffer } from '../src/shared/tools/run-events.js'

describe('early tool-run events', () => {
  it('keeps output and a fast terminal event until the IPC reply provides runId', () => {
    const events = createToolRunEventBuffer()
    events.push({ type: 'output', runId: 'run-1', stream: 'stdout', text: 'created ' })
    events.push({ type: 'output', runId: 'run-1', stream: 'stdout', text: 'files' })
    events.push({ type: 'output', runId: 'run-1', stream: 'stderr', text: 'warning' })
    events.push({ type: 'done', runId: 'run-1', exitCode: 0, durationMs: 8, aborted: false })

    expect(events.take('run-1')).toEqual([
      { type: 'output', runId: 'run-1', stream: 'stdout', text: 'created files' },
      { type: 'output', runId: 'run-1', stream: 'stderr', text: 'warning' },
      { type: 'done', runId: 'run-1', exitCode: 0, durationMs: 8, aborted: false }
    ])
    expect(events.take('run-1')).toEqual([])

    events.push({ type: 'done', runId: 'run-start-failure', exitCode: null, durationMs: 0, aborted: false, error: 'spawn failed' })
    expect(events.take('run-start-failure')).toEqual([
      { type: 'done', runId: 'run-start-failure', exitCode: null, durationMs: 0, aborted: false, error: 'spawn failed' }
    ])
  })
})
