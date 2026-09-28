#!/usr/bin/env node
// Renders mocked todo and capture windows. Synthetic data only; no GitHub calls.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(root, 'docs/screenshots/pr-4')
const electron = path.join(root, 'node_modules/electron/dist/electron')
const forbidden = ['ghp_', 'github_pat_', 'zzfakeexpiredpatvalue', 'zzmockgithubcredential']

const scenes = [
  ['capture-empty', 'capture-empty.png'],
  ['capture-opened', 'capture-opened.png'],
  ['capture-filled', 'capture-filled.png'],
  ['capture-draft', 'capture-draft.png'],
  ['capture-saved', 'capture-saved.png'],
  ['todos', 'todos-populated.png'],
  ['todos-empty', 'todos-empty.png'],
  ['todos-filter', 'todos-filter.png'],
  ['todos-delete', 'todos-delete.png'],
  ['todos-narrow', 'todos-narrow.png']
]

for (const [scene, filename] of scenes) {
  const output = path.join(outDir, filename)
  console.log(`\n▶ ${scene} -> ${filename}`)
  const result = spawnSync(electron, ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '.'], {
    cwd: root,
    env: {
      ...process.env,
      ARCKEEP_SCREENSHOT: output,
      ARCKEEP_SCREENSHOT_SCENE: scene
    },
    stdio: 'inherit'
  })
  if (result.status !== 0) {
    console.error(`scene ${scene} exited ${result.status}`)
    process.exit(result.status ?? 1)
  }
  const bytes = readFileSync(output)
  const text = bytes.toString('latin1')
  for (const secret of forbidden) {
    if (text.includes(secret)) {
      console.error(`${filename} contains forbidden fixture text: ${secret}`)
      process.exit(1)
    }
  }
}

console.log(`\n✓ wrote ${scenes.length} screenshots to ${path.relative(root, outDir)}`)
