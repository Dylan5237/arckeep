import { describe, expect, it, vi, afterEach } from 'vitest'
import { abortable, TaskScope } from '../src/shared/task-scope.js'

afterEach(() => { vi.useRealTimers() })

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

describe('application task scope', () => {
  it('closes admission synchronously and cancels an in-flight wait without starting queued work', async () => {
    const scope = new TaskScope()
    const started = deferred<void>()
    const waiting = deferred<void>()
    const operation = scope.run(async signal => { started.resolve(); await abortable(waiting.promise, signal) })
    const rejected = expect(operation).rejects.toMatchObject({ name: 'AbortError' })
    await started.promise
    const queued = vi.fn(async () => {})
    const next = scope.run(queued)
    const nextRejected = expect(next).rejects.toMatchObject({ name: 'AbortError' })
    scope.close()
    expect(scope.isClosing).toBe(true)
    expect(scope.signal.aborted).toBe(true)
    expect(() => scope.assertOpen()).toThrow('应用正在关闭')
    await rejected
    await nextRejected
    await scope.drain()
    expect(queued).not.toHaveBeenCalled()
    expect(scope.pendingCount).toBe(0)
    waiting.resolve()
  })

  it('waits for owned resource termination and starts each cleanup once', async () => {
    const scope = new TaskScope()
    const terminated = deferred<void>()
    const cleanup = vi.fn(() => terminated.promise)
    scope.own('辅助进程', cleanup)
    scope.close()
    scope.close()
    let drained = false
    const first = scope.drain()
    expect(scope.drain()).toBe(first)
    void first.then(() => { drained = true })
    await Promise.resolve()
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(drained).toBe(false)
    terminated.resolve()
    await first
    expect(drained).toBe(true)
    expect(scope.pendingCount).toBe(0)
    expect(scope.resourceCount).toBe(0)
  })

  it('does not cancel resources that completed and unregistered normally', async () => {
    const scope = new TaskScope()
    const cleanup = vi.fn(async () => {})
    const release = scope.own('已完成的进程', cleanup)
    release()
    await scope.drain()
    expect(cleanup).not.toHaveBeenCalled()
  })

  it('reports resource cleanup failures separately from a cancelled business request', async () => {
    const scope = new TaskScope()
    scope.own('Git 辅助进程', async () => { throw new Error('termination failure') })
    await expect(scope.drain()).rejects.toMatchObject({ message: '后台资源清理失败', errors: [expect.objectContaining({ message: 'Git 辅助进程清理失败' })] })
  })

  it('returns a deadline failure when a task does not cooperate', async () => {
    vi.useFakeTimers()
    const scope = new TaskScope()
    const waiting = deferred<void>()
    const operation = scope.run(() => waiting.promise)
    await Promise.resolve()
    const drain = scope.drain(25)
    const rejected = expect(drain).rejects.toThrow('后台任务关闭超时')
    await vi.advanceTimersByTimeAsync(25)
    await rejected
    waiting.resolve()
    await operation
  })

  it('handles already cancelled signals and late adapter rejection without unhandled promises', async () => {
    const scope = new TaskScope()
    scope.close()
    const waiting = deferred<void>()
    await expect(abortable(waiting.promise, scope.signal)).rejects.toMatchObject({ name: 'AbortError' })
    waiting.reject(new Error('late adapter failure'))
    await Promise.resolve()
  })
})
