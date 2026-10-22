import { MAX_IDEA_LENGTH, type IdeaInput, type IdeaItem } from '../shared/ideas/types'
import './ideas.css'

type IdeaDraft = { text: string, repo: string }

interface ActiveIdeasPage {
  deactivate: () => void
}

let activePage: ActiveIdeasPage | null = null

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

function newestFirst(items: IdeaItem[]): IdeaItem[] {
  return [...items].sort((left, right) => {
    const leftTime = Date.parse(left.createdAt)
    const rightTime = Date.parse(right.createdAt)
    const safeLeft = Number.isFinite(leftTime) ? leftTime : Number.NEGATIVE_INFINITY
    const safeRight = Number.isFinite(rightTime) ? rightTime : Number.NEGATIVE_INFINITY
    return safeRight - safeLeft
  })
}

function displayTime(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString()
}

export async function renderIdeas(target: HTMLElement): Promise<void> {
  deactivateIdeas()

  let disposed = false
  let requestVersion = 0
  let items: IdeaItem[] = []
  let loaded = false
  let listError: string | null = null
  let editingId: string | null = null
  let editDraft: IdeaDraft | null = null
  let creating = false
  let mutationBusy = false
  const deletingIds = new Set<string>()

  const page = el('section', { class: 'page ideas', 'data-page': 'ideas' }, [
    el('h1', {}, ['灵感']),
    el('p', { class: 'lede' }, ['先记下来，之后再整理。每条灵感最多 10,000 个字符。'])
  ])

  const composer = el('section', { class: 'ideas-composer card', 'aria-labelledby': 'ideas-compose-title' })
  composer.append(el('h2', { id: 'ideas-compose-title' }, ['记录一条灵感']))
  const composeText = el('textarea', {
    'aria-label': '灵感内容',
    maxlength: String(MAX_IDEA_LENGTH),
    placeholder: '写下一个想法，可以分多行记录…',
    rows: '4'
  })
  const composeRepo = el('input', {
    type: 'text',
    'aria-label': '仓库标签（可选）',
    placeholder: 'owner/repo，可选'
  })
  const composeCount = el('span', { class: 'ideas-char-count', 'aria-live': 'polite' }, [
    `0 / ${MAX_IDEA_LENGTH.toLocaleString()}`
  ])
  const createButton = el('button', { type: 'button', class: 'primary', 'data-action': 'create' }, ['记录灵感'])
  const feedback = el('div', { class: 'ideas-feedback', 'aria-live': 'polite' })
  const listHost = el('div', { class: 'ideas-list-host' })
  const repoLine = el('div', { class: 'ideas-repo-line' }, [composeRepo])
  const composeActions = el('div', { class: 'ideas-compose-actions' }, [composeCount, createButton])
  composer.append(composeText, repoLine, composeActions)
  page.append(composer, feedback, listHost)
  target.replaceChildren(page)

  const isCurrent = (): boolean => !disposed && activePage?.deactivate === teardown && page.isConnected

  function clearFeedback(): void {
    feedback.replaceChildren()
    feedback.className = 'ideas-feedback'
    feedback.removeAttribute('role')
  }

  function showFeedback(message: string): void {
    feedback.className = 'ideas-feedback alert error'
    feedback.setAttribute('role', 'alert')
    feedback.textContent = message
  }

  function updateCreateControl(): void {
    const hasText = composeText.value.trim().length > 0
    composeText.disabled = creating
    composeRepo.disabled = creating
    createButton.disabled = mutationBusy || editingId !== null || !hasText || composeText.value.length > MAX_IDEA_LENGTH
    composeCount.textContent = `${composeText.value.length.toLocaleString()} / ${MAX_IDEA_LENGTH.toLocaleString()}`
    createButton.textContent = creating ? '正在保存…' : '记录灵感'
  }

  function updateRowActionControls(): void {
    for (const button of listHost.querySelectorAll<HTMLButtonElement>('[data-action="edit"], [data-action="delete"]')) {
      const id = button.closest<HTMLElement>('[data-idea-id]')?.dataset.ideaId
      button.disabled = mutationBusy || editingId !== null || (button.dataset.action === 'delete' && !!id && deletingIds.has(id))
    }
  }

  function drawList(): void {
    if (!isCurrent()) return
    listHost.replaceChildren()
    if (!loaded) {
      listHost.append(el('p', { class: 'ideas-loading', role: 'status' }, ['正在加载灵感…']))
      return
    }
    if (listError && items.length === 0) {
      const retry = el('button', { type: 'button', class: 'ghost', 'data-action': 'retry' }, ['重试'])
      retry.addEventListener('click', () => { void reload() })
      listHost.append(el('div', { class: 'ideas-load-error' }, [
        el('p', {}, ['灵感列表暂时无法加载。']),
        retry
      ]))
      return
    }
    if (items.length === 0) {
      const firstIdea = el('button', { type: 'button', class: 'ghost', 'data-action': 'first-idea' }, ['写下第一条'])
      firstIdea.addEventListener('click', () => composeText.focus())
      listHost.append(el('div', { class: 'ideas-empty' }, [
        el('p', {}, ['还没有灵感。先把脑中的想法记下来。']),
        firstIdea
      ]))
      return
    }

    const list = el('div', { class: 'idea-list' })
    for (const item of newestFirst(items)) list.append(renderItem(item))
    listHost.append(list)
  }

  function renderItem(item: IdeaItem): HTMLElement {
    const stamp = el('time', { class: 'idea-stamp', datetime: item.createdAt, title: displayTime(item.createdAt) }, [
      displayTime(item.createdAt)
    ])
    const meta = el('div', { class: 'idea-meta' }, [stamp])
    if (item.repo) meta.append(el('span', { class: 'idea-repo chip' }, [item.repo]))

    const actions = el('div', { class: 'idea-actions' })
    if (editingId === item.id) {
      actions.append(...renderEditor(item))
    } else {
      const editButton = el('button', { type: 'button', class: 'ghost', 'data-action': 'edit' }, ['编辑'])
      editButton.disabled = mutationBusy || editingId !== null
      editButton.addEventListener('click', () => {
        if (mutationBusy || editingId !== null) return
        editingId = item.id
        editDraft = { text: item.text, repo: item.repo ?? '' }
        updateCreateControl()
        drawList()
        updateRowActionControls()
        const editor = listHost.querySelector<HTMLTextAreaElement>('.idea-editor textarea')
        editor?.focus()
        if (editor) editor.setSelectionRange(editor.value.length, editor.value.length)
      })

      const deleteButton = el('button', {
        type: 'button',
        class: 'ghost',
        'data-action': 'delete',
        'aria-label': `删除灵感：${item.text.slice(0, 40)}`
      }, [deletingIds.has(item.id) ? '正在删除…' : '删除'])
      deleteButton.disabled = mutationBusy || editingId !== null || deletingIds.has(item.id)
      deleteButton.addEventListener('click', () => { void deleteItem(item, deleteButton) })
      actions.append(editButton, deleteButton)
    }

    return el('article', { class: 'idea-entry', 'data-idea-id': item.id }, [
      el('p', { class: 'idea-entry-text' }, [item.text]),
      meta,
      actions
    ])
  }

  function renderEditor(item: IdeaItem): HTMLElement[] {
    const draft = editDraft ?? { text: item.text, repo: item.repo ?? '' }
    const wrapper = el('div', { class: 'idea-editor' })
    const text = el('textarea', {
      'aria-label': '编辑灵感内容',
      maxlength: String(MAX_IDEA_LENGTH),
      rows: '4'
    })
    text.value = draft.text
    const repo = el('input', {
      type: 'text',
      'aria-label': '编辑仓库标签（可选）',
      placeholder: 'owner/repo，可选'
    })
    repo.value = draft.repo
    const count = el('span', { class: 'ideas-char-count' }, [
      `${text.value.length.toLocaleString()} / ${MAX_IDEA_LENGTH.toLocaleString()}`
    ])
    const save = el('button', { type: 'button', class: 'primary', 'data-action': 'save-edit' }, ['保存'])
    const cancel = el('button', { type: 'button', class: 'ghost', 'data-action': 'cancel-edit' }, ['取消'])

    const rememberDraft = (): void => {
      editDraft = { text: text.value, repo: repo.value }
      count.textContent = `${text.value.length.toLocaleString()} / ${MAX_IDEA_LENGTH.toLocaleString()}`
      save.disabled = mutationBusy || !text.value.trim() || text.value.length > MAX_IDEA_LENGTH
    }
    text.addEventListener('input', rememberDraft)
    repo.addEventListener('input', rememberDraft)
    cancel.addEventListener('click', () => {
      if (mutationBusy) return
      editingId = null
      editDraft = null
      clearFeedback()
      drawList()
      updateCreateControl()
      updateRowActionControls()
    })
    save.disabled = !text.value.trim()
    save.addEventListener('click', () => { void saveEdit(item, text, repo, save, cancel) })

    const fields = el('div', { class: 'idea-editor-fields' }, [text, repo])
    const controls = el('div', { class: 'ideas-compose-actions' }, [count, el('div', { class: 'idea-edit-buttons' }, [save, cancel])])
    wrapper.append(fields, controls)
    return [wrapper]
  }

  async function createItem(): Promise<void> {
    if (mutationBusy || editingId !== null || !isCurrent()) return
    const draft = composeDraft()
    if (!draft.text.trim()) {
      showFeedback('灵感内容不能为空。')
      return
    }
    if (draft.text.length > MAX_IDEA_LENGTH) {
      showFeedback(`灵感不能超过 ${MAX_IDEA_LENGTH.toLocaleString()} 个字符。`)
      return
    }

    creating = true
    mutationBusy = true
    updateCreateControl()
    updateRowActionControls()
    clearFeedback()
    try {
      const result = await window.arckeep.createIdea(draft)
      if (!isCurrent()) return
      if (!result.ok) {
        showFeedback(result.error)
        return
      }
      composeText.value = ''
      composeRepo.value = ''
      updateCreateControl()
      items = newestFirst([result.data, ...items.filter(item => item.id !== result.data.id)])
      loaded = true
      listError = null
      clearFeedback()
      drawList()
      void reload()
    } catch (error) {
      if (isCurrent()) showFeedback(errorMessage(error, '无法记录这条灵感。'))
    } finally {
      if (isCurrent()) {
        creating = false
        mutationBusy = false
        updateCreateControl()
        updateRowActionControls()
      }
    }
  }

  function composeDraft(): IdeaInput {
    return { text: composeText.value, repo: normalizeRepo(composeRepo.value) }
  }

  async function saveEdit(
    item: IdeaItem,
    text: HTMLTextAreaElement,
    repo: HTMLInputElement,
    save: HTMLButtonElement,
    cancel: HTMLButtonElement
  ): Promise<void> {
    if (mutationBusy || save.disabled || !isCurrent()) return
    const draft = { text: text.value, repo: normalizeRepo(repo.value) }
    if (!draft.text.trim()) {
      showFeedback('灵感内容不能为空。')
      return
    }
    if (draft.text.length > MAX_IDEA_LENGTH) {
      showFeedback(`灵感不能超过 ${MAX_IDEA_LENGTH.toLocaleString()} 个字符。`)
      return
    }

    mutationBusy = true
    text.disabled = true
    repo.disabled = true
    save.disabled = true
    cancel.disabled = true
    save.textContent = '正在保存…'
    updateCreateControl()
    updateRowActionControls()
    editDraft = { text: draft.text, repo: repo.value }
    clearFeedback()
    try {
      const result = await window.arckeep.updateIdea({ id: item.id, ...draft })
      if (!isCurrent()) return
      if (!result.ok) {
        showFeedback(result.error)
        return
      }
      items = newestFirst(items.map(candidate => candidate.id === result.data.id ? result.data : candidate))
      listError = null
      editingId = null
      editDraft = null
      clearFeedback()
      drawList()
      void reload()
    } catch (error) {
      if (isCurrent()) showFeedback(errorMessage(error, '无法保存这条灵感。'))
    } finally {
      if (isCurrent()) {
        mutationBusy = false
        if (save.isConnected) {
          text.disabled = false
          repo.disabled = false
          save.disabled = !text.value.trim() || text.value.length > MAX_IDEA_LENGTH
          save.textContent = '保存'
        }
        if (cancel.isConnected) cancel.disabled = false
        updateCreateControl()
        updateRowActionControls()
      }
    }
  }

  async function deleteItem(item: IdeaItem, button: HTMLButtonElement): Promise<void> {
    if (mutationBusy || editingId !== null || deletingIds.has(item.id) || !isCurrent()) return
    const excerpt = item.text.length > 100 ? `${item.text.slice(0, 100)}…` : item.text
    const accepted = window.confirm(`确定删除这条灵感吗？\n\n${excerpt}\n\n删除后无法恢复。`)
    if (!accepted) return

    deletingIds.add(item.id)
    mutationBusy = true
    button.disabled = true
    button.textContent = '正在删除…'
    updateCreateControl()
    updateRowActionControls()
    clearFeedback()
    try {
      const result = await window.arckeep.deleteIdea(item.id)
      if (!isCurrent()) return
      if (!result.ok) {
        showFeedback(result.error)
        return
      }
      items = items.filter(candidate => candidate.id !== result.data.id)
      listError = null
      clearFeedback()
      drawList()
      void reload()
    } catch (error) {
      if (isCurrent()) showFeedback(errorMessage(error, '无法删除这条灵感。'))
    } finally {
      if (isCurrent()) {
        deletingIds.delete(item.id)
        mutationBusy = false
        if (button.isConnected) {
          button.disabled = false
          button.textContent = '删除'
        }
        updateCreateControl()
        updateRowActionControls()
      }
    }
  }

  async function reload(): Promise<void> {
    const version = ++requestVersion
    if (!editingId) {
      if (!loaded) {
        listHost.replaceChildren(el('p', { class: 'ideas-loading', role: 'status' }, ['正在加载灵感…']))
      }
    }
    try {
      const result = await window.arckeep.listIdeas()
      if (!isCurrent() || version !== requestVersion) return
      if (!result.ok) {
        loaded = true
        listError = result.error
        showFeedback(result.error)
        if (!editingId) drawList()
        return
      }
      items = newestFirst(result.data)
      loaded = true
      const previousListError = listError
      listError = null
      if (previousListError && feedback.textContent === previousListError) clearFeedback()
      if (!editingId) drawList()
    } catch (error) {
      if (!isCurrent() || version !== requestVersion) return
      loaded = true
      listError = errorMessage(error, '无法读取灵感。')
      showFeedback(listError)
      if (!editingId) drawList()
    }
  }

  composeText.addEventListener('input', updateCreateControl)
  composeRepo.addEventListener('input', updateCreateControl)
  createButton.addEventListener('click', () => { void createItem() })
  updateCreateControl()

  const thisUnsubscribe = window.arckeep.onIdeasChanged(() => {
    if (isCurrent()) void reload()
  })
  const teardown = (): void => {
    if (disposed) return
    disposed = true
    requestVersion++
    thisUnsubscribe()
    if (activePage?.deactivate === teardown) activePage = null
  }
  activePage = { deactivate: teardown }
  drawList()
  await reload()
}

export function deactivateIdeas(): void {
  activePage?.deactivate()
}

function normalizeRepo(value: string): string | null {
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}
