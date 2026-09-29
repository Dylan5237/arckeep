import type { ToolAction } from './types.js'

export interface ToolFixtureShelf {
  page: 'tools'
  scene: 'shelf' | 'narrow'
  actions: ToolAction[]
}

export interface ToolFixtureParams {
  page: 'tools'
  scene: 'params'
  action: ToolAction
  values: Record<string, string>
}

export interface ToolFixturePreview {
  page: 'tools'
  scene: 'preview'
  action: ToolAction
  previewText: string
  cwd: string
  shellLabel: string
}

export interface ToolFixtureRun {
  page: 'tools'
  scene: 'running' | 'exit' | 'aborted'
  title: string
  command: string
  lines: Array<{ stream: 'stdout' | 'stderr', text: string }>
  status: string
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
}

export type ToolFixture =
  | ToolFixtureShelf
  | ToolFixtureParams
  | ToolFixturePreview
  | ToolFixtureRun
  | ToolFixtureEmpty
  | ToolFixtureInvalid
