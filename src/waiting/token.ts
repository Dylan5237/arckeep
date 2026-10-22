import { createHash } from 'node:crypto'
import { readGhAuthToken, type GhLookup } from '../main/github-auth.js'
import { abortable, throwIfCancelled, type TaskScope } from '../shared/task-scope.js'

export type WaitingTokenVia = 'gh' | 'env' | 'saved' | 'none'

export function waitingTokenIdentityHash(access: { token: string | null, via: WaitingTokenVia }): string | null {
  if (!access.token) return null
  const credentialFingerprint = createHash('sha256').update(access.token).digest('hex')
  return createHash('sha256')
    .update(JSON.stringify({ via: access.via, credentialFingerprint }))
    .digest('hex')
}

export async function resolveWaitingToken(options: {
  readGh?: (options?: { signal?: AbortSignal, tasks?: TaskScope }) => Promise<GhLookup>
  envToken?: string | null
  readSaved?: () => string | null
  signal?: AbortSignal
  tasks?: TaskScope
}): Promise<{ token: string | null, via: WaitingTokenVia }> {
  throwIfCancelled(options.signal)
  const readGh = options.readGh
    ? options.readGh({ signal: options.signal, tasks: options.tasks })
    : readGhAuthToken(undefined, undefined, { signal: options.signal, tasks: options.tasks })
  const gh = await abortable(readGh, options.signal)
  throwIfCancelled(options.signal)
  if (gh.ok) return { token: gh.token, via: 'gh' }
  const envToken = (options.envToken ?? '').trim()
  if (envToken && !/\s/.test(envToken)) return { token: envToken, via: 'env' }
  throwIfCancelled(options.signal)
  const saved = options.readSaved?.() ?? null
  throwIfCancelled(options.signal)
  if (saved) return { token: saved, via: 'saved' }
  return { token: null, via: 'none' }
}
