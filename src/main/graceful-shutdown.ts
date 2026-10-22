import { withDeadline } from '../shared/task-scope.js'

export function createGracefulShutdownHandler({
  quit,
  shutdown,
  onError = console.error,
  timeoutMs = 15_000
}: {
  quit: () => void
  shutdown: () => unknown
  onError?: (error: unknown) => void
  timeoutMs?: number
}): (event?: { preventDefault?: () => void }) => Promise<void> | undefined {
  if (typeof quit !== 'function' || typeof shutdown !== 'function') {
    throw new TypeError('quit and shutdown must be functions')
  }

  let allowQuit = false
  let shutdownPromise: Promise<void> | undefined

  return function handleBeforeQuit(event?: { preventDefault?: () => void }) {
    if (allowQuit) return shutdownPromise
    event?.preventDefault?.()
    if (shutdownPromise) return shutdownPromise

    shutdownPromise = Promise.resolve()
      .then(() => withDeadline(Promise.resolve().then(shutdown), timeoutMs, '应用关闭清理超时'))
      .then(() => undefined)
      .catch(error => {
        try { onError(error) } catch { /* Failure reporting must not block exit. */ }
      })
      .finally(() => {
        allowQuit = true
        quit()
      })
    return shutdownPromise
  }
}
