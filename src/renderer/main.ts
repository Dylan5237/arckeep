import brandMark from '../../docs/brand/logo/Arckeep_Master_Horizontal_Reverse.svg'
import brandSymbol from '../../docs/brand/logo/Arckeep_Symbol_White.svg'
import { pastedTokenAfterAttempt } from '../shared/token-field'
import type { AppState } from '../shared/types'
import { DEFAULT_HOTKEY } from '../shared/types'
import { renderOverview } from './overview-page'
import { renderOverviewSettings } from './overview-settings'
import { renderWaiting } from './waiting-page'
import { renderWaitingSettings } from './waiting-settings'

type ViewId = 'inbox' | 'projects' | 'todos' | 'tools' | 'settings'

const PAGES: Record<Exclude<ViewId, 'settings'>, { title: string, body: string }> = {
  inbox: {
    title: '等我处理',
    body: '需要你拍板或回复的事项会集中在这里。这一页先占位，具体能力在后续 Issue。'
  },
  projects: {
    title: '项目总览',
    body: '关注的仓库会在这里汇总。列表留空时走自动模式。这一页先占位。'
  },
  todos: {
    title: '待办',
    body: '个人待办会放在这里。这一页先占位。'
  },
  tools: {
    title: '工具架',
    body: '常用工具入口会放在这里。这一页先占位。'
  }
}

const brand = document.querySelector<HTMLImageElement>('#brand-mark')
if (brand) brand.src = brandMark
const symbol = document.querySelector<HTMLImageElement>('#brand-symbol')
if (symbol) symbol.src = brandSymbol

const content = document.querySelector<HTMLElement>('#content')
const navButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-view]')]

function setActive(view: ViewId): void {
  for (const button of navButtons) {
    button.classList.toggle('active', button.dataset.view === view)
  }
}

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

function renderPlaceholder(view: Exclude<ViewId, 'settings'>): void {
  if (!content) return
  const page = PAGES[view]
  content.replaceChildren(
    el('section', { class: 'page placeholder' }, [
      el('h1', {}, [page.title]),
      el('p', { class: 'lede' }, [page.body])
    ])
  )
}

function messageBox(parent: HTMLElement, kind: 'info' | 'error', text: string): void {
  parent.querySelector('.alert')?.remove()
  parent.append(el('div', { class: kind === 'error' ? 'alert error' : 'alert', role: 'alert' }, [text]))
}

async function renderSettings(options?: { focusToken?: boolean, focusWatch?: boolean }): Promise<void> {
  if (!content) return
  const page = el('section', { class: 'page' }, [
    el('h1', {}, ['设置']),
    el('p', { class: 'lede' }, ['GitHub 认证、关注仓库和全局热键保存在本机，重启后仍然在。'])
  ])
  content.replaceChildren(page)
  let state: AppState
  try {
    state = await window.arckeep.getState()
  } catch (error) {
    page.append(el('div', { class: 'alert error', role: 'alert' }, [
      error instanceof Error ? error.message : '无法读取设置'
    ]))
    return
  }

  page.append(
    renderGithubCard(state),
    renderReposCard(state),
    renderHotkeyCard(state),
    renderWaitingSettings(state, renderSettings),
    renderOverviewSettings(state, renderSettings)
  )
  if (options?.focusToken) {
    page.querySelector<HTMLInputElement>('#github-pat')?.focus()
  }
  if (options?.focusWatch) {
    const input = page.querySelector<HTMLInputElement>('#watched-repo')
    input?.scrollIntoView({ block: 'center' })
    input?.focus()
  }
}

function renderGithubCard(state: AppState): HTMLElement {
  const card = el('section', { class: 'card' }, [
    el('h2', {}, ['GitHub 认证']),
    el('p', { class: 'source' }, [
      '当前',
      el('strong', {}, [state.github.sourceLabel])
    ])
  ])
  if (state.github.source === 'gh-cli') {
    card.append(el('p', { class: 'hint' }, [
      state.github.patSaved
        ? '已检测到 gh 登录，测试连接会使用 gh CLI。本机另有一份加密 PAT，仅在 gh 不可用时使用。'
        : '已检测到 gh 登录，测试连接会使用 gh auth token。'
    ]))
  } else {
    card.append(el('p', { class: 'hint' }, [
      state.github.patSaved
        ? 'gh CLI 未登录或不可用。已保存加密 PAT，粘贴框不会回显 token。'
        : 'gh CLI 未登录或不可用。粘贴 Personal Access Token 后保存，token 只会加密写在本机。'
    ]))
  }

  const tokenInput = el('input', {
    id: 'github-pat',
    type: 'password',
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder: 'ghp_… 或 github_pat_…',
    'aria-label': 'GitHub PAT'
  })
  const saveButton = el('button', { type: 'button', class: 'primary' }, ['保存 PAT'])
  const clearButton = el('button', { type: 'button', class: 'ghost' }, ['清除 PAT'])
  const testButton = el('button', { type: 'button', class: 'primary' }, ['测试连接'])
  saveButton.addEventListener('click', async () => {
    const pasted = tokenInput.value
    const result = await window.arckeep.setPat(pasted)
    tokenInput.value = pastedTokenAfterAttempt(pasted, result.ok)
    if (!result.ok) {
      messageBox(card, 'error', result.error)
      return
    }
    messageBox(card, 'info', 'PAT 已加密保存')
    await renderSettings()
  })
  clearButton.addEventListener('click', async () => {
    const result = await window.arckeep.clearPat()
    if (!result.ok) {
      messageBox(card, 'error', result.error)
      return
    }
    await renderSettings()
  })
  testButton.addEventListener('click', async () => {
    const pasted = tokenInput.value
    testButton.disabled = true
    try {
      const result = await window.arckeep.testGithub(pasted)
      tokenInput.value = pastedTokenAfterAttempt(pasted, result.ok)
      if (result.ok) messageBox(card, 'info', `已连接：${result.login}`)
      else messageBox(card, 'error', result.error)
    } catch (error) {
      tokenInput.value = pastedTokenAfterAttempt(pasted, false)
      messageBox(card, 'error', error instanceof Error ? error.message : '测试连接失败。请稍后重试。')
    } finally {
      testButton.disabled = false
    }
  })
  card.append(
    el('div', { class: 'row' }, [tokenInput]),
    el('div', { class: 'actions' }, [saveButton, clearButton, testButton])
  )
  return card
}

function renderReposCard(state: AppState): HTMLElement {
  const card = el('section', { class: 'card' }, [
    el('h2', {}, ['关注仓库']),
    el('p', { class: 'hint' }, ['填写 owner/repo。留空表示自动模式，供项目总览使用。'])
  ])
  const list = el('ul', { class: 'repo-list' })
  if (state.watchedRepos.length === 0) {
    list.append(el('li', {}, [el('span', {}, ['（空）自动模式'])]))
  } else {
    for (const repo of state.watchedRepos) {
      const remove = el('button', { type: 'button', class: 'ghost' }, ['删除'])
      remove.addEventListener('click', async () => {
        const next = state.watchedRepos.filter(item => item !== repo)
        const result = await window.arckeep.setRepos(next)
        if (!result.ok) {
          messageBox(card, 'error', result.error)
          return
        }
        await renderSettings()
      })
      list.append(el('li', {}, [el('span', {}, [repo]), remove]))
    }
  }
  const input = el('input', {
    id: 'watched-repo',
    type: 'text',
    placeholder: 'example/demo',
    'aria-label': '关注仓库'
  })
  const add = el('button', { type: 'button', class: 'primary' }, ['添加'])
  add.addEventListener('click', async () => {
    const result = await window.arckeep.setRepos([...state.watchedRepos, input.value])
    if (!result.ok) {
      messageBox(card, 'error', result.error)
      return
    }
    await renderSettings()
  })
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') add.click()
  })
  card.append(list, el('div', { class: 'row' }, [input, add]))
  return card
}

function acceleratorFromEvent(event: KeyboardEvent): string | null {
  const mods: string[] = []
  if (event.ctrlKey || event.metaKey) mods.push('Ctrl')
  if (event.altKey) mods.push('Alt')
  if (event.shiftKey) mods.push('Shift')
  if (mods.length === 0) return null
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return null
  const named: Record<string, string> = {
    ' ': 'Space',
    Escape: 'Esc',
    Enter: 'Enter',
    Tab: 'Tab',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right'
  }
  const key = event.key.length === 1 ? event.key.toUpperCase() : (named[event.key] ?? event.key)
  return [...mods, key].join('+')
}

async function applyHotkeyValue(value: string): Promise<void> {
  await window.arckeep.setHotkey(value)
  await renderSettings()
}

function renderHotkeyCard(state: AppState): HTMLElement {
  const card = el('section', { class: 'card' }, [
    el('h2', {}, ['全局热键']),
    el('p', { class: 'hint' }, [`默认 ${DEFAULT_HOTKEY}。注册失败时会写出被占用的组合，并可在提示旁边直接换一个。`])
  ])
  const input = el('input', { type: 'text', value: state.hotkey, 'aria-label': '全局热键' })
  const save = el('button', { type: 'button', class: 'primary' }, ['保存热键'])
  save.addEventListener('click', () => { void applyHotkeyValue(input.value) })
  card.append(el('div', { class: 'row' }, [input, save]))
  if (state.hotkeyWarning) card.append(hotkeyWarningRow(state.hotkeyWarning))
  return card
}

function hotkeyWarningRow(warning: string): HTMLElement {
  const replacement = el('input', {
    type: 'text',
    'aria-label': '新的热键组合',
    placeholder: 'Ctrl+Alt+K'
  })
  const record = el('button', { type: 'button', class: 'ghost' }, ['录制'])
  let recording = false
  record.addEventListener('click', () => {
    recording = true
    record.textContent = '请按键…'
    replacement.focus()
  })
  replacement.addEventListener('keydown', event => {
    if (!recording) return
    event.preventDefault()
    const combo = acceleratorFromEvent(event)
    if (!combo) return
    recording = false
    record.textContent = '录制'
    replacement.value = combo
    void applyHotkeyValue(combo)
  })
  const apply = el('button', { type: 'button', class: 'primary' }, ['改用这个'])
  apply.addEventListener('click', () => { void applyHotkeyValue(replacement.value) })
  return el('div', { class: 'alert error hotkey-alert', role: 'alert' }, [
    el('span', {}, [warning]),
    replacement,
    record,
    apply
  ])
}

async function show(view: ViewId, options?: { focusToken?: boolean, focusWatch?: boolean }): Promise<void> {
  setActive(view)
  if (!content) return
  if (view === 'settings') await renderSettings(options)
  else if (view === 'inbox') await renderWaiting(content, (next, nextOptions) => { void show(next, nextOptions) })
  else if (view === 'projects') await renderOverview(content, (next, nextOptions) => { void show(next, nextOptions) })
  else renderPlaceholder(view)
}

for (const button of navButtons) {
  button.addEventListener('click', () => {
    const view = button.dataset.view
    if (view === 'inbox' || view === 'projects' || view === 'todos' || view === 'tools' || view === 'settings') {
      void show(view)
    }
  })
}

const initial = new URLSearchParams(location.search).get('page')
const initialView = initial === 'settings' || initial === 'projects' || initial === 'todos' || initial === 'tools' || initial === 'inbox'
  ? initial
  : 'inbox'
void show(initialView)
