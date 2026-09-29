import { captureDraftOnEscape } from '../shared/todos/capture-draft'
import { parseCaptureShorthand } from '../shared/todos/parse-capture'

const textInput = document.querySelector<HTMLInputElement>('#text')
const repoInput = document.querySelector<HTMLInputElement>('#repo')
const waitingInput = document.querySelector<HTMLInputElement>('#waiting')
const errorBox = document.querySelector<HTMLElement>('#error')
const form = document.querySelector<HTMLFormElement>('#capture-form')
const repoList = document.querySelector<HTMLDataListElement>('#capture-repos')
const caretMark = document.querySelector<HTMLElement>('#caret')
const caretProbe = document.querySelector<HTMLElement>('#caret-probe')

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
  text.focus()
  const end = text.value.length
  text.setSelectionRange(end, end)
  placeCaret()
}

function currentDraft() {
  return { text: text.value, repo: repo.value, waiting: waiting.checked }
}

function persistDraft(): Promise<void> {
  const job = persistChain.then(async () => {
    if (saving) return
    await window.arckeep.setCaptureDraft(currentDraft())
  })
  persistChain = job.then(() => undefined, () => undefined)
  return job
}

async function dismiss(onEscape = false): Promise<void> {
  if (saving) return
  saving = true
  try {
    await persistChain
    const draft = onEscape ? captureDraftOnEscape(currentDraft()) : currentDraft()
    await window.arckeep.setCaptureDraft(draft)
    await window.arckeep.closeCapture('dismiss')
  } finally {
    saving = false
  }
}

async function save(): Promise<void> {
  if (saving) return
  saving = true
  error.hidden = true
  error.textContent = ''
  try {
    await reposReady
    const parsed = parseCaptureShorthand({
      text: text.value,
      repoField: repo.value,
      waitingField: waiting.checked,
      knownRepos
    })
    if (!parsed.text) {
      saving = false
      await dismiss()
      return
    }
    const result = await window.arckeep.createTodo(parsed)
    if (!result.ok) {
      saving = false
      error.hidden = false
      error.textContent = result.error
      focusInput()
      return
    }
    await window.arckeep.closeCapture('saved')
  } catch (caught) {
    saving = false
    error.hidden = false
    error.textContent = caught instanceof Error ? caught.message : '没有记下'
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
    text.value = '记一条带仓库的待办'
    repo.value = 'example/demo'
    waiting.checked = true
  } else if (!text.value && !repo.value && !waiting.checked) {
    text.value = draft.text
    repo.value = draft.repo
    waiting.checked = draft.waiting
  }
  focusInput()
}).catch(() => {
  focusInput()
})

form.addEventListener('submit', event => {
  event.preventDefault()
  void save()
})

form.addEventListener('keydown', event => {
  if (event.key !== 'Enter' || event.isComposing) return
  if (event.target !== text && event.target !== repo) return
  event.preventDefault()
  void save()
})

text.addEventListener('input', () => {
  placeCaret()
  if (!saving) void persistDraft()
})
repo.addEventListener('input', () => {
  if (!saving) void persistDraft()
})
waiting.addEventListener('change', () => {
  if (!saving) void persistDraft()
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
    void persistDraft()
  })
}
