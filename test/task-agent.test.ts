import { describe, expect, it } from 'vitest'
import { agentArgsForClaude, agentArgsForCodex, buildAgentInvocation } from '../src/main/tasks/agent-command.js'
import { parseClaudeStream, parseCodexStream, progressFromLine } from '../src/main/tasks/agent-output.js'

describe('agent command construction', () => {
  it('uses a new session id for the first Claude run and resume for later runs', () => {
    const first = agentArgsForClaude({ sessionId: '123e4567-e89b-42d3-a456-426614174001', resume: false, autonomy: 'edit' })
    expect(first).toContain('--session-id')
    expect(first).not.toContain('--resume')
    expect(first).toContain('stream-json')
    const later = agentArgsForClaude({ sessionId: '123e4567-e89b-42d3-a456-426614174001', resume: true, autonomy: 'full' })
    expect(later).toContain('--resume')
    expect(later).not.toContain('--session-id')
    expect(later).toContain('--dangerously-skip-permissions')
    const readOnly = agentArgsForClaude({ sessionId: '123e4567-e89b-42d3-a456-426614174001', resume: false, autonomy: 'read-only' })
    expect(readOnly).toContain('plan')
  })

  it('keeps Codex in an explicit sandbox except for full autonomy and passes the prompt on stdin', () => {
    const args = agentArgsForCodex({ sessionId: '', resume: false, autonomy: 'edit' })
    expect(args).toContain("sandbox_mode='workspace-write'")
    expect(args).toContain("approval_policy='never'")
    expect(args.at(-1)).toBe('-')
    const full = agentArgsForCodex({ sessionId: 'abc', resume: true, autonomy: 'full' })
    expect(full.slice(0, 3)).toEqual(['exec', 'resume', 'abc'])
    expect(full).toContain('--dangerously-bypass-approvals-and-sandbox')
    const invocation = buildAgentInvocation({
      agent: 'claude',
      file: 'claude.exe',
      sessionId: '123e4567-e89b-42d3-a456-426614174001',
      resume: false,
      autonomy: 'edit',
      prompt: 'hello "quoted" & text'
    })
    expect(invocation.stdin).toBe('hello "quoted" & text')
    expect(invocation.args.join(' ')).not.toContain('hello')
  })
})

describe('agent output parsing', () => {
  const SESSION = '123e4567-e89b-42d3-a456-426614174001'

  it('reads the Claude result event, cost, tokens and session id', () => {
    const stdout = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: SESSION }),
      JSON.stringify({ type: 'assistant', session_id: SESSION, message: { content: [{ type: 'text', text: '中间说明' }] } }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        session_id: SESSION,
        result: '最终结果',
        is_error: false,
        total_cost_usd: 0.12,
        usage: { input_tokens: 100, output_tokens: 20 },
        permission_denials: []
      })
    ].join('\n')
    const parsed = parseClaudeStream(stdout)
    expect(parsed.finalText).toBe('最终结果')
    expect(parsed.sessionId).toBe(SESSION)
    expect(parsed.usage).toEqual({ costUsd: 0.12, inputTokens: 100, outputTokens: 20 })
    expect(parsed.error).toBeNull()
  })

  it('falls back to assistant text and reports an error result', () => {
    const parsed = parseClaudeStream(JSON.stringify({
      type: 'result', is_error: true, result: '认证失败', session_id: SESSION
    }))
    expect(parsed.finalText).toBe('认证失败')
    expect(parsed.error).toBe('认证失败')
  })

  it('reads Codex messages, thread id, usage and turn failures', () => {
    const stdout = [
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '第一段' } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '第二段' } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 50, output_tokens: 7 } })
    ].join('\n')
    const parsed = parseCodexStream(stdout)
    expect(parsed.sessionId).toBe('thread-1')
    expect(parsed.finalText).toBe('第一段\n\n第二段')
    expect(parsed.usage).toEqual({ costUsd: null, inputTokens: 50, outputTokens: 7 })
    expect(parsed.error).toBeNull()
    const failed = parseCodexStream([
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-2' }),
      JSON.stringify({ type: 'turn.failed', error: { message: '网络断开' } })
    ].join('\n'))
    expect(failed.error).toContain('网络断开')
  })

  it('turns streamed events into short progress lines', () => {
    expect(progressFromLine(JSON.stringify({
      type: 'item.completed', item: { type: 'agent_message', text: '正在检查测试' }
    }))).toBe('正在检查测试')
    expect(progressFromLine(JSON.stringify({
      type: 'item.started', item: { type: 'command_execution', command: 'npm test' }
    }))).toBe('运行：npm test')
    expect(progressFromLine('plain\x1b[31m output')).toBe('plain output')
  })
})
