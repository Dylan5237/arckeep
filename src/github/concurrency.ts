// Keep a small upper bound while allowing independent refresh sources to overlap.
export const MAX_GITHUB_REQUESTS = 6
export const GITHUB_REQUEST_TIMEOUT_MS = 15_000

export interface GithubRequestScheduler {
  readonly timeoutMs: number
  readonly signal: AbortSignal | undefined
  readonly stopped: Error | null
  run<T>(request: () => Promise<T>): Promise<T>
  stop(error: Error): void
  dispose(): void
}

interface QueuedRequest {
  request: () => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

export function createGithubRequestScheduler(options: {
  concurrency?: number
  timeoutMs?: number
  signal?: AbortSignal
} = {}): GithubRequestScheduler {
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? MAX_GITHUB_REQUESTS))
  const timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? GITHUB_REQUEST_TIMEOUT_MS))
  let active = 0
  let stopped: Error | null = null
  const queue: QueuedRequest[] = []
  const signal = options.signal

  const cancellationError = (): Error => {
    if (signal?.reason instanceof Error) return signal.reason
    return Object.assign(new Error('应用正在关闭，操作已取消'), { name: 'AbortError' })
  }

  const stop = (error: Error): void => {
    if (stopped) return
    stopped = error
    for (const queued of queue.splice(0)) queued.reject(error)
  }

  const onAbort = (): void => stop(cancellationError())
  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) onAbort()

  const drain = (): void => {
    while (!stopped && active < concurrency && queue.length > 0) {
      const queued = queue.shift()
      if (!queued) return
      active += 1
      void Promise.resolve()
        .then(() => {
          if (stopped) throw stopped
          return queued.request()
        })
        .then(queued.resolve, queued.reject)
        .finally(() => {
          active -= 1
          drain()
        })
    }
  }

  return {
    get timeoutMs() { return timeoutMs },
    get signal() { return signal },
    get stopped() { return stopped },
    run<T>(request: () => Promise<T>): Promise<T> {
      if (stopped) return Promise.reject(stopped)
      return new Promise<T>((resolve, reject) => {
        queue.push({
          request: request as () => Promise<unknown>,
          resolve: resolve as (value: unknown) => void,
          reject
        })
        drain()
      })
    },
    stop(error: Error): void {
      stop(error)
    },
    dispose(): void {
      signal?.removeEventListener('abort', onAbort)
    }
  }
}

/** Runs independent work with stable result ordering and stops assigning new work on a fatal result. */
export async function mapConcurrentOrdered<T, R>(
  items: readonly T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<R>,
  stopWhen?: (result: R) => boolean
): Promise<Array<R | undefined>> {
  const results: Array<R | undefined> = new Array(items.length)
  const workerCount = Math.max(1, Math.min(items.length, Math.floor(concurrency) || 1))
  let nextIndex = 0
  let stopped = false
  let hasError = false
  let firstError: unknown

  const worker = async (): Promise<void> => {
    while (!stopped) {
      const index = nextIndex
      nextIndex += 1
      if (index >= items.length) return
      try {
        const result = await task(items[index] as T, index)
        results[index] = result
        if (stopWhen?.(result)) stopped = true
      } catch (error) {
        if (!hasError) {
          hasError = true
          firstError = error
        }
        stopped = true
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  if (hasError) throw firstError
  return results
}
