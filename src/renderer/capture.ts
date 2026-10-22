import { captureDraftOnEscape } from '../shared/todos/capture-draft'
import { parseCaptureShorthand } from '../shared/todos/parse-capture'
import { MAX_IDEA_LENGTH } from '../shared/ideas/types'
import type { CaptureDraft } from '../shared/todos/types'

const textInput = document.querySelector<HTMLInputElement>('#text')
const repoInput = document.querySelector<HTMLInputElement>('#repo')
const waitingInput = document.querySelector<HTMLInputElement>('#waiting')
const errorBox = document.querySelector<HTMLElement>('#error')
const form = document.querySelector<HTMLFormElement>('#capture-form')
const repoList = document.querySelector<HTMLDataListElement>('#capture-repos')
const caretMark = document.querySelector<HTMLElement>('#caret')
const caretProbe = document.querySelector<HTMLElement>('#caret-probe')
const kindInput = document.querySelector<HTMLSelectElement>('#capture-kind')
const ideaInput = document.querySelector<HTMLTextAreaElement>('#idea-text')

if (!textInput || !repoInput || !waitingInput || !errorBox || !form || !repoList || !caretMark || !caretProbe) {
  throw new Error('快速捕获页面不完整')
}

const text: HTMLInputElement = textInput
const repo: HTMLInputElement = repoInput
const waiting: HTMLInputElement = waitingInput
const error: HTMLElement = errorBox
const caret: HTMLElement = caretMark
const probe: HTMLElement = caretProbe

const params = new URLSearchParams(location.search)
const stayOpen = params.get('stay') === '1'
let knownRepos: string[] = []
let saving = false
let draftEdited = false
let recordSaved = false
let reposReady = Promise.resolve()
let persistChain: Promise<void> = Promise.resolve()

function placeCaret(): void {
  const active = document.activeElement === text
  caret.hidden = !active
  if (!active) return
  const end = text.selectionStart ?? text.value.length
  probe.textContent = text.value.slice(0, end).replace(/ /g, '\u00a0')
  const inputRect = text.getBoundingClientRect()
  const wrapRect = text.parentElement?.getBoundingClientRect() ?? inputRect
  const style = getComputedStyle(text)
  caret.style.left = `${inputRect.left - wrapRect.left + Number.parseFloat(style.paddingLeft) + probe.getBoundingClientRect().width}px`
  caret.style.top = `${inputRect.top - wrapRect.top + Number.parseFloat(style.paddingTop)}px`
}

function focusInput(): void {
  const field = currentInput()
  field.focus()
  const end = field.value.length
  field.setSelectionRange(end, end)
  placeCaret()
}

function isIdea(): boolean {
  return kindInput?.value === 'idea' && ideaInput !== null
}

function currentInput(): HTMLInputElement | HTMLTextAreaElement {
  return isIdea() && ideaInput ? ideaInput : text
}

function paintKind(): void {
  const idea = isIdea()
  text.hidden = idea
  const textWrap = text.closest<HTMLElement>('.text-wrap')
  if (textWrap) textWrap.hidden = idea
  if (ideaInput) ideaInput.hidden = !idea
  const waitingLabel = document.querySelector<HTMLElement>('#capture-wait')
  if (waitingLabel) waitingLabel.hidden = idea
  const saveButton = document.querySelector<HTMLButtonElement>('#capture-save')
  if (saveButton) saveButton.textContent = idea ? '记下灵感' : '记下待办'
  const keyHint = document.querySelector<HTMLElement>('#capture-key-hint')
  if (keyHint) keyHint.textContent = idea
    ? 'Enter 记下并关闭，Shift+Enter 换行。Esc 或点到窗口外会留下草稿。'
    : 'Enter 记下并关闭。Esc 或点到窗口外会留下草稿，下次热键还会在。'
  const typeHint = document.querySelector<HTMLElement>('#capture-type-hint')
  if (typeHint) typeHint.textContent = idea
    ? '灵感独立保存在本机，可选填仓库；正文最多 10000 字符，不解析 # 或 !等我。'
    : '正文里可以写 #owner/repo、#仓库名 和 !等我。'
  placeCaret()
}

function currentDraft(): CaptureDraft {
  return {
    ...(isIdea() ? { kind: 'idea' as const } : {}),
    text: currentInput().value,
    repo: repo.value,
    waiting: !isIdea() && waiting.checked
  }
}

function persistDraft(): Promise<void> {
  const draft = currentDraft()
  const job = persistChain.then(async () => {
    await window.arckeep.setCaptureDraft(draft)
  })
  persistChain = job.then(() => undefined, () => undefined)
  return job.catch(caught => {
    if (saving) return
    error.hidden = false
    error.textContent = caught instanceof Error ? caught.message : '草稿未能保存，请先记下正文。'
  })
}

function lockFields(locked: boolean): void {
  text.disabled = locked
  repo.disabled = locked
  waiting.disabled = locked
  if (kindInput) kindInput.disabled = locked
  if (ideaInput) ideaInput.disabled = locked
  const button = document.querySelector<HTMLButtonElement>('#capture-save')
  if (button) button.disabled = locked
}

async function dismiss(onEscape = false): Promise<void> {
  if (saving) return
  saving = true
  lockFields(true)
  try {
    await persistChain
    if (recordSaved) {
      await window.arckeep.closeCapture('saved')
      return
    }
    const draft = onEscape ? captureDraftOnEscape(currentDraft()) : currentDraft()
    await window.arckeep.setCaptureDraft(draft)
    await window.arckeep.closeCapture('dismiss')
  } catch (caught) {
    error.hidden = false
    error.textContent = caught instanceof Error ? caught.message : '草稿未能保存，请先记下正文。'
  } finally {
    saving = false
    lockFields(recordSaved)
    focusInput()
  }
}

async function save(): Promise<void> {
  if (saving) return
  const draft = currentDraft()
  saving = true
  lockFields(true)
  error.hidden = true
  error.textContent = ''
  try {
    await persistChain
    if (recordSaved) {
      await window.arckeep.closeCapture('saved')
      return
    }
    await reposReady
    if (!draft.text.trim()) {
      saving = false
      lockFields(false)
      await dismiss()
      return
    }
    const result = draft.kind === 'idea'
      ? await window.arckeep.createIdea({ text: draft.text, repo: draft.repo.trim() || null })
      : await window.arckeep.createTodo(parseCaptureShorthand({
        text: draft.text,
        repoField: draft.repo,
        waitingField: draft.waiting,
        knownRepos
      }))
    if (!result.ok) {
      saving = false
      lockFields(false)
      error.hidden = false
      error.textContent = result.error
      focusInput()
      return
    }
    recordSaved = true
    await window.arckeep.closeCapture('saved')
  } catch (caught) {
    saving = false
    lockFields(recordSaved)
    error.hidden = false
    error.textContent = recordSaved
      ? '内容已记下，但窗口未能关闭。点击“关闭窗口”重试。'
      : caught instanceof Error ? caught.message : '没有记下'
    if (recordSaved) {
      const button = document.querySelector<HTMLButtonElement>('#capture-save')
      if (button) {
        button.disabled = false
        button.textContent = '关闭窗口'
      }
    }
    focusInput()
  }
}

reposReady = window.arckeep.todoRepoOptions().then(repos => {
  knownRepos = repos
  repoList.replaceChildren(...repos.map(name => {
    const option = document.createElement('option')
    option.value = name
    return option
  }))
}).catch(() => {
  // The list is optional. A typed owner/repo still saves.
})

void window.arckeep.getCaptureDraft().then(draft => {
  if (params.get('fixture') === 'filled') {
    if (kindInput) kindInput.value = 'todo'
    text.value = '记一条带仓库的待办'
    repo.value = 'example/demo'
    waiting.checked = true
  } else if (!draftEdited && !saving && !currentInput().value && !repo.value && !waiting.checked) {
    if (kindInput && ideaInput) {
      // Empty/missing drafts open as 灵感; a kind-less draft with content is a legacy todo draft.
      kindInput.value = draft.kind === 'idea'
        ? 'idea'
        : draft.kind === 'todo' || draft.text || draft.repo || draft.waiting ? 'todo' : 'idea'
    }
    currentInput().value = draft.text
    repo.value = draft.repo
    waiting.checked = draft.waiting
  }
  paintKind()
  focusInput()
}).catch(() => {
  focusInput()
})

form.addEventListener('submit', event => {
  event.preventDefault()
  void save()
})

form.addEventListener('keydown', event => {
  if (event.key !== 'Enter' || event.isComposing || (event.shiftKey && event.target === ideaInput)) return
  if (event.target !== text && event.target !== repo && event.target !== ideaInput) return
  event.preventDefault()
  void save()
})

text.addEventListener('input', () => {
  draftEdited = true
  placeCaret()
  if (!saving) void persistDraft()
})
repo.addEventListener('input', () => {
  draftEdited = true
  if (!saving) void persistDraft()
})
waiting.addEventListener('change', () => {
  draftEdited = true
  if (!saving) void persistDraft()
})
ideaInput?.addEventListener('input', () => {
  draftEdited = true
  if (!saving) void persistDraft()
})
kindInput?.addEventListener('change', () => {
  if (saving || !ideaInput) return
  draftEdited = true
  const changingToIdea = isIdea()
  const source = changingToIdea ? text : ideaInput
  if (!changingToIdea && source.value.length > 500) {
    kindInput.value = 'idea'
    error.hidden = false
    error.textContent = '当前灵感超过待办的 500 字符限制，请先保存灵感或缩短正文。'
    focusInput()
    return
  }
  if (!changingToIdea && /[\r\n]/.test(source.value)) {
    kindInput.value = 'idea'
    error.hidden = false
    error.textContent = '当前灵感含多行内容，请先保存灵感或改为单行再切换待办。'
    focusInput()
    return
  }
  if (changingToIdea && source.value.length > MAX_IDEA_LENGTH) return
  currentInput().value = source.value
  paintKind()
  error.hidden = true
  focusInput()
  void persistDraft()
})
text.addEventListener('keyup', () => placeCaret())
text.addEventListener('click', () => placeCaret())
text.addEventListener('focus', () => placeCaret())
document.addEventListener('selectionchange', () => placeCaret())

window.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return
  event.preventDefault()
  void dismiss(true)
})

if (!stayOpen) {
  window.addEventListener('blur', () => {
    if (!saving && !recordSaved) void persistDraft()
  })
}
