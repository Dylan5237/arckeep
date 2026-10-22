export class TaskCancelledError extends Error {
  constructor(message = '应用正在关闭，操作已取消') {
    super(message)
    this.name = 'AbortError'
  }
}

export function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new TaskCancelledError()
}

export function isCancellation(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/** Rejects promptly on cancellation even when a test adapter ignores its signal. */
export function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', cancel)
    const cancel = () => {
      cleanup()
      reject(signal.reason instanceof Error ? signal.reason : new TaskCancelledError())
    }
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
    promise.then(value => {
      cleanup()
      if (signal.aborted) cancel()
      else resolve(value)
    }, error => {
      cleanup()
      reject(error)
    })
  })
}

export async function withDeadline<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs) })
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Owns application work and the cleanup of resources created by that work. */
export class TaskScope {
  private readonly controller = new AbortController()
  private readonly pending = new Map<Promise<unknown>, string>()
  private readonly resources = new Map<symbol, { label: string, cleanup: () => Promise<void> }>()
  private readonly cleanupFailures: Error[] = []
  private closing = false
  private drainPromise: Promise<void> | undefined

  get signal(): AbortSignal { return this.controller.signal }
  get isClosing(): boolean { return this.closing }
  get pendingCount(): number { return this.pending.size }
  get resourceCount(): number { return this.resources.size }

  assertOpen(): void { throwIfCancelled(this.signal) }

  run<T>(task: (signal: AbortSignal) => Promise<T>, label = '后台任务'): Promise<T> {
    if (this.closing) return Promise.reject(new TaskCancelledError())
    const promise = Promise.resolve().then(() => {
      this.assertOpen()
      return task(this.signal)
    })
    this.track(promise, label)
    return promise
  }

  own(label: string, cleanup: () => Promise<void>): () => void {
    this.assertOpen()
    const key = Symbol(label)
    this.resources.set(key, { label, cleanup })
    return () => { this.resources.delete(key) }
  }

  close(): void {
    if (this.closing) return
    this.closing = true
    const resources = [...this.resources.entries()]
    this.controller.abort(new TaskCancelledError())
    for (const [key, resource] of resources) {
      const promise = Promise.resolve().then(resource.cleanup).catch(() => {
        this.cleanupFailures.push(new Error(`${resource.label}清理失败`))
      }).finally(() => { this.resources.delete(key) })
      this.track(promise, resource.label)
    }
  }

  drain(timeoutMs = 12_000): Promise<void> {
    if (this.drainPromise) return this.drainPromise
    this.close()
    const settle = async () => {
      while (this.pending.size > 0) await Promise.allSettled([...this.pending.keys()])
      if (this.cleanupFailures.length > 0) throw new AggregateError(this.cleanupFailures, '后台资源清理失败')
    }
    this.drainPromise = withDeadline(settle(), timeoutMs, '后台任务关闭超时')
    return this.drainPromise
  }

  private track(promise: Promise<unknown>, label: string): void {
    this.pending.set(promise, label)
    const remove = () => { this.pending.delete(promise) }
    promise.then(remove, remove)
  }
}
