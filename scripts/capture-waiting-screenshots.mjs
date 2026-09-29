#!/usr/bin/env node
// Renders mocked「等我处理」windows. Does not call gh or GitHub.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(root, 'docs/screenshots/pr-2')
const electron = path.join(root, 'node_modules/electron/dist/electron')
const forbidden = ['ghp_', 'github_pat_', 'zzfakeexpiredpatvalue', 'zzmockgithubcredential']

const scenes = [
  ['waiting', 'waiting-populated.png'],
  ['waiting-empty', 'waiting-empty.png'],
  ['waiting-no-token', 'waiting-no-token.png'],
  ['waiting-invalid-token', 'waiting-invalid-token.png'],
  ['waiting-loading', 'waiting-loading.png'],
  ['waiting-rate-limit', 'waiting-rate-limit.png'],
  ['waiting-narrow', 'waiting-narrow.png'],
  ['waiting-hover', 'waiting-hover.png'],
  ['waiting-ignore', 'waiting-ignore.png'],
  ['waiting-watch', 'waiting-watch.png'],
  ['waiting-hidden', 'waiting-hidden.png'],
  ['waiting-family', 'waiting-family.png']
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
