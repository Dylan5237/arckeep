import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import type { ToolRunEvent } from '../src/shared/tools/types.js'
import type { ShellPlan } from '../src/main/tool-launch.js'
import { runPlan, ToolRunner } from '../src/main/tool-runner.js'

const longRunningPlan: ShellPlan = {
  shell: 'git-bash',
  script: '',
  file: process.execPath,
  args: ['-e', 'setInterval(() => {}, 1000)'],
  windowsVerbatimArguments: false
}

function waitForClose(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise(resolve => child.once('close', () => resolve()))
}

describe('tool runner shutdown', () => {
  it('waits for a termination that outlives the run close event', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'arckeep-runner-shutdown-'))
    let releaseTermination: () => void = () => {}
    const terminationGate = new Promise<void>(resolve => { releaseTermination = resolve })
    let emitDone: (() => void) | undefined
    const done = new Promise<void>(resolve => { emitDone = resolve })
    const runner = new ToolRunner(event => {
      if (event.type === 'done') emitDone?.()
    }, async child => {
      child.kill()
      await waitForClose(child)
      await terminationGate
    })

    try {
      const runId = runner.start(longRunningPlan, cwd)
      expect(runner.abort(runId)).toBe(true)
      await done

      let shutdownFinished = false
      const shutdown = runner.abortAll().then(() => { shutdownFinished = true })
      await Promise.resolve()
      expect(shutdownFinished).toBe(false)

      releaseTermination()
      await shutdown
      expect(shutdownFinished).toBe(true)
      expect(runner.abort(runId)).toBe(false)
    } finally {
      releaseTermination()
      await runner.abortAll().catch(() => undefined)
      rmSync(cwd, { recursive: true, force: true })
    }
  }, 10_000)

  it('does not resolve a timed-out run before its process-tree termination settles', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'arckeep-run-plan-shutdown-'))
    let releaseTermination: () => void = () => {}
    const terminationGate = new Promise<void>(resolve => { releaseTermination = resolve })
    let finishTermination: (() => void) | undefined
    const terminationStarted = new Promise<void>(resolve => { finishTermination = resolve })
    let runSettled = false

    try {
      const resultPromise = runPlan(longRunningPlan, cwd, 200, emit => new ToolRunner(emit, async child => {
        child.kill()
        await waitForClose(child)
        finishTermination?.()
        await terminationGate
      })).then(result => {
        runSettled = true
        return result
      })

      await terminationStarted
      await Promise.resolve()
      expect(runSettled).toBe(false)

      releaseTermination()
      const result = await resultPromise
      expect(runSettled).toBe(true)
      expect(result.aborted).toBe(true)
    } finally {
      releaseTermination()
      rmSync(cwd, { recursive: true, force: true })
    }
  }, 10_000)

  it('preserves termination failures for an awaited shutdown drain', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'arckeep-runner-shutdown-failure-'))
    let emitDone: (() => void) | undefined
    const done = new Promise<void>(resolve => { emitDone = resolve })
    const failure = new Error('test termination failure')
    const runner = new ToolRunner((event: ToolRunEvent) => {
      if (event.type === 'done') emitDone?.()
    }, async child => {
      child.kill()
      await waitForClose(child)
      throw failure
    })

    try {
      const runId = runner.start(longRunningPlan, cwd)
      expect(runner.abort(runId)).toBe(true)
      await done
      await expect(runner.abortAll()).rejects.toBe(failure)
    } finally {
      await runner.abortAll().catch(() => undefined)
      rmSync(cwd, { recursive: true, force: true })
    }
  }, 10_000)
})
