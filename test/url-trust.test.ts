import { describe, expect, it } from 'vitest'
import { createUrlGuard, isTrustedAppUrl, type UrlTrustOptions } from '../src/main/url-trust.js'

const opts = {
  rendererRootFileUrl: 'file:///app/out/renderer/',
  devServerOrigin: null
}

describe('isTrustedAppUrl', () => {
  it('trusts renderer files under the app root', () => {
    expect(isTrustedAppUrl('file:///app/out/renderer/index.html', opts)).toBe(true)
  })

  it('trusts the dev server origin and follows a changed origin', () => {
    let origin = 'http://127.0.0.1:5173'
    const guard = createUrlGuard(() => ({ devServerOrigin: origin }))
    expect(guard('http://127.0.0.1:5173/index.html')).toBe(true)
    origin = 'http://127.0.0.1:5174'
    expect(guard('http://127.0.0.1:5173/index.html')).toBe(false)
    expect(guard('http://127.0.0.1:5174/')).toBe(true)
  })

  it('rejects a different local port and external urls', () => {
    expect(isTrustedAppUrl('http://127.0.0.1:5174/', { devServerOrigin: 'http://127.0.0.1:5173' })).toBe(false)
    expect(isTrustedAppUrl('https://evil.com/', opts)).toBe(false)
    expect(isTrustedAppUrl('http://127.0.0.1.evil.com/', { devServerOrigin: 'http://127.0.0.1:5173' })).toBe(false)
  })

  it('rejects file urls when no renderer root is configured', () => {
    expect(isTrustedAppUrl('file:///tmp/other.html', { devServerOrigin: 'http://127.0.0.1:5173' })).toBe(false)
  })

  it('returns false for malformed input', () => {
    expect(isTrustedAppUrl('not a url', opts)).toBe(false)
    expect(isTrustedAppUrl('', opts)).toBe(false)
  })

  it('requires getOptions to be a function', () => {
    expect(() => createUrlGuard(undefined as unknown as () => UrlTrustOptions)).toThrow(/getOptions/)
  })
})
