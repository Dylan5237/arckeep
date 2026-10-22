export const LIST_ORDERS = ['newest', 'oldest', 'name'] as const
export type ListOrder = (typeof LIST_ORDERS)[number]

export function isListOrder(value: unknown): value is ListOrder {
  return LIST_ORDERS.some(order => order === value)
}

/** Missing dates stay last in either direction. Ties have a stable identity order. */
export function orderList<T>(rows: readonly T[], order: ListOrder, fields: {
  time: (row: T) => string | null | undefined
  name: (row: T) => string
  id: (row: T) => string
}): T[] {
  const compareName = (a: T, b: T) => fields.name(a).localeCompare(fields.name(b), 'zh-CN', { numeric: true })
    || fields.id(a).localeCompare(fields.id(b), 'en', { numeric: true })
  const time = (row: T) => Date.parse(fields.time(row) ?? '')
  return [...rows].sort((a, b) => {
    if (order === 'name') return compareName(a, b)
    const left = time(a), right = time(b)
    if (!Number.isFinite(left)) return Number.isFinite(right) ? 1 : compareName(a, b)
    if (!Number.isFinite(right)) return -1
    return (order === 'newest' ? right - left : left - right) || compareName(a, b)
  })
}
