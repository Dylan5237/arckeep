/**
 * One list shows row actions for a single row.
 * The later of a pointer move and a keyboard focus wins.
 */
export function bindExclusiveRowActions(container: HTMLElement, rowSelector: string): {
  refresh: () => void
  release: () => void
} {
  let hoveredId: string | null = null
  let focusedId: string | null = null
  let latest: 'hover' | 'focus' | null = null

  const rows = (): HTMLElement[] => [...container.querySelectorAll<HTMLElement>(rowSelector)]

  const rowFrom = (target: EventTarget | null): HTMLElement | null => {
    const element = target instanceof Element
      ? target
      : target instanceof Node
        ? target.parentElement
        : null
    if (!element) return null
    const row = element.closest(rowSelector)
    if (!(row instanceof HTMLElement) || !container.contains(row)) return null
    return row
  }

  const rowFor = (id: string | null): HTMLElement | null => {
    if (!id) return null
    return rows().find(row => row.dataset.rowId === id) ?? null
  }

  const paint = (): void => {
    if (hoveredId && !rowFor(hoveredId)) hoveredId = null
    if (focusedId && !rowFor(focusedId)) focusedId = null
    if (latest === 'hover' && !hoveredId) latest = focusedId ? 'focus' : null
    if (latest === 'focus' && !focusedId) latest = hoveredId ? 'hover' : null
    const activeId = latest === 'hover' ? hoveredId : latest === 'focus' ? focusedId : null
    for (const row of rows()) {
      row.classList.toggle('show-actions', activeId !== null && row.dataset.rowId === activeId)
    }
  }

  const onMove = (event: Event): void => {
    const id = rowFrom(event.target)?.dataset.rowId ?? null
    hoveredId = id
    if (id) latest = 'hover'
    else if (latest === 'hover') latest = focusedId ? 'focus' : null
    paint()
  }

  const onLeave = (): void => {
    hoveredId = null
    if (latest === 'hover') latest = focusedId ? 'focus' : null
    paint()
  }

  const onFocusIn = (event: FocusEvent): void => {
    const id = rowFrom(event.target)?.dataset.rowId
    if (!id) return
    focusedId = id
    latest = 'focus'
    paint()
  }

  const onFocusOut = (event: FocusEvent): void => {
    const row = rowFrom(event.target)
    if (!row || row.dataset.rowId !== focusedId) return
    const next = event.relatedTarget
    if (next instanceof Node && row.contains(next)) return
    focusedId = null
    paint()
  }

  const refresh = (): void => {
    if (focusedId) {
      const row = rowFor(focusedId)
      const active = document.activeElement
      if (!row || !(active instanceof Node) || !row.contains(active)) focusedId = null
    }
    paint()
  }

  container.addEventListener('pointermove', onMove)
  container.addEventListener('mousemove', onMove)
  container.addEventListener('pointerleave', onLeave)
  container.addEventListener('mouseleave', onLeave)
  container.addEventListener('focusin', onFocusIn)
  container.addEventListener('focusout', onFocusOut)

  return {
    refresh,
    release: () => {
      container.removeEventListener('pointermove', onMove)
      container.removeEventListener('mousemove', onMove)
      container.removeEventListener('pointerleave', onLeave)
      container.removeEventListener('mouseleave', onLeave)
      container.removeEventListener('focusin', onFocusIn)
      container.removeEventListener('focusout', onFocusOut)
      for (const row of rows()) row.classList.remove('show-actions')
    }
  }
}
