import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const [sourcePath, evidencePath] = process.argv.slice(2)
if (!sourcePath || !evidencePath) throw new Error('Usage: node github-live-probe.mjs <source-root> <evidence-dir>')
const root = path.resolve(sourcePath)
const output = path.resolve(evidencePath)
const profile = fs.mkdtempSync(path.join(output, 'profile-live-'))
const { defaultSettings, saveSettings } = await import(pathToFileURL(path.join(root, 'out/main/settings-store.js')).href)
const { readGhAuthToken } = await import(pathToFileURL(path.join(root, 'out/main/github-auth.js')).href)
const { runCli } = await import(pathToFileURL(path.join(root, 'out/waiting/cli.js')).href)
const settings = defaultSettings()
settings.watchedRepos = ['Dylan5237/arckeep']
settings.waiting.sources = Object.fromEntries(Object.keys(settings.waiting.sources).map(key => [key, key === 'github']))
saveSettings(path.join(profile, 'Arckeep/settings.json'), settings)
const lookup = await readGhAuthToken()
assert.equal(lookup.ok, true, 'Existing gh login is required; this probe never saves a token')
let stdout = ''
const diagnostics = []
const exitCode = await runCli(['--json'], {
  env: { ...process.env, APPDATA: profile },
  readGh: async () => lookup,
  stdout: text => { stdout += text },
  stderr: text => { diagnostics.push(text) }
})
assert.equal(exitCode, 0)
assert.equal(diagnostics.length, 0, 'Read-only collection reported an error')
const data = JSON.parse(stdout)
const result = {
  sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  entry: 'Compiled waiting CLI, fresh settings/profile, existing gh login reused in memory; no GUI or clean-Windows claim',
  queriedRepos: settings.watchedRepos,
  profile,
  diagnostics,
  data
}
fs.writeFileSync(path.join(output, 'github-live-results.json'), JSON.stringify(result, null, 2) + '\n', 'utf8')
console.log(JSON.stringify({ sourceRevision: result.sourceRevision, queriedRepos: result.queriedRepos, diagnostics: diagnostics.length, observedItems: Array.isArray(data) ? data.length : Object.keys(data) }))
