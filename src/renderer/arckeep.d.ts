import type { ArckeepApi } from '../shared/types'

declare global {
  const __ARCKEEP_VERSION__: string

  interface Window {
    arckeep: ArckeepApi
  }
}

export {}
