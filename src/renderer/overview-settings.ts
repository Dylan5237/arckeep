import { DEFAULT_STALE_DAYS, DEFAULT_STALE_REPO_DAYS, defaultOverviewConfig } from '../shared/overview/rules'
import type { OverviewConfig } from '../shared/overview/types'
import type { AppState } from '../shared/types'

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
  for (const child of children) node.append(child instanceof Node ? child : document.createTextNode(child))
  return node
}

function messageBox(parent: HTMLElement, kind: 'info' | 'error', text: string): void {
  parent.querySelector('.alert')?.remove()
  parent.append(el('div', { class: kind === 'error' ? 'alert error' : 'alert', role: 'alert' }, [text]))
}

function numberField(label: string, value: number): HTMLInputElement {
  return el('input', {
    type: 'number',
    min: '0',
    max: '3650',
    value: String(value),
    'aria-label': label
  })
}

export function renderOverviewSettings(state: AppState, rerender: () => Promise<void>): HTMLElement {
  const config = state.overview ?? defaultOverviewConfig()
  const card = el('section', { class: 'card', id: 'overview-settings' }, [
    el('h2', {}, ['项目总览']),
    el('p', { class: 'hint' }, [
      '关注列表留空时，自动发现你拥有的、作为协作者的、以及作为组织成员且有写权限的仓库，并按共用的推送时间范围查询。只 watch、没有写权限的仓库不会出现，已归档仓库默认也不出现。查询到的仓库再按最近提交、Issue/PR 活动、推送或创建时间分为活跃和陈旧；陈旧天数只决定分组，需要查询较久未推送的项目时应扩大上方的仓库查询范围。'
    ])
  ])
  const staleDays = numberField('停滞天数', config.staleDays)
  const reviewWaitDays = numberField('review 等待天数', config.reviewWaitDays)
  const staleRepoDays = numberField('陈旧天数', config.staleRepoDays)
  const maxScopeRepos = numberField('仓库数量上限', config.maxScopeRepos)
  const showArchived = el('input', { type: 'checkbox' })
  showArchived.checked = config.showArchived
  const save = el('button', { type: 'button', class: 'primary' }, ['保存项目总览'])
  save.addEventListener('click', () => {
    const next: OverviewConfig = {
      staleDays: Number(staleDays.value),
      reviewWaitDays: Number(reviewWaitDays.value),
      staleRepoDays: Number(staleRepoDays.value),
      maxScopeRepos: Number(maxScopeRepos.value),
      showArchived: showArchived.checked
    }
    void window.arckeep.setOverview(next).then(async result => {
      if (!result.ok) {
        messageBox(card, 'error', result.error)
        return
      }
      messageBox(card, 'info', '项目总览的规则已保存')
      await rerender()
    }).catch(error => {
      messageBox(card, 'error', error instanceof Error ? error.message : '保存失败')
    })
  })
  card.append(
    el('h3', {}, ['停滞天数']),
    el('p', { class: 'hint' }, [
      `默认 ${DEFAULT_STALE_DAYS} 天，只判活跃列表里的仓库。默认分支上的最后一次提交，以及 Issue / PR 的创建、更新和评论，两边的静止时间都要超过这么多天才标成停滞；刚好这么多天不算。有一边还没超过就不算。行上的「停滞 X 天」按较新的那一边计算。陈旧分组里的仓库不再标停滞。刚创建、还没有任何提交或 Issue/PR 活动的空仓不算停滞。`
    ]),
    staleDays,
    el('h3', {}, ['review 等待天数']),
    el('p', { class: 'hint' }, ['未合并、非草稿、还没有通过 review 的 PR，等够这么多天就标成卡住，并链到那个 PR。']),
    reviewWaitDays,
    el('h3', {}, ['陈旧天数']),
    el('p', { class: 'hint' }, [
      `默认 ${DEFAULT_STALE_REPO_DAYS} 天。最近活动是最后一次提交、最近的 Issue / PR 活动、仓库推送时间和仓库创建时间里最新的一个。还在这么多天以内（含刚好这么多天）留在活跃列表，再久就收进可折叠的陈旧分组。页头「需要看一眼」不算陈旧分组里的仓库。陈旧的空仓不计入，行里仍显示「空仓」。`
    ]),
    staleRepoDays,
    el('label', { class: 'check' }, [showArchived, '显示已归档的仓库']),
    el('p', { class: 'hint' }, ['默认不列出 GitHub 上已归档的仓库，关注列表里的也一样，并且不标停滞、卡住、空仓或陈旧。打开后它们出现在折叠的「已归档」分组里，只有一颗灰色标签。']),
    el('h3', {}, ['仓库数量上限']),
    el('p', { class: 'hint' }, ['达到上限时这一页会提示，不会悄悄丢掉其余仓库。']),
    maxScopeRepos,
    el('div', { class: 'actions' }, [save])
  )
  return card
}
