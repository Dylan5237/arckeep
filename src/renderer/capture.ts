const textInput = document.querySelector<HTMLInputElement>('#text')
const repoInput = document.querySelector<HTMLInputElement>('#repo')
const waitingInput = document.querySelector<HTMLInputElement>('#waiting')
const errorBox = document.querySelector<HTMLElement>('#error')
const form = document.querySelector<HTMLFormElement>('#capture-form')
const repoList = document.querySelector<HTMLDataListElement>('#capture-repos')

if (!textInput || !repoInput || !waitingInput || !errorBox || !form || !repoList) {
  throw new Error('快速捕获页面不完整')
}

const text: HTMLInputElement = textInput
const repo: HTMLInputElement = repoInput
const waiting: HTMLInputElement = waitingInput
const error: HTMLElement = errorBox

const params = new URLSearchParams(location.search)
if (params.get('fixture') === 'filled') {
  text.value = '记一条带仓库的待办'
  repo.value = 'example/demo'
  waiting.checked = true
}

void window.arckeep.todoRepoOptions().then(repos => {
  repoList.replaceChildren(...repos.map(name => {
    const option = document.createElement('option')
    option.value = name
    return option
  }))
}).catch(() => {
  // The list is optional. Typing owner/repo still works.
})

text.focus()

form.addEventListener('submit', event => {
  event.preventDefault()
  void save()
})

window.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return
  event.preventDefault()
  void window.arckeep.closeCapture()
})

async function save(): Promise<void> {
  error.hidden = true
  error.textContent = ''
  const result = await window.arckeep.createTodo({
    text: text.value,
    repo: repo.value,
    waiting: waiting.checked
  })
  if (!result.ok) {
    error.hidden = false
    error.textContent = result.error
    text.focus()
    return
  }
  await window.arckeep.closeCapture()
}
