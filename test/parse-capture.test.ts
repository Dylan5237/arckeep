import { describe, expect, it } from 'vitest'
import { parseCaptureShorthand, resolveRepoToken } from '../src/shared/todos/parse-capture.js'
import { normalizeTodoInput } from '../src/shared/todos/validate.js'

const known = ['Dylan5237/arckeep', 'example/demo', 'a/notes', 'b/notes']

describe('parseCaptureShorthand', () => {
  it('saves plain text as a normal todo', () => {
    expect(parseCaptureShorthand({
      text: '  记一件普通的事  ',
      repoField: '',
      waitingField: false,
      knownRepos: known
    })).toEqual({ text: '记一件普通的事', repo: null, waiting: false })
  })

  it('strips a full #owner/repo and canonicalizes known casing', () => {
    expect(parseCaptureShorthand({
      text: '跟进 #EXAMPLE/demo 今晚',
      repoField: '',
      waitingField: false,
      knownRepos: known
    })).toEqual({ text: '跟进 今晚', repo: 'example/demo', waiting: false })
  })

  it('accepts a full owner/repo that is not in the known list', () => {
    expect(parseCaptureShorthand({
      text: '修 #octocat/hello-world',
      repoField: '',
      waitingField: false,
      knownRepos: known
    })).toEqual({ text: '修', repo: 'octocat/hello-world', waiting: false })
  })

  it('matches a unique #repo short name without caring about case', () => {
    expect(parseCaptureShorthand({
      text: '看看 #Arckeep',
      repoField: '',
      waitingField: false,
      knownRepos: known
    })).toEqual({ text: '看看', repo: 'Dylan5237/arckeep', waiting: false })
  })

  it('leaves an unknown or ambiguous short name in the text', () => {
    expect(parseCaptureShorthand({
      text: '看看 #nope',
      repoField: '',
      waitingField: false,
      knownRepos: known
    })).toEqual({ text: '看看 #nope', repo: null, waiting: false })
    expect(parseCaptureShorthand({
      text: '看看 #notes',
      repoField: '',
      waitingField: false,
      knownRepos: known
    })).toEqual({ text: '看看 #notes', repo: null, waiting: false })
    expect(resolveRepoToken('notes', known)).toBeNull()
    expect(resolveRepoToken('a/b/c', known)).toBeNull()
  })

  it('sets 等我 from !等我 and from the checkbox', () => {
    expect(parseCaptureShorthand({
      text: '这件 !等我 先放着',
      repoField: '',
      waitingField: false,
      knownRepos: known
    })).toEqual({ text: '这件 先放着', repo: null, waiting: true })
    expect(parseCaptureShorthand({
      text: '普通的一句',
      repoField: '',
      waitingField: true,
      knownRepos: []
    }).waiting).toBe(true)
  })

  it('lets shorthand win, and never blocks on a repo field that does not resolve', () => {
    const parsed = parseCaptureShorthand({
      text: '写完 #demo',
      repoField: 'not a repo',
      waitingField: false,
      knownRepos: known
    })
    expect(parsed).toEqual({ text: '写完', repo: 'example/demo', waiting: false })
    expect(normalizeTodoInput(parsed)).toEqual({
      text: '写完',
      repo: 'example/demo',
      waiting: false
    })

    const ignored = parseCaptureShorthand({
      text: '仍然记下',
      repoField: 'nope',
      waitingField: false,
      knownRepos: known
    })
    expect(ignored).toEqual({ text: '仍然记下', repo: null, waiting: false })
    expect(normalizeTodoInput({ ...ignored, repo: ignored.repo })).toEqual({
      text: '仍然记下',
      repo: null,
      waiting: false
    })
  })

  it('uses the repo field when the text does not name one', () => {
    expect(parseCaptureShorthand({
      text: '只写在输入框',
      repoField: ' DEMO ',
      waitingField: false,
      knownRepos: known
    })).toEqual({ text: '只写在输入框', repo: 'example/demo', waiting: false })
    expect(parseCaptureShorthand({
      text: '手打全名',
      repoField: 'octocat/hello-world',
      waitingField: false,
      knownRepos: known
    }).repo).toBe('octocat/hello-world')
  })
})
