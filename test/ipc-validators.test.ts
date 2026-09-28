import { describe, expect, it } from 'vitest'
import { normalizePat, normalizeWatchedRepos, requireSender } from '../src/main/ipc-validators.js'

describe('requireSender', () => {
  it('passes when the sender matches the expected webContents', () => {
    expect(() => requireSender({ sender: { id: 7 } }, { id: 7 })).not.toThrow()
  })

  it('blocks a mismatched or missing renderer', () => {
    expect(() => requireSender({ sender: { id: 7 } }, { id: 9 })).toThrow(/unexpected renderer/)
    expect(() => requireSender({ sender: { id: 7 } }, null)).toThrow(/unexpected renderer/)
  })
})

describe('normalizeWatchedRepos', () => {
  it('trims, drops blanks, and dedupes owner/repo entries', () => {
    expect(normalizeWatchedRepos([' Dylan5237/arckeep ', '', 'Dylan5237/arckeep', 'octocat/hello'])).toEqual([
      'Dylan5237/arckeep',
      'octocat/hello'
    ])
  })

  it('rejects invalid shapes', () => {
    expect(() => normalizeWatchedRepos('Dylan5237/arckeep')).toThrow(/关注仓库列表无效/)
    expect(() => normalizeWatchedRepos(['not a repo'])).toThrow(/owner\/repo/)
    expect(() => normalizeWatchedRepos(Array.from({ length: 201 }, () => 'a/b'))).toThrow(/过多/)
  })
})

describe('normalizePat', () => {
  it('trims a token', () => {
    expect(normalizePat('  ghp_exampletoken  ')).toBe('ghp_exampletoken')
  })

  it('rejects empty, whitespace, and oversized tokens', () => {
    expect(() => normalizePat('   ')).toThrow(/不能为空/)
    expect(() => normalizePat('ghp_token with space')).toThrow(/空白/)
    expect(() => normalizePat('x'.repeat(513))).toThrow(/过长/)
    expect(() => normalizePat(12)).toThrow(/PAT 无效/)
  })
})
