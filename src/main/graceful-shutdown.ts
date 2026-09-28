export function createGracefulShutdownHandler({
  quit,
  shutdown,
  onError = console.error
}: {
  quit: () => void
  shutdown: () => unknown
  onError?: (error: unknown) => void
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
      .then(() => shutdown())
      .then(() => undefined)
      .catch(error => {
        onError(error)
      })
      .finally(() => {
        allowQuit = true
        quit()
      })
    return shutdownPromise
  }
}
