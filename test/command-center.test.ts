import { describe, expect, it } from 'vitest'
import { commandCenterStatus, isCommandCenterTitle, parseCommandCenterBody, readCommandCenter } from '../src/shared/overview/command-center.js'
import { isCommandCenterRead } from '../src/shared/overview/command-center-types.js'
import { CC_BODY, CC_BODY_V031, CC_NOW, CC_REPO, ccNode, labelConnection, searchConnection } from './fixtures/command-center.js'

function read(patch: Partial<Parameters<typeof readCommandCenter>[0]> = {}) {
  return readCommandCenter({ repo: CC_REPO, labeled: labelConnection([ccNode()]), english: searchConnection([ccNode()]), chinese: searchConnection(), checkedAt: CC_NOW, ...patch })
}

describe('Command Center current state parsing', () => {
  it('reads standard §1 and phase index, preserves decision limits, references and source dates', () => {
    const content = parseCommandCenterBody(CC_BODY, CC_REPO)!
    expect(content).toMatchObject({ format: 'table', status: 'verification', declaredUpdatedOn: '2026-10-12' })
    expect(content.currentPhase).toEqual({ text: 'Phase #42：快速接入', links: [{ label: 'Phase #42', url: `https://github.com/${CC_REPO}/issues/42` }] })
    expect(content.nextAction?.text).toContain('是否 PHASE ACCEPT')
    expect(content.openGates?.links).toContainEqual({ label: '#43', url: `https://github.com/${CC_REPO}/issues/43` })
    expect(content.phases.map(phase => phase.status)).toEqual(['recorded-done', 'verification', 'backlog'])
    expect(content.blocks[0]?.value.links).toContainEqual({ label: '#43', url: `https://github.com/${CC_REPO}/issues/43` })
    expect(content.warnings).toEqual([])
  })

  it('reads the live narrative shape without reviving the historical phase inside details', () => {
    const content = parseCommandCenterBody(`## 1. 当前一句话状态
**当前状态：等待内网恢复后核对基线。**

状态：\`status:blocked\`（等待内网与最新基线）。

**唯一下一动作：读取最新 refs 并核对目标分支。**

恢复条件：目标基线已核对。

<details>
<summary>历史快照</summary>

**当前阶段：F3.5**

状态：done

</details>

## 2. Roadmap
- [x] 历史阶段
`, CC_REPO)!
    expect(content).toMatchObject({ format: 'narrative', status: 'blocked', currentPhase: null })
    expect(content.summary?.text).toContain('等待内网恢复')
    expect(content.nextAction?.text).toContain('读取最新 refs')
    expect(content.openGates?.text).toContain('目标基线已核对')
    expect(JSON.stringify(content)).not.toContain('F3.5')
    expect(content.phases).toEqual([])
  })

  it('preserves a legacy Item/Current summary without guessing status from green CI or merged PRs', () => {
    const content = parseCommandCenterBody(`## 1. One-glance status — VERIFIED
> **最新状态：候选已合入，现场验收未执行。**

| Item | Current |
| --- | --- |
| Stage | Stabilization / Productization |
| CI verified | 全部 success |
| Merged test candidate | PR #91 merged，不是 PHASE PASS |

**Single Next Action**：等待用户现场验证。
`, CC_REPO)!
    expect(content.status).toBe('unknown')
    expect(content.currentPhase?.text).toBe('Stabilization / Productization')
    expect(content.fields.map(field => field.label)).toContain('CI verified')
    expect(content.summary?.text).toContain('现场验收未执行')
    expect(content.warnings).toContain('总控台未提供可识别的明确状态')
  })

  it.each([
    '```markdown\n状态：done\n```',
    '    状态：done',
    '> 状态：done',
    '### 历史快照\n\n状态：done',
    '### Example\n\n| Field | Value |\n| --- | --- |\n| Status word | done |'
  ])('does not turn non-current content into status: %s', extra => {
    const body = `## 1. One-glance\n\nSingle Next Action: 请核对总控台\n\n${extra}`
    expect(parseCommandCenterBody(body, CC_REPO)?.status).toBe('unknown')
  })

  it('rejects conflicting current fields and multiple one-glance sections', () => {
    const body = CC_BODY.replace('| **Status word** | verification |', '| Status word | verification |\n| Status word | done |')
    expect(parseCommandCenterBody(body, CC_REPO)).toMatchObject({ status: 'unknown', statusText: null })
    expect(parseCommandCenterBody(`${CC_BODY}\n## 1. One-glance\nStatus word: done`, CC_REPO)).toBeNull()
  })

  it('never drops an unrecognized narrative status that contradicts a structured completion record', () => {
    const body = CC_BODY.replace('| **Status word** | verification |', '| Status word | done |').replace('Updated:', 'Status: blocked — awaiting restored permissions\n\nUpdated:')
    const content = parseCommandCenterBody(body, CC_REPO)!
    expect(content.status).toBe('unknown')
    expect(content.statusText).toBeNull()
    expect(content.fields.some(field => field.value.text.includes('restored permissions'))).toBe(true)
    expect(content.warnings.join()).toContain('冲突记录')
  })

  it.each([false, true])('detects complex Current status conflicts in either declaration order: %s', reverse => {
    const context = 'Current status: blocked — awaiting restored permissions'
    const completion = 'Status word: done'
    const body = `## 1. One-glance\n\n${(reverse ? [completion, context] : [context, completion]).join('\n\n')}`
    const content = parseCommandCenterBody(body, CC_REPO)!
    expect(content.status).toBe('unknown')
    expect(content.warnings.join()).toContain('冲突记录')
  })

  it('does not allow free Current status descriptions to endorse completion based on ordering', () => {
    const context = 'Current status: waiting for restored permissions'
    for (const paragraphs of [[context, 'Status word: done'], ['Status word: done', context]]) {
      const content = parseCommandCenterBody(`## 1. One-glance\n\n${paragraphs.join('\n\n')}`, CC_REPO)!
      expect(content.status).toBe('unknown')
      expect(content.warnings.join()).toContain('状态描述并存')
    }
  })

  it('excludes struck-through status and references from current observations', () => {
    const body = CC_BODY.replace('| **Status word** | verification |', '| Status word | ~~done~~ |').replace('| **Current phase** |', '| ~~Current phase~~ |')
    expect(parseCommandCenterBody(body, CC_REPO)).toMatchObject({ status: 'unknown', currentPhase: null })
    const content = parseCommandCenterBody(CC_BODY.replace('快速接入', '~~[#99](https://github.com/example/project/issues/99)~~ 快速接入'), CC_REPO)!
    expect(content.currentPhase?.links.some(link => link.url.endsWith('/99'))).toBe(false)
  })

  it.each([
    CC_BODY.replace('## 1. One-glance / 一眼状态', '## 1. One-glance / 历史快照'),
    `# 历史快照\n\n${CC_BODY}`,
    `# Examples\n\n${CC_BODY}`,
    `# 历史快照\n\n## 历史说明\n\n${CC_BODY}`,
    `# Historical snapshot\n\n## Archived notes\n\n${CC_BODY}`
  ])('rejects a historical or example summary even when its child section looks current', body => {
    expect(parseCommandCenterBody(body, CC_REPO)).toBeNull()
  })

  it('excludes historical phase-index subsections and returns to current headings at the same depth', () => {
    const history = '### 历史快照\n\n| Phase issue | Status |\n| --- | --- |\n| #42 | done |\n\n'
    const body = CC_BODY.replace('## Open exceptions', `${history}## Open exceptions`)
    const content = parseCommandCenterBody(body, CC_REPO)!
    expect(content.phases.filter(phase => phase.reference.text === '#42').map(phase => phase.status)).toEqual(['verification'])
    expect(content.blocks).toHaveLength(1)
    expect(parseCommandCenterBody(`# 历史快照\n\n${CC_BODY}\n# Current\n\n${CC_BODY}`, CC_REPO)?.status).toBe('verification')
  })

  it('reads adjacent narrative fields in one paragraph without losing the blocked state', () => {
    const body = '## 1. One-glance\n\nCurrent phase: #42\nStatus: blocked\nNext action: Restore permissions\n'
    expect(parseCommandCenterBody(body, CC_REPO)).toMatchObject({ status: 'blocked', currentPhase: { text: '#42' }, nextAction: { text: 'Restore permissions' } })
  })

  it('discloses truncation of the complete exceptions/blocks list across multiple tables', () => {
    const rows = Array.from({ length: 31 }, (_, index) => `| #${100 + index} | #42 | BLOCKED |`).join('\n')
    const body = CC_BODY.replace('| [#43](https://github.com/example/project/issues/43) 合同变更 | #42 | DECISION PENDING |', rows)
    const content = parseCommandCenterBody(body, CC_REPO)!
    expect(content.blocks).toHaveLength(30)
    expect(content.warnings.join()).toContain('阻塞记录超过 30 项')
  })

  it('accepts BOM-prefixed standard Markdown and the older explicit Section 1 heading', () => {
    expect(parseCommandCenterBody(`\uFEFF${CC_BODY}`, CC_REPO)?.status).toBe('verification')
    const body = '## Section 1 — Current phase / status / gate\n\n- Current phase: P0–P6 roadmap complete\n- Status: gates closed\n- Next Action: Human ratification is still recommended\n'
    expect(parseCommandCenterBody(body, CC_REPO)).toMatchObject({ status: 'unknown', currentPhase: { text: 'P0–P6 roadmap complete' }, nextAction: { text: 'Human ratification is still recommended' } })
  })

  it.each(['IN PROGRESS（Stage 议题）', 'in-progress / HUMAN_CHROME_EVIDENCE_COLLECTION', '已 Freeze / 实施中'])('recognizes a declared implementation state without deriving acceptance: %s', value => {
    expect(commandCenterStatus(value)).toBe('implementation')
  })

  it('rejects missing §1 and oversized bodies; invalid declared dates do not break the batch', () => {
    expect(parseCommandCenterBody('## Phase index\n状态：done', CC_REPO)).toBeNull()
    expect(parseCommandCenterBody(`## 1. One-glance\n${'x'.repeat(80_001)}`, CC_REPO)).toBeNull()
    expect(parseCommandCenterBody(CC_BODY.replace('Updated: 2026-10-12.', 'Updated: 2026-99-99.'), CC_REPO)?.declaredUpdatedOn).toBeNull()
    expect(parseCommandCenterBody(CC_BODY.replace('Updated: 2026-10-12.', 'Updated: 2026-02-31.'), CC_REPO)?.declaredUpdatedOn).toBeNull()
  })

  it.each(['not done', 'verification / done', 'PASS', 'CI success', 'awaiting deployment', 'implementation-ready'])('keeps ambiguous status unknown: %s', value => {
    expect(commandCenterStatus(value)).toBe('unknown')
  })

  it('limits a large phase index with an explicit disclosure and never invents a completion percentage', () => {
    const rows = Array.from({ length: 45 }, (_, n) => `| #${100 + n} | 目标 | backlog | 未启动 |`).join('\n')
    const content = parseCommandCenterBody(CC_BODY.replace('| #44 | 后续扩展 | backlog | 待冻结 |', rows), CC_REPO)!
    expect(content.phases).toHaveLength(30)
    expect(content.warnings.join()).toContain('超过 30 项')
    expect(JSON.stringify(content)).not.toContain('percentage')
  })

  it('never renders raw HTML or follows javascript and disguised-host links', () => {
    const body = CC_BODY.replace('快速接入', '<img src=x onerror=alert(1)> [坏链接](javascript:alert(1)) [伪造](https://github.com.evil.invalid/x)')
    const content = parseCommandCenterBody(body, CC_REPO)!
    expect(JSON.stringify(content.currentPhase)).not.toContain('onerror')
    expect(content.currentPhase?.links).toEqual([{ label: 'Phase #42', url: `https://github.com/${CC_REPO}/issues/42` }])
  })
})

describe('bounded Command Center discovery', () => {
  it('deduplicates label/title observations and validates the reusable cache contract', () => {
    expect(read().kind).toBe('ready')
    expect(isCommandCenterRead(read(), CC_REPO)).toBe(true)
    expect(isCommandCenterRead(read(), 'example/another')).toBe(false)
  })

  it.each(['[Command Center] project', '[Project Command Center] project', '[项目总控台 / Project Command Center] project', '[项目总控台] project'])('recognizes an unlabeled control-plane title: %s', title => {
    expect(isCommandCenterTitle(title)).toBe(true)
    expect(read({ labeled: labelConnection(), english: searchConnection([ccNode({ title })]) }).kind).toBe('ready')
  })

  it('does not treat a feature request about Command Center as the project control plane', () => {
    const result = read({ labeled: labelConnection(), english: searchConnection([ccNode({ title: '[UI] Project Command Center and timeline' })]) })
    expect(result.kind).toBe('missing')
  })

  it('distinguishes absent, unavailable, unsupported, ambiguous, and truncated results', () => {
    expect(read({ labeled: labelConnection(), english: searchConnection() }).kind).toBe('missing')
    expect(read({ english: undefined }).kind).toBe('unavailable')
    expect(read({ labeled: labelConnection([ccNode({ body: 'No summary' })]), english: searchConnection() }).kind).toBe('unsupported')
    expect(read({ chinese: searchConnection([ccNode({ number: 2, url: `https://github.com/${CC_REPO}/issues/2` })]) }).kind).toBe('ambiguous')
    expect(read({ english: searchConnection([], 7) })).toMatchObject({ kind: 'ambiguous', truncated: true })
  })

  it.each([{ state: 'CLOSED' }, { url: 'https://github.com/another/repo/issues/1' }, { body: null }, { updatedAt: 'invalid' }])('does not declare missing when a labelled candidate is malformed: %j', patch => {
    expect(read({ labeled: labelConnection([ccNode(patch)]) }).kind).toBe('unavailable')
  })

  it('detects an issue edited between the label and search observations', () => {
    expect(read({ english: searchConnection([ccNode({ body: CC_BODY.replace('verification', 'blocked') })]) })).toMatchObject({ kind: 'unavailable' })
  })

  it('does not reuse malformed or unsafe content from a disk cache', () => {
    const valid = read()
    if (valid.kind !== 'ready') throw new Error('fixture not ready')
    expect(isCommandCenterRead({ ...valid, content: { ...valid.content, phases: null } }, CC_REPO)).toBe(false)
    expect(isCommandCenterRead({ ...valid, content: { ...valid.content, nextAction: { text: 'evil', links: [{ label: 'evil', url: 'javascript:alert(1)' }] } } }, CC_REPO)).toBe(false)
  })
})

describe('Command Center APO v0.3.1 template', () => {
  const content = () => parseCommandCenterBody(CC_BODY_V031, CC_REPO)!

  it('reads the generated two-column status table without warnings', () => {
    expect(content()).toMatchObject({ format: 'table', status: 'awaiting-accept', declaredUpdatedOn: '2026-10-22' })
    expect(content().currentPhase).toEqual({ text: '#64 导出报表', links: [{ label: '#64', url: `https://github.com/${CC_REPO}/issues/64` }] })
    expect(content().lastClosedPhase?.text).toBe('#60 登录页')
    expect(content().openGates?.text).toBe('无')
    expect(content().nextAction?.text).toBe('等你验收 #64')
    expect(content().warnings).toEqual([])
  })

  it('keeps each pending decision request as its own text with its link', () => {
    expect(content().pendingDecision?.text).toContain('D-3 rev 2（最终验收）')
    expect(content().pendingDecision?.text).toContain('D-4 rev 1（开工确认）')
    expect(content().pendingDecision?.links.map(link => link.url)).toEqual([
      `https://github.com/${CC_REPO}/issues/64#issuecomment-1`, `https://github.com/${CC_REPO}/issues/65#issuecomment-2`
    ].filter(url => url.startsWith('https://github.com/')))
  })

  it('maps the new status words and keeps the index and blocker table', () => {
    expect(content().phases.map(phase => phase.status)).toEqual(['recorded-done', 'awaiting-accept', 'backlog', 'blocked', 'implementation'])
    expect(content().blocks[0]?.label).toContain('#66')
  })

  it.each([['未开工', 'backlog'], ['进行中', 'implementation'], ['卡住', 'blocked'], ['待验收', 'awaiting-accept'], ['已完成', 'recorded-done']])('reads status 「%s」', (word, status) => {
    expect(commandCenterStatus(word)).toBe(status)
  })

  it('records the process tier from 项目设置 and leaves older templates unset', () => {
    expect(content().processMode).toBe('light')
    expect(parseCommandCenterBody(CC_BODY_V031.replace('process_mode=light', 'process_mode=standard'), CC_REPO)?.processMode).toBe('standard')
    expect(parseCommandCenterBody(CC_BODY, CC_REPO)?.processMode).toBeNull()
  })

  it('ignores a process tier written outside the 项目设置 section or in history', () => {
    const outside = `${CC_BODY_V031.replace('process_mode=light', 'process_mode=standard')}
## 接入记录

- 曾用 process_mode=light
`
    expect(parseCommandCenterBody(outside, CC_REPO)?.processMode).toBe('standard')
    const conflict = `${CC_BODY_V031}
## 项目设置

- 流程档位：process_mode=standard
`
    expect(parseCommandCenterBody(conflict, CC_REPO)?.processMode).toBeNull()
  })

  it('survives the disk-cache validator', () => {
    const read = { kind: 'ready', source: { number: 1, title: '[Command Center] x', url: `https://github.com/${CC_REPO}/issues/1`, updatedAt: CC_NOW }, content: content(), checkedAt: CC_NOW }
    expect(isCommandCenterRead(read, CC_REPO)).toBe(true)
    expect(isCommandCenterRead({ ...read, content: { ...content(), processMode: 'turbo' } }, CC_REPO)).toBe(false)
  })
})
