import {
  COMPLETED_GROUP_STORAGE_KEY,
  completedGroupTitle,
  partitionTodos,
  readCompletedGroupOpen,
  writeCompletedGroupOpen
} from '../shared/todos/groups'
import { formatRelativeTime } from '../shared/todos/time'
import { beginDeleteUndo, deleteUndoItem, type DeleteUndo } from '../shared/todos/undo'
import type { TodoItem } from '../shared/types'
import { bindExclusiveRowActions } from './exclusive-rows'

type RepoFilter = 'all' | 'none' | string

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: Array<Node | string> = []
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value
    else node.setAttribute(key, value)
  }
  for (const child of children) {
    node.append(child instanceof Node ? child : document.createTextNode(child))
  }
  return node
}

function localStamp(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString()
}

let unsubscribe: (() => void) | null = null
let pendingUndo: DeleteUndo | null = null
let undoTimer: number | null = null

function rememberCompletedOpen(open: boolean): void {
  try {
    localStorage.setItem(COMPLETED_GROUP_STORAGE_KEY, writeCompletedGroupOpen(open))
  } catch {
    // The group still toggles for this render if storage is blocked.
  }
}

function storedCompletedOpen(): boolean {
  try {
    return readCompletedGroupOpen(localStorage.getItem(COMPLETED_GROUP_STORAGE_KEY))
  } catch {
    return false
  }
}

export async function renderTodos(content: HTMLElement): Promise<() => void> {
  unsubscribe?.()
  const page = el('section', { class: 'page', 'data-page': 'todos' }, [
    el('h1', {}, ['待办']),
    el('p', { class: 'lede' }, ['未完成的在前面，按创建时间排列。全局热键可以随时记一条。'])
  ])
  const host = el('div', { class: 'todo-host' })
  const rows = bindExclusiveRowActions(host, '.todo-row')
  page.append(host)
  content.replaceChildren(page)

  let filter: RepoFilter = 'all'
  let editingId: string | null = null

  const draw = async (): Promise<void> => {
    if (!page.isConnected) return
    let items: TodoItem[] = []
    let repos: string[] = []
    try {
      ;[items, repos] = await Promise.all([
        window.arckeep.listTodos(),
        window.arckeep.todoRepoOptions()
      ])
    } catch (error) {
      host.replaceChildren(el('div', { class: 'alert error', role: 'alert' }, [
        error instanceof Error ? error.message : '无法读取待办'
      ]))
      rows.refresh()
      return
    }
    host.replaceChildren(renderBoard(items, repos, filter, deleteUndoItem(pendingUndo, Date.now()), {
      onFilter: value => {
        filter = value
        editingId = null
        void draw()
      },
      editingId,
      onEdit: id => {
        editingId = id
        void draw()
      },
      onCancelEdit: () => {
        editingId = null
        void draw()
      },
      onChanged: () => {
        editingId = null
        void draw()
      },
      onDeleted: item => {
        pendingUndo = beginDeleteUndo(item, Date.now())
        if (undoTimer !== null) window.clearTimeout(undoTimer)
        undoTimer = window.setTimeout(() => {
          pendingUndo = null
          undoTimer = null
          void draw()
        }, pendingUndo.until - Date.now())
        editingId = null
        void draw()
      },
      onUndo: item => {
        void window.arckeep.restoreTodo(item).then(result => {
          if (!result.ok || !page.isConnected) return
          pendingUndo = null
          if (undoTimer !== null) window.clearTimeout(undoTimer)
          undoTimer = null
          editingId = null
          void draw()
        })
      }
    }))
    rows.refresh()
  }

  unsubscribe = window.arckeep.onTodosChanged(() => {
    if (!page.isConnected || editingId) return
    void draw()
  })
  await draw()
  return () => {
    unsubscribe?.()
    unsubscribe = null
    rows.release()
  }
}

function renderBoard(
  items: TodoItem[],
  repos: string[],
  filter: RepoFilter,
  undoItem: TodoItem | null,
  actions: {
    onFilter: (value: RepoFilter) => void
    editingId: string | null
    onEdit: (id: string) => void
    onCancelEdit: () => void
    onChanged: () => void
    onDeleted: (item: TodoItem) => void
    onUndo: (item: TodoItem) => void
  }
): DocumentFragment {
  const fragment = document.createDocumentFragment()
  const openCount = items.filter(item => !item.completed).length
  const visible = items.filter(item => matchesFilter(item, filter))
  const summary = filter === 'all'
    ? `未完成 ${openCount} · 共 ${items.length} 条`
    : `显示 ${visible.length} 条`

  const select = el('select', { 'aria-label': '按仓库筛选', 'data-action': 'repo-filter' })
  for (const option of filterOptions(items, repos)) {
    const node = el('option', { value: option.value }, [option.label])
    if (option.value === filter) node.selected = true
    select.append(node)
  }
  select.addEventListener('change', () => {
    actions.onFilter(select.value)
  })

  fragment.append(el('div', { class: 'todo-toolbar' }, [
    el('p', { class: 'todo-count' }, [summary]),
    select
  ]))

  const appendUndo = (): void => {
    if (undoItem) fragment.append(renderUndoBar(undoItem, actions.onUndo))
  }
  if (items.length === 0) {
    fragment.append(el('p', { class: 'empty-todos' }, ['还没有待办。按全局热键打开快速捕获。']))
    appendUndo()
    return fragment
  }
  if (visible.length === 0) {
    fragment.append(el('p', { class: 'empty-todos' }, ['这个仓库下没有待办。']))
    appendUndo()
    return fragment
  }

  const { open, done } = partitionTodos(visible)
  const list = el('div', { class: 'todo-list' })
  for (const item of open) {
    list.append(renderRow(item, repos, actions.editingId === item.id, actions))
  }
  fragment.append(list)
  if (done.length > 0) fragment.append(renderCompletedGroup(done, repos, actions))
  appendUndo()
  return fragment
}

function renderCompletedGroup(
  done: TodoItem[],
  repos: string[],
  actions: {
    editingId: string | null
    onEdit: (id: string) => void
    onCancelEdit: () => void
    onChanged: () => void
    onDeleted: (item: TodoItem) => void
  }
): HTMLElement {
  const list = el('div', { class: 'todo-list' })
  for (const item of done) {
    list.append(renderRow(item, repos, actions.editingId === item.id, actions))
  }
  const group = el('details', { class: 'todo-done', 'data-action': 'completed-group' }, [
    el('summary', {}, [completedGroupTitle(done.length)]),
    list
  ])
  group.open = storedCompletedOpen()
  group.addEventListener('toggle', () => {
    rememberCompletedOpen(group.open)
  })
  return group
}

function renderUndoBar(item: TodoItem, onUndo: (item: TodoItem) => void): HTMLElement {
  const undo = el('button', { type: 'button', 'data-action': 'undo-delete' }, ['撤销'])
  undo.addEventListener('click', () => onUndo(item))
  return el('div', { class: 'todo-undo', role: 'status' }, [
    el('span', {}, ['已删除 · ']),
    undo
  ])
}

function filterOptions(items: TodoItem[], repos: string[]): Array<{ value: string, label: string }> {
  const values = [...repos]
  for (const item of items) {
    if (item.repo && !values.includes(item.repo)) values.push(item.repo)
  }
  return [
    { value: 'all', label: '全部仓库' },
    { value: 'none', label: '无仓库' },
    ...values.map(repo => ({ value: repo, label: repo }))
  ]
}

function matchesFilter(item: TodoItem, filter: RepoFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'none') return item.repo === null
  return item.repo === filter
}

function renderRow(
  item: TodoItem,
  repos: string[],
  editing: boolean,
  actions: {
    onEdit: (id: string) => void
    onCancelEdit: () => void
    onChanged: () => void
    onDeleted: (item: TodoItem) => void
  }
): HTMLElement {
  const checkbox = el('input', { type: 'checkbox', class: 'todo-check', 'aria-label': item.completed ? '标为未完成' : '标为完成' })
  checkbox.checked = item.completed
  checkbox.addEventListener('change', () => {
    void window.arckeep.setTodoCompleted(item.id, checkbox.checked).then(result => {
      if (!result.ok) {
        checkbox.checked = item.completed
        return
      }
      actions.onChanged()
    })
  })

  const edit = el('button', { type: 'button', 'data-action': 'edit' }, ['编辑'])
  edit.addEventListener('click', () => actions.onEdit(item.id))
  const remove = el('button', { type: 'button', 'data-action': 'delete' }, ['删除'])
  remove.addEventListener('click', () => {
    void window.arckeep.deleteTodo(item.id).then(result => {
      if (!result.ok) return
      actions.onDeleted(item)
    })
  })

  const side = el('div', { class: 'todo-side' }, [
    el('time', { class: 'todo-time', datetime: item.createdAt, title: localStamp(item.createdAt) }, [
      formatRelativeTime(item.createdAt)
    ]),
    el('div', { class: 'todo-actions' }, editing ? [] : [edit, remove])
  ])

  const main = editing ? renderEditor(item, repos, actions) : renderRead(item)
  const row = el('article', {
    class: editing ? 'todo-row is-editing' : item.completed ? 'todo-row is-done' : 'todo-row',
    'data-row-id': item.id
  }, [
    checkbox,
    main,
    side
  ])
  return row
}

function renderRead(item: TodoItem): HTMLElement {
  const meta = el('div', { class: 'todo-meta' })
  if (item.repo) meta.append(el('span', { class: 'todo-repo' }, [item.repo]))
  if (item.waiting) meta.append(el('span', { class: 'chip' }, ['等我']))
  return el('div', { class: 'todo-main' }, [
    el('p', { class: item.completed ? 'todo-text done' : 'todo-text' }, [item.text]),
    meta
  ])
}

function renderEditor(
  item: TodoItem,
  repos: string[],
  actions: { onCancelEdit: () => void, onChanged: () => void }
): HTMLElement {
  const text = el('input', { type: 'text', value: item.text, 'aria-label': '待办内容', maxlength: '500' })
  const repo = el('input', {
    type: 'text',
    value: item.repo ?? '',
    'aria-label': '仓库标签',
    placeholder: 'owner/repo，可选',
    list: `repo-${item.id}`
  })
  const list = el('datalist', { id: `repo-${item.id}` })
  for (const name of repos) list.append(el('option', { value: name }))
  const waiting = el('input', { type: 'checkbox' })
  waiting.checked = item.waiting
  const error = el('p', { class: 'todo-error', role: 'alert' })
  error.hidden = true
  const save = el('button', { type: 'button', class: 'primary' }, ['保存'])
  const cancel = el('button', { type: 'button', class: 'ghost' }, ['取消'])
  cancel.addEventListener('click', () => actions.onCancelEdit())
  save.addEventListener('click', () => {
    void window.arckeep.updateTodo({
      id: item.id,
      text: text.value,
      repo: repo.value,
      waiting: waiting.checked
    }).then(result => {
      if (!result.ok) {
        error.hidden = false
        error.textContent = result.error
        return
      }
      actions.onChanged()
    })
  })
  text.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault()
      save.click()
    }
  })
  return el('div', { class: 'todo-main todo-editor' }, [
    text,
    repo,
    list,
    el('label', { class: 'capture-wait' }, [waiting, '等我']),
    error,
    el('div', { class: 'todo-edit-actions' }, [save, cancel])
  ])
}
