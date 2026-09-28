#!/usr/bin/env node
// Rebuild Arckeep Windows artifacts (NSIS installer + portable exe).
// Default: test -> clean dist/ -> electron-builder.
// The package step draws its own progress line so a quiet electron-builder is not treated as a hang.
// Usage:
//   npm run pack                  # full flow (test + clean + package)
//   npm run pack -- fast          # unpacked dir only, skip tests
//   npm run pack -- --no-test
//   npm run pack -- --no-clean
import { execSync, spawn } from 'node:child_process'
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'

if (!process.env.CI) {
  process.env.npm_config_registry ??= 'https://registry.npmmirror.com'
  process.env.ELECTRON_MIRROR ??= 'https://npmmirror.com/mirrors/electron/'
  process.env.ELECTRON_BUILDER_BINARIES_MIRROR ??= 'https://npmmirror.com/mirrors/electron-builder-binaries/'
}

const flags = process.argv.slice(2)
const fastMode = flags.includes('fast') || flags.includes('--fast')
const showHelp = flags.includes('--help') || flags.includes('-h')
const skipTest = fastMode || flags.includes('--no-test')
const skipClean = flags.includes('--no-clean')

if (showHelp) {
  console.log(`Arckeep pack

Usage:
  npm run pack                  Full Windows build: test, clean dist, NSIS installer + portable exe
  npm run pack -- fast          Fast unpacked build: clean dist-fast, skip tests
  npm run pack -- --no-test     Full NSIS + portable build without tests
  npm run pack -- --no-clean    Keep the selected output directory before build`)
  process.exit(0)
}

function run(command, label) {
  console.log(`\n▶ ${label}`)
  execSync(command, { stdio: 'inherit' })
}

const PHASES = [
  [/electron-builder\s+version/i, 5, '启动 electron-builder'],
  [/loaded configuration/i, 10, '加载配置'],
  [/executing @electron\/rebuild/i, 18, '重建原生依赖'],
  [/installing native dependencies/i, 25, '安装原生依赖'],
  [/completed installing native dependencies/i, 32, '原生依赖就绪'],
  [/\bpackaging\b/i, 45, '打包 asar'],
  [/updating asar/i, 50, '更新 asar 校验'],
  [/building.*target=nsis/i, 70, '生成 NSIS 安装包'],
  [/building.*target=portable/i, 85, '生成 portable exe']
]

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const BAR_WIDTH = 22

function runWithProgress(command, label) {
  return new Promise((resolve, reject) => {
    console.log(`\n▶ ${label}`)
    const child = spawn(command, [], { shell: true })
    const start = Date.now()
    let frame = 0
    let percent = 0
    let phase = '准备中'
    let stdoutClosed = false

    function safeWrite(text) {
      if (stdoutClosed) return
      try {
        process.stdout.write(text)
      } catch {
        stdoutClosed = true
      }
    }

    function redraw() {
      const sec = Math.floor((Date.now() - start) / 1000)
      const mm = String(Math.floor(sec / 60)).padStart(2, '0')
      const ss = String(sec % 60).padStart(2, '0')
      const filled = Math.round((percent / 100) * BAR_WIDTH)
      const bar = '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled)
      safeWrite(`\r\x1b[K${SPINNER[frame]} ${bar} ${String(percent).padStart(3)}%  ${mm}:${ss}  ${phase}`)
      frame = (frame + 1) % SPINNER.length
    }
    const timer = setInterval(redraw, 700)
    if (!stdoutClosed) redraw()

    function onLine(raw) {
      const line = raw.replace(/\r$/, '')
      for (const [re, pct, name] of PHASES) {
        if (re.test(line)) {
          percent = Math.max(percent, pct)
          phase = name
        }
      }
      safeWrite(`\r\x1b[K${line}\n`)
    }

    function drain(buf, handler) {
      let next = buf
      let index
      while ((index = next.indexOf('\n')) >= 0) {
        handler(next.slice(0, index))
        next = next.slice(index + 1)
      }
      return next
    }

    let outBuf = ''
    let errBuf = ''
    child.stdout.on('data', chunk => { outBuf = drain(outBuf + chunk.toString(), onLine) })
    child.stderr.on('data', chunk => { errBuf = drain(errBuf + chunk.toString(), onLine) })
    child.on('error', error => {
      clearInterval(timer)
      safeWrite('\r\x1b[K')
      reject(error)
    })
    child.on('exit', code => {
      if (outBuf.trim()) onLine(outBuf)
      if (errBuf.trim()) onLine(errBuf)
      clearInterval(timer)
      safeWrite('\r\x1b[K')
      if (code === 0) resolve()
      else reject(new Error(`${command} 退出码 ${code}`))
    })
  })
}

async function cleanDist(dir) {
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
      const retryable = ['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(code)
      if (!retryable || attempt >= 2) {
        throw retryable
          ? new Error('dist/ 被占用, 请先关闭运行中的 Arckeep 后重试')
          : error
      }
      console.log(`\n⚠  dist/ 被占用(${code}), 1s 后重试...`)
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
  }
}

function findFile(dir, predicate) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isFile() && predicate(entry.name)) return full
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const found = findFile(path.join(dir, entry.name), predicate)
    if (found) return found
  }
  return null
}

async function main() {
  if (skipTest) {
    console.log(fastMode ? '\n⚡ 快速模式跳过测试' : '\n⏭  跳过测试(--no-test)')
  } else {
    run('npm test', '运行测试(失败则中止打包)')
  }

  const outputName = fastMode ? 'dist-fast' : 'dist'
  const distDir = path.resolve(outputName)
  if (skipClean) {
    console.log(`\n⏭  跳过清理 ${outputName}/ (--no-clean)`)
  } else if (existsSync(distDir)) {
    console.log(`\n▶ 清理旧产物 ${outputName}/`)
    await cleanDist(distDir)
  }

  const buildCommand = fastMode
    ? `npm run build -- --config.directories.output=${outputName}`
    : 'npm run dist'
  const buildLabel = fastMode
    ? '快速生成 unpacked 应用(跳过安装包)'
    : '打包 NSIS 安装包和 portable exe'
  await runWithProgress(buildCommand, buildLabel)

  if (!existsSync(distDir)) {
    console.log(`\n✗ 未找到 ${outputName}/`)
    process.exit(1)
  }

  if (fastMode) {
    const appExe = findFile(distDir, name => name.toLowerCase().endsWith('.exe'))
    if (!appExe) {
      console.log(`\n✗ 未在 ${outputName}/ 找到 exe，请检查上方 electron-builder 输出`)
      process.exit(1)
    }
    const mb = (statSync(appExe).size / 1024 / 1024).toFixed(1)
    console.log(`\n✓ 快速构建完成: ${path.relative(process.cwd(), appExe)}  (${mb} MB)`)
    return
  }

  const setup = findFile(distDir, name => /setup/i.test(name) && name.toLowerCase().endsWith('.exe'))
  const portable = findFile(distDir, name => /portable/i.test(name) && name.toLowerCase().endsWith('.exe'))
  if (!setup || !portable) {
    console.log('\n✗ 未找到 NSIS 安装包（*Setup*.exe）和 portable exe，请检查上方 electron-builder 输出')
    process.exit(1)
  }
  for (const artifact of [setup, portable]) {
    const mb = (statSync(artifact).size / 1024 / 1024).toFixed(1)
    console.log(`✓ ${path.relative(process.cwd(), artifact)}  (${mb} MB)`)
  }
}

main().catch(error => {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
