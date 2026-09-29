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
      '主列表收明确请求、正文里任意一节状态、review、包含待处理词的标签、尚未完成的指派，以及连续无动静的 PR。你自己的最新评论里如果还有明确请求，也算。可能相关只放「只是提及」。代码围栏、需求、路线图、变更史、人员表和步骤表不参与判断。状态文档正则示例：等 ?Dylan|AWAITING ACCEPT|HUMAN_REQUIRED|needs-dylan'
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
  const quietDays = el('input', { type: 'number', min: '1', max: '365', 'aria-label': '待你审/合的无动静天数' })
  quietDays.value = String(config.openPrQuietDays)
  const roles = el('textarea', { 'aria-label': '角色称呼' })
  roles.value = config.roleNames.join('\n')
  const roleAsks = el('textarea', { 'aria-label': '角色请求' })
  roleAsks.value = config.roleAskPhrases.join('\n')
  const headers = el('textarea', { 'aria-label': '状态头' })
  headers.value = config.statusHeaders.join('\n')
  const specs = el('textarea', { 'aria-label': '需求类标记' })
  specs.value = config.specMarkers.join('\n')
  const actors = el('textarea', { 'aria-label': '非用户负责人' })
  actors.value = config.otherActors.join('\n')
  const selfSteps = el('textarea', { 'aria-label': '自己未完成的步骤' })
  selfSteps.value = config.selfStepPhrases.join('\n')
  const verbs = el('textarea', { 'aria-label': '请求动词' })
  verbs.value = config.requestVerbs.join('\n')
  const actions = el('textarea', { 'aria-label': '请求动作' })
  actions.value = config.requestActions.join('\n')
  const ackTokens = el('textarea', { 'aria-label': 'ACK 词' })
  ackTokens.value = config.ackTokens.join('\n')
  const parked = el('textarea', { 'aria-label': '搁置标记' })
  parked.value = config.parkedMarkers.join('\n')
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
      openPrQuietDays: Number(quietDays.value),
      roleNames: lines(roles.value),
      roleAskPhrases: lines(roleAsks.value),
      statusHeaders: lines(headers.value),
      specMarkers: lines(specs.value),
      otherActors: lines(actors.value),
      selfStepPhrases: lines(selfSteps.value),
      requestVerbs: lines(verbs.value),
      requestActions: lines(actions.value),
      ackTokens: lines(ackTokens.value),
      parkedMarkers: lines(parked.value),
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
    el('h3', {}, ['角色称呼']),
    el('p', { class: 'hint' }, ['最新评论用这些称呼指代你，并同时有明确请求时，即使没有 @、也没写「用户」，也算在等你。']),
    roles,
    el('h3', {}, ['角色请求']),
    el('p', { class: 'hint' }, ['和角色称呼出现在同一条评论里才生效。例如：明示接受或拒收、请拍板、请.{0,12}(?:确认|拍板|拒收)。']),
    roleAsks,
    el('h3', {}, ['状态头']),
    el('p', { class: 'hint' }, ['只认行首或标题里的原文，区分大小写。BLOCKED 只在指向你、或没有别的阻塞对象时算。WAITING ON 必须指向你或上面的角色。句子中间的小写 blocked 不算。']),
    headers,
    el('h3', {}, ['需求类标记']),
    el('p', { class: 'hint' }, ['标题或标签命中这些词时，正文里描述功能行为的句子不算。评论或正文状态区里的明确请求仍然算。']),
    specs,
    el('h3', {}, ['非用户负责人']),
    actors,
    el('h3', {}, ['自己未完成的步骤']),
    selfSteps,
    el('h3', {}, ['请求动词和动作']),
    el('p', { class: 'hint' }, ['同一句里先出现动词、再出现动作，才是明确请求。最新一条不是你写的评论里，这样的请求即使没点名也算。若这句 @ 了别人，则不算。']),
    verbs,
    actions,
    el('h3', {}, ['ACK']),
    el('p', { class: 'hint' }, ['单独出现的 ACK 不算。同一句里要有请求动词，并且点到你或上面的角色，例如「需…ACK」。']),
    ackTokens,
    el('h3', {}, ['搁置仓库']),
    el('p', { class: 'hint' }, ['仓库描述或 topic 命中这些词时，默认不放进列表，和已忽略的仓库同样处理。']),
    parked,
    el('h3', {}, ['人工动作标签']),
    el('p', { class: 'hint' }, ['命中的标签即使没有评论也列入主列表。needs-* 这样以星号结尾的是前缀。']),
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
    el('h3', {}, ['无动静天数']),
    el('p', { class: 'hint' }, [
      '自己能推送的仓库里，非草稿 open PR 要有等你动手的信号，或者连续这么多天没有新的 push、评论和 review，才算待你审/合。默认 3 天。已经请求你 review 或指派给你的不受这几天影响。'
    ]),
    quietDays,
    el('h3', {}, ['提及']),
    mentionPolicy,
    el('p', { class: 'hint' }, ['最近这么多天内的评论里 @你，即使没有动作信号也会留下。']),
    mentionDays,
    el('div', { class: 'actions' }, [save])
  )
  return card
}
