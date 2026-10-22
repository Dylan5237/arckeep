import { isListOrder, LIST_ORDERS, type ListOrder } from '../shared/list-order'

const LABELS: Record<ListOrder, string> = {
  newest: '最近活动：新 → 旧', oldest: '最近活动：旧 → 新', name: '仓库名称'
}

export function readListOrder(page: 'waiting' | 'overview'): ListOrder {
  try {
    const value = localStorage.getItem(`arckeep.list-order.${page}`)
    return isListOrder(value) ? value : 'newest'
  } catch { return 'newest' }
}

export function listSortControl(page: 'waiting' | 'overview', order: ListOrder, change: (order: ListOrder) => void): HTMLElement {
  const label = document.createElement('label')
  label.className = 'list-sort'
  label.append('排序 ')
  const select = document.createElement('select')
  select.setAttribute('aria-label', `${page === 'waiting' ? '等我处理' : '项目总览'}排序`)
  for (const value of LIST_ORDERS) {
    const option = document.createElement('option')
    option.value = value
    option.textContent = LABELS[value]
    select.append(option)
  }
  select.value = order
  select.addEventListener('change', () => {
    if (!isListOrder(select.value)) return
    try { localStorage.setItem(`arckeep.list-order.${page}`, select.value) } catch { /* Keep the session choice. */ }
    change(select.value)
  })
  label.append(select)
  return label
}
