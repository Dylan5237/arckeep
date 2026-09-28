#!/usr/bin/env node
// Renders mocked「项目总览」windows. Does not call gh or GitHub.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(root, 'docs/screenshots/pr-3')
const electron = path.join(root, 'node_modules/electron/dist/electron')
const forbidden = ['ghp_', 'github_pat_', 'zzfakeexpiredpatvalue', 'zzmockgithubcredential']

const scenes = [
  ['overview', 'overview-populated.png'],
  ['overview-collapsed', 'overview-collapsed.png'],
  ['overview-archived', 'overview-archived.png'],
  ['overview-empty', 'overview-empty.png'],
  ['overview-no-token', 'overview-no-token.png'],
  ['overview-invalid-token', 'overview-unauthorized.png'],
  ['overview-loading', 'overview-loading.png'],
  ['overview-row-error', 'overview-row-error.png'],
  ['overview-narrow', 'overview-narrow.png']
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
