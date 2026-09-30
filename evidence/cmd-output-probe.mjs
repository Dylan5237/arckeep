import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const [sourcePath, evidencePath] = process.argv.slice(2)
const root = path.resolve(sourcePath)
const output = path.resolve(evidencePath)
fs.mkdirSync(output, { recursive: true })
const profile = fs.mkdtempSync(path.join(output, 'profile-cmd-'))
const { planShell } = await import(pathToFileURL(path.join(root, 'out/main/tool-launch.js')).href)
const { runPlan } = await import(pathToFileURL(path.join(root, 'out/main/tool-runner.js')).href)
const command = 'echo 中文stdout & echo 中文stderr 1>&2'
const result = await runPlan(planShell('cmd', command), profile)
fs.writeFileSync(path.join(output, 'cmd-output-results.json'), JSON.stringify({ command, result, scope: 'Actual cmd built-in output, separate from Node UTF-8 native-output tests' }, null, 2) + '\n')
console.log(JSON.stringify(result))
assert.equal(result.code, 0)
assert.ok(result.stdout.includes('中文stdout'))
assert.ok(result.stderr.includes('中文stderr'))
