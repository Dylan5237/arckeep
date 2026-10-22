export interface ReadHttpResponseOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  const error = new Error('请求已取消')
  error.name = 'AbortError'
  return error
}

function requestTimeoutError(timeoutMs: number): Error {
  const error = new Error(`HTTP 请求超过 ${timeoutMs}ms 时限`)
  error.name = 'TimeoutError'
  return error
}

function cancelBody(response: Response | undefined): void {
  const body = response?.body
  if (!body || body.locked) return
  void body.cancel().catch(() => {})
}

/** Reads headers and body under one deadline, even when an adapter ignores AbortSignal. */
export async function readHttpResponse(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch = fetch,
  options: ReadHttpResponseOptions = {}
): Promise<{ response: Response, bodyText: string }> {
  const timeoutMs = options.timeoutMs ?? 15_000
  const controller = new AbortController()
  const signals = [...new Set([options.signal, init.signal ?? undefined].filter((item): item is AbortSignal => Boolean(item)))]
  let response: Response | undefined
  let rejectControl: ((reason: Error) => void) | undefined
  let controlSettled = false

  const rejectRequest = (reason: Error) => {
    if (controlSettled) return
    controlSettled = true
    controller.abort(reason)
    cancelBody(response)
    rejectControl?.(reason)
  }
  const onAbort = (signal: AbortSignal) => () => rejectRequest(abortReason(signal))
  const listeners = signals.map(signal => ({ signal, listener: onAbort(signal) }))

  for (const { signal } of listeners) {
    if (signal.aborted) throw abortReason(signal)
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  const controlled = new Promise<never>((_, reject) => { rejectControl = reject })
  const read = (async () => {
    const fetched = await fetchImpl(url, { ...init, signal: controller.signal })
    response = fetched
    if (controller.signal.aborted) {
      cancelBody(fetched)
      throw abortReason(controller.signal)
    }
    const bodyText = await fetched.text()
    return { response: fetched, bodyText }
  })()

  try {
    for (const { signal, listener } of listeners) signal.addEventListener('abort', listener, { once: true })
    for (const { signal } of listeners) {
      if (signal.aborted) {
        rejectRequest(abortReason(signal))
        break
      }
    }
    timer = setTimeout(() => rejectRequest(requestTimeoutError(timeoutMs)), Math.max(0, timeoutMs))
    return await Promise.race([read, controlled])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    for (const { signal, listener } of listeners) signal.removeEventListener('abort', listener)
  }
}
