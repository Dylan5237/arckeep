import { defaultWaitingConfig } from '../shared/waiting/rules'
import type { MentionPolicy, OpenPrScope, StatusDocRule, WaitingConfig, WaitingSources } from '../shared/waiting/types'
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

const SOURCE_FIELDS: { key: keyof WaitingSources, label: string }[] = [
  { key: 'assignee', label: '指派给我' },
  { key: 'reviewRequested', label: '请求我 review' },
  { key: 'mentions', label: '@提及我' },
  { key: 'todos', label: '待办「等我」' },
  { key: 'openPrs', label: '我仓库里的 open PR（待你审/合）' },
  { key: 'humanIssues', label: '要人动手的 Issue' },
  { key: 'statusDocs', label: '状态文档规则' },
  { key: 'localBranches', label: '本地没推送的分支' }
]

function lines(value: string): string[] {
  return value.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
}

function messageBox(parent: HTMLElement, kind: 'info' | 'error', text: string): void {
  parent.querySelector('.alert')?.remove()
  parent.append(el('div', { class: kind === 'error' ? 'alert error' : 'alert', role: 'alert' }, [text]))
}

export function renderWaitingSettings(state: AppState, rerender: () => Promise<void>): HTMLElement {
  const config = state.waiting ?? defaultWaitingConfig()
  const card = el('section', { class: 'card' }, [
    el('h2', {}, ['等我处理']),
    el('p', { class: 'hint' }, [
      '关键词和标签决定哪些 open Issue 算「要人动手」。同一段文字里的动作信号优先于已解决信号；只有整条都结束、后面没有待办时才算已解决。代码、引用和「需求 / 验收标准 / 背景 / 设计 / 规格」下面的匹配不算。状态文档正则示例：等 ?Dylan|AWAITING ACCEPT|HUMAN_REQUIRED|needs-dylan'
    ])
  ])
  const sources: WaitingSources = { ...config.sources }
  const toggles = el('div', { class: 'checks' })
  for (const field of SOURCE_FIELDS) {
    const input = el('input', { type: 'checkbox' })
    input.checked = config.sources[field.key]
    input.addEventListener('change', () => { sources[field.key] = input.checked })
    toggles.append(el('label', { class: 'check' }, [input, field.label]))
  }
  const keywords = el('textarea', { 'aria-label': '人工动作关键词' })
  keywords.value = config.humanKeywords.join('\n')
  const labels = el('textarea', { 'aria-label': '人工动作标签' })
  labels.value = config.humanLabels.join('\n')
  const resolved = el('textarea', { 'aria-label': '已解决信号' })
  resolved.value = config.resolvedSignals.join('\n')
  const dirs = el('textarea', { 'aria-label': '本地仓目录' })
  dirs.value = config.localRepoDirs.join('\n')
  const limit = el('input', { type: 'number', min: '1', max: '2000', 'aria-label': '仓库数量上限' })
  limit.value = String(config.maxScopeRepos)
  const openPrScope = el('select', { 'aria-label': '待你审/合范围' })
  openPrScope.append(
    el('option', { value: 'maintain' }, ['只看我能推送的仓库（不含仅关注、不含别人的 fork）']),
    el('option', { value: 'watching' }, ['也列出我关注的仓库里所有 open PR'])
  )
  openPrScope.value = config.openPrScope
  const mentionPolicy = el('select', { 'aria-label': '提及规则' })
  mentionPolicy.append(
    el('option', { value: 'action-or-recent' }, ['提及要有动作，或出现在最近的评论里']),
    el('option', { value: 'any' }, ['任何提及都算'])
  )
  mentionPolicy.value = config.mentionPolicy
  const mentionDays = el('input', { type: 'number', min: '1', max: '365', 'aria-label': '提及的最近天数' })
  mentionDays.value = String(config.mentionRecentDays)
  const rulesBox = el('div', { class: 'rule-list' })
  const rules: StatusDocRule[] = config.statusDocRules.map(rule => ({ ...rule }))
  const drawRules = () => {
    rulesBox.replaceChildren()
    if (rules.length === 0) rulesBox.append(el('p', { class: 'hint' }, ['还没有状态文档规则。']))
    rules.forEach((rule, index) => {
      const repo = el('input', { type: 'text', value: rule.repo, placeholder: 'owner/repo', 'aria-label': '状态文档仓库' })
      const target = el('input', { type: 'text', value: rule.target, placeholder: 'docs/STATUS.md 或 #12', 'aria-label': '文件或 Issue' })
      const pattern = el('input', { type: 'text', value: rule.pattern, placeholder: '等 ?Dylan|AWAITING ACCEPT', 'aria-label': '状态文档正则' })
      const update = () => {
        rules[index] = { repo: repo.value, target: target.value, pattern: pattern.value }
      }
      repo.addEventListener('input', update)
      target.addEventListener('input', update)
      pattern.addEventListener('input', update)
      const remove = el('button', { type: 'button', class: 'ghost' }, ['删除'])
      remove.addEventListener('click', () => {
        rules.splice(index, 1)
        drawRules()
      })
      rulesBox.append(el('div', { class: 'rule-row' }, [repo, target, pattern, remove]))
    })
  }
  drawRules()
  const add = el('button', { type: 'button', class: 'ghost' }, ['加一条规则'])
  add.addEventListener('click', () => {
    rules.push({ repo: '', target: '', pattern: '' })
    drawRules()
  })
  const save = el('button', { type: 'button', class: 'primary' }, ['保存规则'])
  save.addEventListener('click', () => {
    const next: WaitingConfig = {
      sources,
      humanKeywords: lines(keywords.value),
      humanLabels: lines(labels.value),
      resolvedSignals: lines(resolved.value),
      statusDocRules: rules.filter(rule => rule.repo || rule.target || rule.pattern),
      localRepoDirs: lines(dirs.value),
      maxScopeRepos: Number(limit.value),
      openPrScope: openPrScope.value as OpenPrScope,
      mentionPolicy: mentionPolicy.value as MentionPolicy,
      mentionRecentDays: Number(mentionDays.value),
      showIgnored: config.showIgnored
    }
    void window.arckeep.setWaiting(next).then(async result => {
      if (!result.ok) {
        messageBox(card, 'error', result.error)
        return
      }
      messageBox(card, 'info', '等我处理的规则已保存')
      await rerender()
    }).catch(error => {
      messageBox(card, 'error', error instanceof Error ? error.message : '保存失败')
    })
  })
  card.append(
    toggles,
    el('h3', {}, ['人工动作关键词']),
    keywords,
    el('h3', {}, ['人工动作标签']),
    labels,
    el('h3', {}, ['已解决信号']),
    resolved,
    el('h3', {}, ['状态文档']),
    rulesBox,
    add,
    el('h3', {}, ['本地仓目录']),
    dirs,
    el('h3', {}, ['仓库数量上限']),
    el('p', { class: 'hint' }, ['自动模式下会发现拥有的和 watching 的仓库。待你审/合默认只覆盖你能推送的仓库。空仓不查 PR。达到上限时这一页会提示。']),
    limit,
    el('h3', {}, ['待你审/合范围']),
    el('p', { class: 'hint' }, [
      '仅关注的仓库只保留和你有关的条目，不会把别人的 open PR 整仓列出来。'
    ]),
    openPrScope,
    el('h3', {}, ['提及']),
    mentionPolicy,
    el('p', { class: 'hint' }, ['最近这么多天内的评论里 @你，即使没有动作信号也会留下。']),
    mentionDays,
    el('div', { class: 'actions' }, [save])
  )
  return card
}
