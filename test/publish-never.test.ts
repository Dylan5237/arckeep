import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)))

/**
 * A segment that launches electron-builder. Mentions in log text
 * ("请检查上方 electron-builder 输出") are not commands.
 */
const ELECTRON_BUILDER_COMMAND = /(?:^|[\n;&|`(]|npx\s+|npm\s+exec\s+)(?:\S*[/\\])?electron-builder(?=\s|$)/

function commandSegments(source: string): string[] {
  const withoutBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, '')
  const withoutLineComments = withoutBlockComments
    .split(/\r?\n/)
    .map(line => line.replace(/(^|[^:\\])\/\/.*$/, '$1').replace(/^\s*#.*$/, ''))
    .join('\n')
  return withoutLineComments
    .split(/&&|[;\n]/)
    .map(segment => segment.trim())
    .filter(Boolean)
}

function scannedSources(): Array<{ name: string; text: string }> {
  const found: Array<{ name: string; text: string }> = []
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>
  }
  for (const [name, command] of Object.entries(pkg.scripts)) {
    found.push({ name: `package.json scripts.${name}`, text: command })
  }

  const workflowDir = path.join(root, '.github', 'workflows')
  for (const file of readdirSync(workflowDir)) {
    if (!file.endsWith('.yml') && !file.endsWith('.yaml')) continue
    found.push({
      name: `.github/workflows/${file}`,
      text: readFileSync(path.join(workflowDir, file), 'utf8')
    })
  }

  const scriptsDir = path.join(root, 'scripts')
  for (const file of readdirSync(scriptsDir)) {
    if (!file.endsWith('.mjs') && !file.endsWith('.js') && !file.endsWith('.cjs')) continue
    found.push({
      name: `scripts/${file}`,
      text: readFileSync(path.join(scriptsDir, file), 'utf8')
    })
  }
  return found
}

describe('electron-builder publish policy', () => {
  it('passes --publish never on every electron-builder invocation', () => {
    const invocations = scannedSources().flatMap(({ name, text }) =>
      commandSegments(text)
        .filter(segment => ELECTRON_BUILDER_COMMAND.test(segment))
        .map(segment => `${name}: ${segment}`)
    )
    expect(invocations.length).toBeGreaterThan(0)
    const missing = invocations.filter(segment => !segment.includes('--publish never'))
    expect(missing).toEqual([])
  })

  it('runs the windows package job with push-style CI detection', () => {
    const ci = readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8')
    const step = ci.split('- name: Build NSIS installer and portable exe')[1]?.split('\n      - name:')[0] ?? ''
    expect(step).toContain('Remove-Item Env:\\GITHUB_BASE_REF')
    expect(step).toContain('npm run dist')
  })
})
