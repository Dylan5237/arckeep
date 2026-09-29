import type { KnownRepo } from './repos.js'
import type { ToolAction } from './types.js'

export interface ToolFixtureShelf {
  page: 'tools'
  scene: 'shelf' | 'narrow'
  actions: ToolAction[]
  query?: string
}

export interface ToolFixtureParams {
  page: 'tools'
  scene: 'params'
  action: ToolAction
  values: Record<string, string>
  knownRepos: KnownRepo[]
}

export interface ToolFixturePreview {
  page: 'tools'
  scene: 'preview'
  action: ToolAction
  values: Record<string, string>
  previewText: string
  dryRun?: string
  cwd: string
  shellLabel: string
}

export interface ToolFixtureRun {
  page: 'tools'
  scene: 'running' | 'success' | 'failed' | 'aborted'
  title: string
  command: string
  lines: Array<{ stream: 'stdout' | 'stderr', text: string }>
  status: string
}

export interface ToolFixtureCopied {
  page: 'tools'
  scene: 'copied'
  title: string
  text: string
}

export interface ToolFixtureEmpty {
  page: 'tools'
  scene: 'empty'
}

export interface ToolFixtureInvalid {
  page: 'settings'
  scene: 'invalid'
  draft: string
  error: string
  line: number
}

export type ToolFixture =
  | ToolFixtureShelf
  | ToolFixtureParams
  | ToolFixturePreview
  | ToolFixtureRun
  | ToolFixtureCopied
  | ToolFixtureEmpty
  | ToolFixtureInvalid
