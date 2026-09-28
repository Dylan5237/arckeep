import type { ArckeepApi } from '../shared/types'

declare global {
  interface Window {
    arckeep: ArckeepApi
  }
}

export {}
