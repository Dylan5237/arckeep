import { readGhAuthToken, type GhLookup } from '../main/github-auth.js'

export type WaitingTokenVia = 'gh' | 'env' | 'saved' | 'none'

export async function resolveWaitingToken(options: {
  readGh?: () => Promise<GhLookup>
  envToken?: string | null
  readSaved?: () => string | null
}): Promise<{ token: string | null, via: WaitingTokenVia }> {
  const gh = await (options.readGh ?? readGhAuthToken)()
  if (gh.ok) return { token: gh.token, via: 'gh' }
  const envToken = (options.envToken ?? '').trim()
  if (envToken && !/\s/.test(envToken)) return { token: envToken, via: 'env' }
  const saved = options.readSaved?.() ?? null
  if (saved) return { token: saved, via: 'saved' }
  return { token: null, via: 'none' }
}
