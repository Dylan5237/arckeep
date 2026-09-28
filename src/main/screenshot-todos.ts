import type { ScreenshotScene } from './screenshot-scene.js'

const REPOS: Array<string | null> = [
  'Dylan5237/arckeep',
  'example/demo',
  'octocat/hello-world',
  'Dylan5237/notes',
  null
]

export function screenshotSeedsTodos(scene: ScreenshotScene): boolean {
  return scene === 'todos' || scene === 'todos-filter' || scene === 'todos-delete' || scene === 'todos-narrow'
}

export function screenshotCaptureFixture(scene: ScreenshotScene): 'filled' | null {
  return scene === 'capture-filled' ? 'filled' : null
}

export function screenshotCapturesCaptureWindow(scene: ScreenshotScene): boolean {
  return scene === 'capture-empty' || scene === 'capture-filled'
}

/** Forty synthetic todos. The first twelve stay incomplete. */
export function screenshotTodoLog(now = new Date()): string {
  const lines: string[] = []
  for (let index = 0; index < 40; index += 1) {
    const repo = REPOS[index % REPOS.length] ?? null
    const id = `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
    const createdAt = new Date(now.getTime() - (index + 1) * 6 * 60 * 60 * 1000).toISOString()
    const waiting = index % 5 === 0 || index % 5 === 1
    lines.push(JSON.stringify({
      op: 'create',
      record: {
        id,
        text: screenshotTodoText(index, repo),
        repo,
        waiting,
        createdAt
      }
    }))
    if (index >= 12) {
      lines.push(JSON.stringify({ op: 'complete', id, at: createdAt }))
    }
  }
  return `${lines.join('\n')}\n`
}

function screenshotTodoText(index: number, repo: string | null): string {
  const label = String(index + 1).padStart(2, '0')
  if (repo === 'example/demo') return `示例仓库待办 ${label}`
  if (repo === null) return `未标仓库的待办 ${label}`
  const name = repo.slice(repo.indexOf('/') + 1)
  return `${name} 合成待办 ${label}`
}
