import { DEFAULT_REPO_FETCH_WINDOW, REPO_FETCH_WINDOWS, type RepoFetchWindow } from '../shared/repo-fetch-window'
import type { AppState } from '../shared/types'

export function repoFetchWindowControl(value: RepoFetchWindow, onChange?: (value: RepoFetchWindow) => void, disabled = false): HTMLSelectElement {
  const select = document.createElement('select')
  select.setAttribute('aria-label', '仓库推送时间范围')
  select.className = 'repo-fetch-window'
  select.title = '按仓库最近推送时间限制查询范围'
  for (const window of REPO_FETCH_WINDOWS) {
    const option = document.createElement('option')
    option.value = window
    option.textContent = window === 'all' ? '全部仓库' : `近 ${window.slice(0, -1)} 天`
    select.append(option)
  }
  select.value = value
  select.disabled = disabled
  if (onChange) select.addEventListener('change', () => onChange(select.value as RepoFetchWindow))
  return select
}

export function renderRepoFetchWindowSettings(state: AppState, rerender: () => Promise<void>): HTMLElement {
  const card = document.createElement('section')
  card.className = 'card'
  card.id = 'repo-fetch-window-settings'
  const heading = document.createElement('h2')
  heading.textContent = '仓库查询范围'
  const hint = document.createElement('p')
  hint.className = 'hint'
  hint.textContent = '项目总览与等我处理共用此设置。默认查询近 7 天有推送的仓库，按连续 24 小时计算；范围外和从未推送的仓库不读取详情。需要检查历史项目时选“全部仓库”。直接指派、请求 review、提及你的事项，以及手动配置的状态文档和本机待办仍会检查。'
  const row = document.createElement('div')
  row.className = 'row'
  const select = repoFetchWindowControl(state.repoFetchWindow ?? DEFAULT_REPO_FETCH_WINDOW)
  const save = document.createElement('button')
  save.type = 'button'
  save.className = 'primary'
  save.textContent = '保存查询范围'
  const status = document.createElement('p')
  status.setAttribute('role', 'status')
  save.addEventListener('click', async () => {
    save.disabled = true
    select.disabled = true
    try {
      const result = await window.arckeep.setRepoFetchWindow(select.value as RepoFetchWindow)
      if (!result.ok) throw new Error(result.error)
      status.textContent = '查询范围已保存，两个页面下一次刷新时生效'
      if (!card.isConnected) return
      await rerender()
    } catch (error) {
      status.className = 'alert error'
      status.textContent = error instanceof Error ? error.message : '查询范围保存失败'
    } finally {
      save.disabled = false
      select.disabled = false
    }
  })
  row.append(select, save)
  card.append(heading, hint, row, status)
  return card
}
