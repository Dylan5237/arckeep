import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const [sourcePath, packagePath, resultPath] = process.argv.slice(2)
if (!sourcePath || !packagePath || !resultPath) throw new Error('Usage: node verify-package.mjs <source-root> <package-dir> <result-json>')
const root = path.resolve(sourcePath)
const output = path.resolve(packagePath)
const require = createRequire(path.join(root, 'package.json'))
const { extractFile, listPackage } = require('@electron/asar')
const archive = path.join(output, 'win-unpacked/resources/app.asar')
const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
assert.equal(execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' }).trim(), '')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const packaged = JSON.parse(extractFile(archive, 'package.json').toString('utf8'))
assert.equal(packaged.version, pkg.version)
const entries = listPackage(archive)
const toolDependencyEntries = entries.filter(entry => /[/\\]node_modules[/\\](happy-dom|vitest|@vitest)([/\\]|$)/.test(entry))
assert.equal(toolDependencyEntries.length, 0)
const payload = entries.filter(entry => /^[/\\](out|schema)[/\\]/.test(entry) && fs.existsSync(path.join(root, entry.slice(1))) && fs.statSync(path.join(root, entry.slice(1))).isFile())
assert.ok(payload.some(entry => entry.replaceAll('\\', '/') === '/out/main/index.js'))
const files = payload.map(entry => {
  const name = entry.slice(1).replaceAll('\\', '/')
  const local = fs.readFileSync(path.join(root, name))
  const archived = extractFile(archive, entry.slice(1))
  assert.ok(local.equals(archived), `Archive differs from local build: ${name}`)
  return { name, bytes: archived.length, sha256: createHash('sha256').update(archived).digest('hex') }
})
function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name)
    return entry.isDirectory() ? walk(file) : [path.relative(root, file).replaceAll('\\', '/')]
  })
}
for (const name of [...walk(path.join(root, 'out')), ...walk(path.join(root, 'schema'))]) {
  assert.ok(files.some(file => file.name === name), `Local build file missing from archive: ${name}`)
}
const executable = path.join(output, 'win-unpacked/Arckeep.exe')
const probeEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
const versions = JSON.parse(execFileSync(executable, ['-e', 'process.stdout.write(JSON.stringify(process.versions))'], { env: probeEnv, encoding: 'utf8', timeout: 15000 }))
assert.equal(versions.electron, pkg.devDependencies.electron)
const manifest = JSON.parse(fs.readFileSync(path.join(output, 'package-manifest.json'), 'utf8'))
assert.equal(manifest.sourceRevision, sourceRevision)
assert.equal(manifest.applicationVersion, pkg.version)
for (const artifact of manifest.artifacts) {
  const bytes = fs.readFileSync(path.join(output, artifact.name))
  assert.equal(bytes.length, artifact.bytes)
  assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256)
}
const result = {
  sourceRevision,
  trackedSourceClean: true,
  applicationVersion: packaged.version,
  actualRuntimeVersions: versions,
  packagedFilesMatchLocalBuild: true,
  buildSourceBinding: 'Recorded build:app success on this clean committed source; archive byte comparison with its local out/schema payload. This is local technical provenance, not a remote reproducibility attestation.',
  toolDependencyEntries,
  inputs: [executable, archive].map(file => ({ path: file, sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') })),
  artifacts: manifest.artifacts,
  payload: files
}
fs.mkdirSync(path.dirname(path.resolve(resultPath)), { recursive: true })
fs.writeFileSync(resultPath, JSON.stringify(result, null, 2) + '\n', 'utf8')
console.log(JSON.stringify({ sourceRevision, applicationVersion: packaged.version, electron: versions.electron, matchedFiles: files.length, artifacts: manifest.artifacts.length }))
