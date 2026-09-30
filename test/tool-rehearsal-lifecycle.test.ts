import { describe, expect, it } from 'vitest'
import type { ToolRunEvent } from '../src/shared/tools/types.js'
import type { ShellPlan } from '../src/main/tool-launch.js'
import { createToolRehearsals } from '../src/main/tool-rehearse.js'
import type { ActionPreview } from '../src/shared/tools/types.js'

const preview: ActionPreview = {
  actionId: 'rehearse',
  title: '预演',
  type: 'run-command',
  text: 'echo real',
  dryRun: 'echo dry-run',
  shell: 'powershell',
  cwd: 'C:\\work\\demo'
}

function fakeRunner(
  onCreated: (emit: (event: ToolRunEvent) => void) => void,
  onAbort: () => void = () => {}
) {
  return (emit: (event: ToolRunEvent) => void) => {
    onCreated(emit)
    return {
      start: (_plan: ShellPlan, _cwd: string) => 'dry-run-1',
      abortAll: onAbort
    }
  }
}

describe('tool rehearsal lifecycle', () => {
  it('cancels a pending rehearsal and waits for its process completion event', async () => {
    let emit: ((event: ToolRunEvent) => void) | null = null
    let abortCalls = 0
    const rehearsals = createToolRehearsals({
      platform: 'win32',
      cwdExists: () => true,
      createRunner: fakeRunner(handler => { emit = handler }, () => { abortCalls += 1 }),
      timeoutMs: 10_000
    })
    const pending = rehearsals.rehearse('request-cancel', preview)
    const cancellation = rehearsals.cancel('request-cancel')

    expect(abortCalls).toBe(1)
    emit?.({ type: 'done', runId: 'dry-run-1', exitCode: null, durationMs: 2, aborted: true })
    await cancellation
    const result = await pending

    expect(result.canConfirm).toBe(false)
    expect(result.status).toBe('failed')
  })

  it('keeps application shutdown pending until all dry-runs settle', async () => {
    let emit: ((event: ToolRunEvent) => void) | null = null
    let abortCalls = 0
    const rehearsals = createToolRehearsals({
      platform: 'win32',
      cwdExists: () => true,
      createRunner: fakeRunner(handler => { emit = handler }, () => { abortCalls += 1 }),
      timeoutMs: 10_000
    })
    const pending = rehearsals.rehearse('request-exit', preview)
    let shutdownFinished = false
    const shutdown = rehearsals.cancelAll().then(() => { shutdownFinished = true })
    await Promise.resolve()
    expect(abortCalls).toBe(1)
    expect(shutdownFinished).toBe(false)
    emit?.({ type: 'done', runId: 'dry-run-1', exitCode: null, durationMs: 3, aborted: true })
    await Promise.all([shutdown, pending])
    expect(shutdownFinished).toBe(true)
  })
})
