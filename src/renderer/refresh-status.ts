/** A refresh owns its clock and the page it was started for. */
export function createRefreshStatus(host: HTMLElement): {
  ownsPage: () => boolean
  attach: (page: HTMLElement) => void
  start: () => () => void
} {
  let page: HTMLElement | null = null
  let startedAt: number | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let observer: MutationObserver | null = null
  let generation = 0
  let abandoned = false

  const stop = () => {
    if (timer !== null) clearInterval(timer)
    timer = null
    observer?.disconnect()
    observer = null
    startedAt = null
  }
  const ownsPage = () => {
    if (abandoned) return false
    const current = host.isConnected && (page === null || (page.isConnected && page.parentNode === host))
    if (!current) {
      abandoned = true
      stop()
    }
    return current
  }
  const update = () => {
    if (!ownsPage() || startedAt === null) return
    const status = page?.querySelector<HTMLElement>('[data-refresh-elapsed]')
    if (status) status.textContent = `已用 ${Math.max(0, Math.floor((Date.now() - startedAt) / 1000))} 秒`
  }

  return {
    ownsPage,
    attach: next => {
      page = next
      update()
    },
    start: () => {
      if (!ownsPage()) return () => {}
      stop()
      const version = ++generation
      startedAt = Date.now()
      timer = setInterval(update, 1000)
      observer = new MutationObserver(() => { ownsPage() })
      observer.observe(host, { childList: true })
      if (host.parentNode) observer.observe(host.parentNode, { childList: true })
      update()
      // A superseded request must not stop its successor's clock.
      return () => { if (version === generation) stop() }
    }
  }
}
