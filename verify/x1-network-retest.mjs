// verify/x1-network-retest.mjs
//
// Isolated, fresh-process retest of the "network unreachable" classification
// (X1). This is intentionally a SEPARATE script from smoke.mjs: the earlier
// combined-scene attempt reused a long-lived Electron process that had
// already made a successful connection to api.github.com, which could have
// let a keep-alive connection bypass a newly added firewall rule. This
// script cuts the network FIRST (program-level + IP-range + resolved-IP
// firewall rules) and only then cold-starts a brand-new Arckeep process, so
// the result is conclusive either way.
//
// Not part of the Arckeep product; read-only except for evidence files and
// the app's own %APPDATA%\Arckeep test data, and the temporary firewall
// rules it creates and removes around this one test.

import { _electron as electron } from 'playwright'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const EVIDENCE_DIR = process.env.ARCKEEP_EVIDENCE_DIR || 'evidence'
const UNPACKED_EXE = process.env.ARCKEEP_UNPACKED_EXE
const APPDATA = process.env.APPDATA
const ARCKEEP_DATA_DIR = path.join(APPDATA, 'Arckeep')
const FAKE_TOKEN = process.env.FAKE_TOKEN || 'ghp_Vf9QzXk2LmP4rT8wYb6nHc3JdA1sE7uG0oKi'

fs.mkdirSync(EVIDENCE_DIR, { recursive: true })

const result = { startedAt: new Date().toISOString(), steps: [] }
function step(name, data) {
  const entry = { name, at: new Date().toISOString(), ...data }
  result.steps.push(entry)
  console.log(`[x1-retest] ${name} :: ${JSON.stringify(data).slice(0, 400)}`)
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'x1-retest.json'), JSON.stringify(result, null, 2))
}

function ps(script) {
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8' })
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' }
}

function fullScreenShot(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const winPath = filePath.replace(/\//g, '\\')
  const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$bmp.Save('${winPath}', [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
`
  ps(script)
}

function killAll() {
  ps('Get-Process Arckeep -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue')
}

function cleanEnv(extra = {}) {
  const env = { ...process.env }
  delete env.GH_TOKEN
  delete env.GITHUB_TOKEN
  return { ...env, ...extra }
}

function netTest(label) {
  const r = ps("try { $t = Test-NetConnection api.github.com -Port 443 -WarningAction SilentlyContinue; [pscustomobject]@{ComputerName=$t.ComputerName;RemoteAddress=$t.RemoteAddress.ToString();RemotePort=$t.RemotePort;TcpTestSucceeded=$t.TcpTestSucceeded} | ConvertTo-Json -Compress } catch { \"error: $($_.Exception.Message)\" }")
  step(`nettest-${label}`, { raw: r.stdout.trim(), stderr: r.stderr.trim() })
  return r.stdout.trim()
}

async function main() {
  killAll()
  if (fs.existsSync(ARCKEEP_DATA_DIR)) fs.rmSync(ARCKEEP_DATA_DIR, { recursive: true, force: true })

  netTest('before-any-block')

  const dns = ps("try { [System.Net.Dns]::GetHostAddresses('api.github.com') | Select-Object -ExpandProperty IPAddressToString } catch { '' }")
  const ips = dns.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  step('dns-resolve', { ips, stderr: dns.stderr.trim() })

  const fwProgram = 'arckeep-x1-retest-program'
  const fwCidr = 'arckeep-x1-retest-cidr'
  const fwIps = 'arckeep-x1-retest-ips'
  const exeEscaped = UNPACKED_EXE.replace(/\\/g, '\\\\')

  const addProgram = ps(`New-NetFirewallRule -DisplayName '${fwProgram}' -Direction Outbound -Program '${exeEscaped}' -Action Block -ErrorAction Stop | Out-Null; Write-Output ok`)
  const addCidr = ps(`New-NetFirewallRule -DisplayName '${fwCidr}' -Direction Outbound -RemoteAddress 140.82.112.0/20 -RemotePort 443 -Protocol TCP -Action Block -ErrorAction Stop | Out-Null; Write-Output ok`)
  let addIps = { code: 0, stdout: 'skipped (no resolved ips)', stderr: '' }
  if (ips.length > 0) {
    const addrList = ips.map(ip => `'${ip}'`).join(',')
    addIps = ps(`New-NetFirewallRule -DisplayName '${fwIps}' -Direction Outbound -RemoteAddress ${addrList} -RemotePort 443 -Protocol TCP -Action Block -ErrorAction Stop | Out-Null; Write-Output ok`)
  }
  step('firewall-setup', {
    program: { ok: addProgram.code === 0 && addProgram.stdout.includes('ok'), stderr: addProgram.stderr.trim() },
    cidr: { ok: addCidr.code === 0 && addCidr.stdout.includes('ok'), stderr: addCidr.stderr.trim() },
    ips: { ok: addIps.code === 0 && addIps.stdout.includes('ok'), stderr: addIps.stderr.trim() }
  })

  const anyFirewallOk = (addProgram.code === 0 && addProgram.stdout.includes('ok'))
    || (addCidr.code === 0 && addCidr.stdout.includes('ok'))
    || (addIps.code === 0 && addIps.stdout.includes('ok'))

  try {
    const preLaunchNet = netTest('after-block-before-launch')

    if (!anyFirewallOk) {
      step('abort', { reason: 'no firewall rule could be created; likely missing admin rights on the runner' })
      fs.writeFileSync(path.join(EVIDENCE_DIR, 'x1-retest-verdict.txt'), 'BLOCKED: could not create any firewall rule (no admin rights?), retest not performed')
      return
    }

    const app = await electron.launch({
      executablePath: UNPACKED_EXE,
      env: cleanEnv({ ARCKEEP_TEST_HOOKS: '1' })
    })
    step('app-launched', { pid: app.process()?.pid ?? null })

    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.locator('#settings-button').click()
    await page.waitForTimeout(500)

    const tokenInput = page.locator('input[type="password"][aria-label="GitHub PAT"]')
    await tokenInput.fill(FAKE_TOKEN)
    const testButton = page.locator('button', { hasText: '测试连接' }).first()
    await testButton.click()

    let message = null
    let timedOut = false
    try {
      await page.waitForSelector('.alert.error', { timeout: 30000 })
      message = await page.locator('.alert.error').innerText()
    } catch {
      timedOut = true
    }

    const remaining = await tokenInput.inputValue()
    fullScreenShot(path.join(EVIDENCE_DIR, '11-settings-network-error-retest.png'))
    try {
      await page.screenshot({ path: path.join(EVIDENCE_DIR, '11-settings-network-error-retest-win.png') })
    } catch { /* window may not be capturable in edge cases; fullscreen shot still stands */ }

    const postClickNet = netTest('after-click-test-connection')

    const isNetworkClassMessage = message
      ? (message.includes('连不上 GitHub') || message.includes('网络不可达'))
      : false

    step('result', {
      message,
      timedOut,
      tokenKeptInField: remaining === FAKE_TOKEN,
      isNetworkClassMessage,
      preLaunchNetBlocked: preLaunchNet.includes('"TcpTestSucceeded":false') || preLaunchNet.includes('False'),
      postClickNetBlocked: postClickNet.includes('"TcpTestSucceeded":false') || postClickNet.includes('False')
    })

    const verdictLines = [
      `message: ${message ?? '(none, waitForSelector timed out)'}`,
      `isNetworkClassMessage: ${isNetworkClassMessage}`,
      `tokenKeptInField: ${remaining === FAKE_TOKEN}`,
      `preLaunchNetTest: ${preLaunchNet}`,
      `postClickNetTest: ${postClickNet}`
    ]
    if (isNetworkClassMessage) {
      verdictLines.unshift('PASS: fresh-process retest correctly showed a network-unreachable class message.')
    } else if (message) {
      verdictLines.unshift('FAIL (product defect, pending engineering confirmation): fresh-process retest still did NOT show a network-unreachable class message, despite Test-NetConnection evidence below confirming the network was cut.')
    } else {
      verdictLines.unshift('INCONCLUSIVE: no .alert.error appeared within 30s (waitForSelector timed out).')
    }
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'x1-retest-verdict.txt'), verdictLines.join('\n'))

    await app.evaluate(() => { globalThis.__ARCKEEP_TEST_HOOKS__?.quit() }).catch(() => {})
    await new Promise(r => setTimeout(r, 1200))
  } finally {
    ps(`Remove-NetFirewallRule -DisplayName '${fwProgram}' -ErrorAction SilentlyContinue`)
    ps(`Remove-NetFirewallRule -DisplayName '${fwCidr}' -ErrorAction SilentlyContinue`)
    ps(`Remove-NetFirewallRule -DisplayName '${fwIps}' -ErrorAction SilentlyContinue`)
    killAll()
    netTest('after-cleanup')
  }
}

main().catch(error => {
  step('fatal', { error: error instanceof Error ? error.stack : String(error) })
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'x1-retest-verdict.txt'), `FATAL: ${error instanceof Error ? error.message : String(error)}`)
})
