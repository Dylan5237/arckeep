import {
  MAX_PROMPT_LENGTH, MAX_PROMPT_TAG_LENGTH, MAX_PROMPT_TAGS, MAX_PROMPT_TITLE_LENGTH,
  type PromptInput, type PromptItem
} from '../shared/prompts/types'
import type { IpcResult } from '../shared/types'
import './prompts.css'

type Draft = { id: string | null, title: string, text: string, tags: string, pinned: boolean }
type Notice = { text: string, error: boolean }
interface ActivePage {
  deactivate(): void
  sync(): void
  reload(): Promise<void>
  upsert(item: PromptItem): void
  remove(id: string): void
}

// Keep unfinished input when the user visits another module in this window.
const session = { query: '', tag: '', draft: null as Draft | null, busy: false, notice: null as Notice | null }
let activePage: ActivePage | null = null

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs: Record<string, string> = {}, children: Array<Node | string> = []
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value
    else node.setAttribute(key, value)
  }
  for (const child of children) node.append(child instanceof Node ? child : document.createTextNode(child))
  return node
}

function tagsFrom(text: string): string[] {
  const seen = new Set<string>()
  return text.split(/[,，\n]/u).map(tag => tag.trim()).filter(tag => {
    const key = tag.toLowerCase()
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function draftError(draft: Draft): string | null {
  if (!draft.title.trim()) return '请填写标题。'
  if (draft.title.length > MAX_PROMPT_TITLE_LENGTH) return `标题最多 ${MAX_PROMPT_TITLE_LENGTH} 个字符。`
  if (!draft.text.trim()) return '请填写提示词正文。'
  if (draft.text.length > MAX_PROMPT_LENGTH) return `正文最多 ${MAX_PROMPT_LENGTH.toLocaleString()} 个字符。`
  const tags = tagsFrom(draft.tags)
  if (tags.length > MAX_PROMPT_TAGS) return `最多 ${MAX_PROMPT_TAGS} 个标签。`
  if (tags.some(tag => tag.length > MAX_PROMPT_TAG_LENGTH)) return `每个标签最多 ${MAX_PROMPT_TAG_LENGTH} 个字符。`
  return null
}

function keywords(query: string): string[] {
  return [...query.toLowerCase().matchAll(/"([^"]+)"|([^\s"]+)/gu)].map(match => match[1] ?? match[2])
}

function sorted(items: PromptItem[]): PromptItem[] {
  const timestamp = (value: string): number => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0
  return [...items].sort((left, right) => Number(right.pinned) - Number(left.pinned)
    || timestamp(right.updatedAt) - timestamp(left.updatedAt)
    || left.title.localeCompare(right.title))
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

async function mutate<T>(operation: () => Promise<IpcResult<T>>, saved: (data: T) => void, fallback: string): Promise<void> {
  if (session.busy) return
  session.busy = true
  session.notice = null
  activePage?.sync()
  let success = false
  try {
    const result = await operation()
    if (result.ok) {
      saved(result.data)
      success = true
    } else session.notice = { text: result.error, error: true }
  } catch (error) {
    session.notice = { text: message(error, fallback), error: true }
  } finally {
    session.busy = false
    activePage?.sync()
    if (success) await activePage?.reload()
  }
}

export async function renderPrompts(target: HTMLElement): Promise<void> {
  deactivatePrompts()
  let disposed = false
  let requestVersion = 0
  let items: PromptItem[] = []
  let loaded = false
  let listError: string | null = null
  let expandedId: string | null = null
  let composing = false
  let editorDraft: Draft | null = null
  let previousBusy = session.busy
  const copying = new Map<string, { text: string, busy: boolean, notice: Notice | null }>()
  const copyControls = new Map<string, () => void>()
  const page = el('section', { class: 'page prompts', 'data-page': 'prompts' })
  const search = el('input', {
    type: 'search', class: 'prompt-search', 'aria-label': '搜索提示词',
    placeholder: '搜索标题、正文或标签', autocomplete: 'off'
  })
  search.value = session.query
  const tagFilter = el('select', { 'aria-label': '筛选提示词标签', class: 'prompt-tag-filter' })
  tagFilter.append(el('option', { value: '' }, ['全部标签']))
  const add = el('button', { type: 'button', class: 'primary', 'data-action': 'new-prompt' }, ['新增提示词'])
  const feedback = el('div', { class: 'prompts-feedback', 'aria-live': 'polite' })
  const editor = el('div', { class: 'prompt-editor-host' })
  const summary = el('p', { class: 'prompt-summary', role: 'status' })
  const listHost = el('div', { class: 'prompt-list-host' })
  page.append(
    el('h1', {}, ['提示词库']),
    el('p', { class: 'lede' }, ['收藏常用提示词，搜索后直接复制。正文按原文保存。']),
    el('div', { class: 'prompt-toolbar' }, [search, tagFilter, add]), feedback, editor, summary, listHost
  )
  target.replaceChildren(page)

  const current = (): boolean => !disposed && activePage?.deactivate === teardown && page.isConnected
  const ready = (): boolean => loaded && listError === null

  function drawFeedback(): void {
    const notice = session.notice ?? (listError ? { text: listError, error: true } : null)
    feedback.className = notice ? `prompts-feedback alert${notice.error ? ' error' : ''}` : 'prompts-feedback'
    feedback.textContent = notice?.text ?? ''
    if (notice) feedback.setAttribute('role', notice.error ? 'alert' : 'status')
    else feedback.removeAttribute('role')
  }

  function updateControls(): void {
    add.disabled = !ready() || session.busy || session.draft !== null
    for (const control of editor.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement>('input, textarea, button')) {
      control.disabled = session.busy
    }
    const save = editor.querySelector<HTMLButtonElement>('[data-action="save-prompt"]')
    if (save) {
      save.disabled = session.busy || !ready() || session.draft === null || draftError(session.draft) !== null
      save.textContent = session.busy ? '正在保存…' : '保存'
    }
    const count = editor.querySelector('.prompt-char-count')
    if (count && session.draft) count.textContent = `${session.draft.text.length.toLocaleString()} / ${MAX_PROMPT_LENGTH.toLocaleString()}`
    const validation = editor.querySelector<HTMLElement>('.prompt-validation')
    if (validation && session.draft) {
      const tags = tagsFrom(session.draft.tags)
      validation.textContent = tags.length > MAX_PROMPT_TAGS ? `最多 ${MAX_PROMPT_TAGS} 个标签。`
        : tags.some(tag => tag.length > MAX_PROMPT_TAG_LENGTH) ? `每个标签最多 ${MAX_PROMPT_TAG_LENGTH} 个字符。` : ''
      validation.hidden = validation.textContent === ''
    }
    for (const button of listHost.querySelectorAll<HTMLButtonElement>('[data-action="edit-prompt"], [data-action="delete-prompt"], [data-action="pin-prompt"]')) {
      button.disabled = !ready() || session.busy || session.draft !== null
    }
  }

  function drawEditor(): void {
    if (editorDraft === session.draft) return
    editorDraft = session.draft
    editor.replaceChildren()
    const draft = session.draft
    if (!draft) return
    const form = el('form', { class: 'prompt-editor card', 'aria-labelledby': 'prompt-editor-title' })
    const title = el('input', { id: 'prompt-title', type: 'text', maxlength: String(MAX_PROMPT_TITLE_LENGTH), required: '' })
    title.value = draft.title
    const text = el('textarea', { id: 'prompt-text', maxlength: String(MAX_PROMPT_LENGTH), rows: '8', required: '', spellcheck: 'false' })
    text.value = draft.text
    const tags = el('input', { id: 'prompt-tags', type: 'text', placeholder: '用逗号分隔，例如：审查, 文档', 'aria-describedby': 'prompt-tags-hint' })
    tags.value = draft.tags
    const pinned = el('input', { id: 'prompt-pinned', type: 'checkbox' })
    pinned.checked = draft.pinned
    const save = el('button', { type: 'submit', class: 'primary', 'data-action': 'save-prompt' }, ['保存'])
    const cancel = el('button', { type: 'button', class: 'ghost', 'data-action': 'cancel-prompt' }, ['取消'])
    form.append(
      el('h2', { id: 'prompt-editor-title' }, [draft.id ? '编辑提示词' : '新增提示词']),
      el('label', { for: 'prompt-title' }, ['标题']), title,
      el('label', { for: 'prompt-text' }, ['正文']), text,
      el('div', { class: 'prompt-editor-meta' }, [el('span', { class: 'prompt-char-count' })]),
      el('label', { for: 'prompt-tags' }, ['标签（可选）']), tags,
      el('p', { id: 'prompt-tags-hint', class: 'hint' }, [`最多 ${MAX_PROMPT_TAGS} 个，每个最多 ${MAX_PROMPT_TAG_LENGTH} 个字符。`]),
      el('p', { class: 'prompt-validation', role: 'alert' }),
      el('label', { class: 'prompt-pin-label', for: 'prompt-pinned' }, [pinned, '置顶']),
      el('div', { class: 'actions' }, [save, cancel]),
      el('p', { class: 'hint prompt-draft-hint' }, ['切换模块会保留未保存草稿；取消会丢弃当前草稿。'])
    )
    title.addEventListener('input', () => { draft.title = title.value; updateControls() })
    text.addEventListener('input', () => { draft.text = text.value; updateControls() })
    tags.addEventListener('input', () => { draft.tags = tags.value; updateControls() })
    pinned.addEventListener('change', () => { draft.pinned = pinned.checked })
    form.addEventListener('submit', event => {
      event.preventDefault()
      if (!current() || !ready() || session.busy) return
      const problem = draftError(draft)
      if (problem) { session.notice = { text: problem, error: true }; drawFeedback(); return }
      const input: PromptInput = { title: draft.title, text: draft.text, tags: tagsFrom(draft.tags), pinned: draft.pinned }
      void mutate(
        () => draft.id ? window.arckeep.updatePrompt({ id: draft.id, ...input }) : window.arckeep.createPrompt(input),
        item => {
          if (session.draft === draft) session.draft = null
          activePage?.upsert(item)
          session.notice = { text: '已保存', error: false }
        }, '无法保存这条提示词。'
      )
    })
    cancel.addEventListener('click', () => {
      if (!current() || session.busy) return
      session.draft = null
      session.notice = null
      sync()
      search.focus()
    })
    editor.append(form)
  }

  function sync(): void {
    if (!current()) return
    if (session.busy && !previousBusy) requestVersion++
    previousBusy = session.busy
    drawEditor()
    drawFeedback()
    updateControls()
  }

  function openDraft(draft: Draft): void {
    if (!current() || !ready() || session.busy || session.draft) return
    session.draft = draft
    session.notice = null
    sync()
    editor.querySelector<HTMLInputElement>('#prompt-title')?.focus()
  }

  function drawTags(): void {
    const tags = [...new Set(items.flatMap(item => item.tags))].sort((a, b) => a.localeCompare(b))
    if (session.tag && !tags.includes(session.tag)) tags.unshift(session.tag)
    tagFilter.replaceChildren(el('option', { value: '' }, ['全部标签']), ...tags.map(tag => el('option', { value: tag }, [tag])))
    tagFilter.value = session.tag
  }

  function upsert(item: PromptItem): void {
    if (!current()) return
    requestVersion++
    items = [...items.filter(previous => previous.id !== item.id), item]
    drawList()
  }

  function remove(id: string): void {
    if (!current()) return
    requestVersion++
    items = items.filter(item => item.id !== id)
    if (expandedId === id) expandedId = null
    drawList()
  }

  function drawList(): void {
    if (!current()) return
    listHost.replaceChildren()
    copyControls.clear()
    if (!loaded) {
      summary.textContent = ''
      if (listError) {
        const retry = el('button', { type: 'button', class: 'ghost', 'data-action': 'retry-prompts' }, ['重试'])
        retry.addEventListener('click', () => { if (current()) void reload() })
        listHost.append(el('div', { class: 'prompts-empty prompts-load-error' }, [el('p', {}, ['提示词库暂时无法加载。']), retry]))
      } else listHost.append(el('p', { class: 'prompts-empty', role: 'status' }, ['正在加载提示词…']))
      return
    }
    drawTags()
    const terms = keywords(session.query)
    const visible = sorted(items).filter(item => (!session.tag || item.tags.includes(session.tag))
      && terms.every(term => `${item.title}\n${item.text}\n${item.tags.join('\n')}`.toLowerCase().includes(term)))
    summary.textContent = session.query || session.tag ? `找到 ${visible.length} / ${items.length} 条` : `${items.length} 条提示词 · 置顶优先`
    if (listError) {
      const retry = el('button', { type: 'button', class: 'ghost', 'data-action': 'retry-prompts' }, ['重试加载'])
      retry.addEventListener('click', () => { if (current()) void reload() })
      listHost.append(el('div', { class: 'prompts-empty' }, ['暂时显示上次读取的内容。', retry]))
    }
    if (visible.length === 0) {
      listHost.append(el('p', { class: 'prompts-empty' }, [items.length === 0 ? '还没有提示词。点击“新增提示词”收藏第一条。' : '没有匹配的提示词，试试其他关键词或标签。']))
      return
    }
    for (const item of visible) listHost.append(renderItem(item))
    updateControls()
  }

  function renderItem(item: PromptItem): HTMLElement {
    const open = expandedId === item.id
    const title = el('button', { type: 'button', class: 'prompt-title', 'aria-expanded': String(open), 'data-action': 'view-prompt' }, [item.title])
    const text = el(open ? 'pre' : 'p', { class: open ? 'prompt-full-text' : 'prompt-preview' }, [open ? item.text : item.text.slice(0, 240)])
    title.addEventListener('click', () => {
      if (!current()) return
      expandedId = open ? null : item.id
      drawList()
      const nextTitle = [...listHost.querySelectorAll<HTMLElement>('[data-prompt-id]')]
        .find(row => row.dataset.promptId === item.id)?.querySelector<HTMLButtonElement>('.prompt-title')
      nextTitle?.focus()
    })
    const copy = el('button', { type: 'button', class: 'primary', 'data-action': 'copy-prompt', 'aria-label': `复制提示词：${item.title}` }, ['复制'])
    const copyNotice = el('span', { class: 'prompt-copy-notice', 'aria-live': 'polite' })
    const existingCopy = copying.get(item.id)
    const copyState = existingCopy?.text === item.text ? existingCopy : { text: item.text, busy: false, notice: null }
    const updateCopy = (): void => {
      copy.disabled = copyState.busy
      copy.textContent = copyState.busy ? '复制中…' : copyState.notice && !copyState.notice.error ? '已复制' : '复制'
      copy.setAttribute('aria-label', `${copyState.notice && !copyState.notice.error ? '已复制，再次复制' : '复制'}提示词：${item.title}`)
      copyNotice.textContent = copyState.notice?.text ?? ''
      copyNotice.className = `prompt-copy-notice${copyState.notice?.error ? ' is-error' : copyState.notice ? ' is-success' : ''}`
      if (copyState.notice?.error) copyNotice.setAttribute('role', 'alert')
      else copyNotice.removeAttribute('role')
    }
    copying.set(item.id, copyState)
    copyControls.set(item.id, updateCopy)
    updateCopy()
    copy.addEventListener('click', () => {
      if (!current() || copyState.busy) return
      if (session.notice === copyState.notice) { session.notice = null; drawFeedback() }
      copyState.busy = true
      copyState.notice = null
      updateCopy()
      void (async () => {
        try {
          const result = await window.arckeep.copyText(item.text)
          if (!current() || copying.get(item.id) !== copyState) return
          copyState.notice = result.ok ? { text: '已复制', error: false } : { text: `复制失败：${result.error}`, error: true }
        } catch (error) {
          if (!current() || copying.get(item.id) !== copyState) return
          copyState.notice = { text: message(error, '复制失败，请重试。'), error: true }
        } finally {
          if (current() && copying.get(item.id) === copyState) {
            copyState.busy = false
            copyControls.get(item.id)?.()
            if (copyState.notice?.error) { session.notice = copyState.notice; drawFeedback() }
          }
        }
      })()
    })
    const pin = el('button', { type: 'button', class: 'ghost', 'data-action': 'pin-prompt', 'aria-pressed': String(item.pinned), 'aria-label': `${item.pinned ? '取消置顶' : '置顶'}：${item.title}` }, [item.pinned ? '取消置顶' : '置顶'])
    pin.addEventListener('click', () => {
      if (!current() || !ready() || session.busy || session.draft) return
      void mutate(() => window.arckeep.setPromptPinned(item.id, !item.pinned), saved => activePage?.upsert(saved), '无法更新置顶状态。')
    })
    const edit = el('button', { type: 'button', class: 'ghost', 'data-action': 'edit-prompt' }, ['编辑'])
    edit.addEventListener('click', () => openDraft({ id: item.id, title: item.title, text: item.text, tags: item.tags.join(', '), pinned: item.pinned }))
    const remove = el('button', { type: 'button', class: 'ghost', 'data-action': 'delete-prompt', 'aria-label': `删除提示词：${item.title}` }, ['删除'])
    remove.addEventListener('click', () => {
      if (!current() || !ready() || session.busy || session.draft) return
      const excerpt = item.text.length > 100 ? `${item.text.slice(0, 100)}…` : item.text
      if (!window.confirm(`确定删除提示词“${item.title}”吗？\n\n${excerpt}\n\n删除后无法恢复。`)) return
      void mutate(() => window.arckeep.deletePrompt(item.id), deleted => activePage?.remove(deleted.id), '无法删除这条提示词。')
    })
    const meta = el('div', { class: 'prompt-meta' })
    if (item.pinned) meta.append(el('span', { class: 'prompt-pinned chip' }, ['置顶']))
    for (const tag of item.tags) meta.append(el('span', { class: 'prompt-tag chip' }, [tag]))
    return el('article', { class: 'prompt-entry', 'data-prompt-id': item.id }, [
      el('div', { class: 'prompt-entry-heading' }, [title, copy]), meta, text,
      el('div', { class: 'prompt-entry-actions' }, [pin, edit, remove, copyNotice])
    ])
  }

  async function reload(): Promise<void> {
    if (!current()) return
    const version = ++requestVersion
    try {
      const result = await window.arckeep.listPrompts()
      if (!current() || version !== requestVersion || session.busy) return
      if (!result.ok) listError = result.error
      else {
        items = result.data
        loaded = true
        listError = null
      }
    } catch (error) {
      if (!current() || version !== requestVersion || session.busy) return
      listError = message(error, '无法读取提示词库。')
    }
    drawFeedback()
    drawList()
    updateControls()
  }

  add.addEventListener('click', () => openDraft({ id: null, title: '', text: '', tags: '', pinned: false }))
  search.addEventListener('compositionstart', () => { composing = true })
  const applySearch = (): void => { session.query = search.value; drawList() }
  search.addEventListener('compositionend', () => { composing = false; applySearch() })
  search.addEventListener('input', event => { if (!composing && !(event as InputEvent).isComposing) applySearch() })
  tagFilter.addEventListener('change', () => { session.tag = tagFilter.value; drawList() })
  const onSearchKey = (event: KeyboardEvent): void => {
    if (!current() || event.isComposing || composing || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'f') return
    event.preventDefault()
    search.focus()
    search.select()
  }
  window.addEventListener('keydown', onSearchKey)
  const unsubscribe = window.arckeep.onPromptsChanged(() => { if (current()) void reload() })
  function teardown(): void {
    if (disposed) return
    disposed = true
    requestVersion++
    unsubscribe()
    window.removeEventListener('keydown', onSearchKey)
    if (activePage?.deactivate === teardown) activePage = null
  }
  activePage = { deactivate: teardown, sync, reload, upsert, remove }
  sync()
  drawList()
  if (session.draft) editor.querySelector<HTMLInputElement>('#prompt-title')?.focus()
  else search.focus()
  await reload()
}

export function deactivatePrompts(): void {
  activePage?.deactivate()
}
