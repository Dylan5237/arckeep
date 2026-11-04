import { describe, expect, it } from 'vitest'
import { parseAgentProtocol, parseAgentResultBlock, normalizeTaskCreate, normalizeTaskUpdate } from '../src/shared/tasks/validate.js'

const RUN = '123e4567-e89b-42d3-a456-426614174001'
const CWD = 'C:\\work\\demo'
const NOW = new Date('2026-11-04T10:00:00.000Z')

function block(value: unknown): string {
  return '工作完成。\n\n```arckeep-result\n' + JSON.stringify(value, null, 2) + '\n```'
}

describe('task result protocol', () => {
  it('parses the last structured result block with artifacts, checks and unverified items', () => {
    const text = [
      '```arckeep-result',
      '{"status":"waiting","summary":"旧结果"}',
      '```',
      block({
        status: 'done',
        summary: '实现了任务页并运行测试',
        artifacts: [
          { kind: 'file', label: '任务页', path: 'src/renderer/tasks-page.ts' },
          { kind: 'url', label: 'PR', url: 'https://github.com/example/demo/pull/12' },
          { kind: 'text', label: '说明', text: '注意这里是文本' }
        ],
        checks: [
          { name: 'npm test', status: 'passed', detail: '退出码 0' },
          { name: '手工验收', status: 'pending' }
        ],
        unverified: ['真实 Windows 安装包'],
        wait: null,
        decision: null
      })
    ].join('\n')
    const parsed = parseAgentProtocol(text, { runId: RUN, cwd: CWD, now: NOW })
    expect(parsed.status).toBe('done')
    expect(parsed.summary).toBe('实现了任务页并运行测试')
    expect(parsed.artifacts).toHaveLength(3)
    expect(parsed.artifacts[0].path).toBe(CWD + '\\src\\renderer\\tasks-page.ts')
    expect(parsed.artifacts[1].url).toBe('https://github.com/example/demo/pull/12')
    expect(parsed.checks.map(item => item.status)).toEqual(['passed', 'not_run'])
    expect(parsed.unverified).toEqual(['真实 Windows 安装包'])
    expect(parsed.warning).toBeNull()
  })

  it('extracts only the fenced arckeep-result block and rejects malformed JSON', () => {
    expect(parseAgentResultBlock('```json\n{"status":"done"}\n```')).toBeNull()
    expect(parseAgentResultBlock('```arckeep-result\n{"status":\n```')).toBeNull()
    expect(parseAgentResultBlock('```arckeep-result\n{"status":"done"}\n```')).toEqual({ status: 'done' })
  })

  it('warns instead of inventing evidence when the agent omits the block', () => {
    const parsed = parseAgentProtocol('我改好了，但没有结构化结果。', { runId: RUN, cwd: CWD, now: NOW })
    expect(parsed.status).toBe('unknown')
    expect(parsed.summary).toContain('我改好了')
    expect(parsed.warning).toContain('arckeep-result')
    expect(parsed.artifacts).toEqual([])
  })

  it('accepts a future timer wait and rejects a past one', () => {
    const future = parseAgentProtocol(block({
      status: 'waiting',
      summary: '等待复查',
      wait: { type: 'timer', until: '2026-11-05T10:00:00.000Z', reason: '明早再看' }
    }), { runId: RUN, cwd: CWD, now: NOW })
    expect(future.status).toBe('waiting')
    expect(future.wait).toEqual({ type: 'timer', reason: '明早再看', until: '2026-11-05T10:00:00.000Z', repo: null, pr: null })

    const past = parseAgentProtocol(block({
      status: 'waiting',
      summary: '等待复查',
      wait: { type: 'timer', until: '2026-11-03T10:00:00.000Z', reason: '已经过去' }
    }), { runId: RUN, cwd: CWD, now: NOW })
    expect(past.status).toBe('unknown')
    expect(past.wait).toBeNull()
    expect(past.warning).toContain('等待')
  })

  it('normalizes GitHub checks waits and rejects missing identifiers', () => {
    const parsed = parseAgentProtocol(block({
      status: 'waiting',
      summary: '等待 CI',
      wait: { type: 'github_checks', repo: 'example/demo', pr: 12, reason: '等 CI' }
    }), { runId: RUN, cwd: CWD, now: NOW })
    expect(parsed.wait).toEqual({ type: 'github_checks', reason: '等 CI', until: null, repo: 'example/demo', pr: 12 })

    const bad = parseAgentProtocol(block({
      status: 'waiting',
      wait: { type: 'github_checks', repo: 'example/demo' }
    }), { runId: RUN, cwd: CWD, now: NOW })
    expect(bad.status).toBe('unknown')
    expect(bad.warning).toContain('PR')
  })

  it('requires structured decision options and keeps the recommended option', () => {
    const parsed = parseAgentProtocol(block({
      status: 'needs_decision',
      summary: '有两个方案',
      decision: {
        question: '用哪个方案？',
        whyYou: '涉及产品取舍',
        recommendation: 'A',
        options: [
          { id: 'A', label: '小改', impact: '改动小' },
          { id: 'B', label: '重做', impact: '耗时' }
        ],
        expiresAt: '2026-11-05T10:00:00.000Z'
      }
    }), { runId: RUN, cwd: CWD, now: NOW })
    expect(parsed.status).toBe('needs_decision')
    expect(parsed.decision?.options).toHaveLength(2)
    expect(parsed.decision?.recommendation).toBe('A')

    const bad = parseAgentProtocol(block({
      status: 'needs_decision',
      decision: { question: '选一个', options: [] }
    }), { runId: RUN, cwd: CWD, now: NOW })
    expect(bad.status).toBe('unknown')
    expect(bad.decision).toBeNull()
  })

  it('drops unsafe artifacts and non-http URLs instead of exposing them', () => {
    const parsed = parseAgentProtocol(block({
      status: 'done',
      summary: '完成',
      artifacts: [
        { kind: 'url', label: 'bad', url: 'javascript:alert(1)' },
        { kind: 'file', label: 'nul', path: 'x\0y' },
        { kind: 'file', label: 'ok', path: 'C:\\work\\demo\\out.txt' }
      ]
    }), { runId: RUN, cwd: CWD, now: NOW })
    expect(parsed.artifacts).toHaveLength(1)
    expect(parsed.artifacts[0].label).toBe('ok')
  })

  it('normalizes task inputs and rejects relative working directories', () => {
    expect(normalizeTaskCreate({
      goal: '修一个 bug',
      repo: 'example/demo',
      cwd: CWD,
      agent: 'auto',
      autonomy: 'edit',
      priority: 'normal',
      source: 'manual',
      start: false
    })).toMatchObject({ title: null, repo: 'example/demo', agent: 'auto', start: false })
    expect(() => normalizeTaskUpdate({ id: RUN, cwd: 'relative/path' })).toThrow('绝对路径')
  })
})
