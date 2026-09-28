export interface UrlTrustOptions {
  /** Exact origin of the Vite dev server, for example http://127.0.0.1:5173 */
  devServerOrigin?: string | null
  /** file:// URL of the built renderer directory, with or without a trailing slash. */
  rendererRootFileUrl?: string | null
}

function directoryPrefix(fileUrl: string): string {
  return fileUrl.endsWith('/') ? fileUrl : `${fileUrl}/`
}

/**
 * Navigation and permission gate for the shell window.
 * Trusts only this app's renderer files, or the local Vite origin while developing.
 */
export function isTrustedAppUrl(value: string, options: UrlTrustOptions = {}): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }

  if (url.protocol === 'file:') {
    const root = options.rendererRootFileUrl
    if (!root) return false
    const prefix = directoryPrefix(root)
    return url.href === root || url.href.startsWith(prefix)
  }

  if (!options.devServerOrigin) return false
  try {
    return url.origin === new URL(options.devServerOrigin).origin
  } catch {
    return false
  }
}

export function createUrlGuard(getOptions: () => UrlTrustOptions): (value: string) => boolean {
  if (typeof getOptions !== 'function') {
    throw new TypeError('getOptions must be a function')
  }
  return value => isTrustedAppUrl(value, getOptions() || {})
}
