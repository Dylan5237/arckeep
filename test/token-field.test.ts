import { describe, expect, it } from 'vitest'
import { pastedTokenAfterAttempt } from '../src/shared/token-field.js'

describe('pasted token field', () => {
  it('keeps the pasted value after a failed attempt and clears it after success', () => {
    expect(pastedTokenAfterAttempt('ghp_example', false)).toBe('ghp_example')
    expect(pastedTokenAfterAttempt('ghp_example', true)).toBe('')
  })
})
