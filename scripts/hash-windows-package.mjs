import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const output = path.resolve(process.argv[2] ?? 'dist')
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' }).trim()
if (dirty) throw new Error('Commit tracked source changes before binding release artifacts to a source revision')
const tag = process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : null
if (tag && tag !== `v${pkg.version}`) throw new Error(`Release tag ${tag} does not match application version ${pkg.version}`)

const artifacts = [`${pkg.productName}-Setup-${pkg.version}.exe`, `${pkg.productName}-${pkg.version}-portable.exe`].map(name => {
  const bytes = readFileSync(path.join(output, name))
  return { name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
})
writeFileSync(path.join(output, 'SHA256SUMS.txt'), artifacts.map(file => `${file.sha256}  ${file.name}\n`).join(''), 'utf8')
writeFileSync(path.join(output, 'package-manifest.json'), `${JSON.stringify({
  applicationVersion: pkg.version,
  configuredElectronVersion: pkg.devDependencies.electron,
  sourceRevision,
  tag,
  artifacts
}, null, 2)}\n`, 'utf8')
console.log(`Bound ${artifacts.length} Windows artifacts to ${sourceRevision}`)
