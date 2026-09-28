# verify/run-all.ps1
#
# Orchestrates the Windows smoke verification for Arckeep Issue #1 / PR #8
# (fef78d5). Not part of the Arckeep product; read-only except for files it
# writes under `evidence/` and the app's own %APPDATA%\Arckeep test data.

param(
  [string]$ArtifactDir = "artifact",
  [string]$EvidenceDir = "evidence"
)

$ErrorActionPreference = 'Continue'
New-Item -ItemType Directory -Force -Path $EvidenceDir | Out-Null

function Save-FullScreen([string]$Path) {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
  $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}

function Write-Section([string]$Name, [scriptblock]$Body) {
  Write-Host "===== $Name ====="
  try {
    & $Body
    Write-Host "----- $Name OK -----"
  } catch {
    Write-Host "----- $Name FAILED: $($_.Exception.Message) -----"
    "$Name FAILED: $($_.Exception.Message)`n$($_.ScriptStackTrace)" | Out-File -Append (Join-Path $EvidenceDir 'run-all-errors.txt')
  }
}

$setupExe = Get-ChildItem -Path $ArtifactDir -Recurse -Filter '*.exe' | Where-Object { $_.Name -like '*Setup*' } | Select-Object -First 1
$portableExe = Get-ChildItem -Path $ArtifactDir -Recurse -Filter '*.exe' | Where-Object { $_.Name -like '*portable*' } | Select-Object -First 1
$unpackedExe = Get-ChildItem -Path $ArtifactDir -Recurse -Filter 'Arckeep.exe' | Where-Object { $_.FullName -like '*win-unpacked*' } | Select-Object -First 1

"setupExe=$($setupExe.FullName)`nportableExe=$($portableExe.FullName)`nunpackedExe=$($unpackedExe.FullName)" |
  Out-File (Join-Path $EvidenceDir '01a-resolved-paths.txt')

if (-not $unpackedExe) { throw "win-unpacked/Arckeep.exe not found under $ArtifactDir; cannot continue" }

# -----------------------------------------------------------------
# AC3: portable exe "double-click" smoke (CI proxy; final PASS needs Dylan
# on a clean Win10/11 box per the product-manager decision).
# -----------------------------------------------------------------
Write-Section 'AC3-portable' {
  if (-not $portableExe) { throw 'portable exe missing from arckeep-windows artifact' }
  Get-Process Arckeep -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 300
  $proc = Start-Process -FilePath $portableExe.FullName -PassThru
  Start-Sleep -Seconds 30
  $found = Get-Process Arckeep -ErrorAction SilentlyContinue
  if (-not $found) { throw 'no Arckeep process found 30s after launching the portable exe' }
  $titleOk = $found | Where-Object { $_.MainWindowTitle -ne '' } | Select-Object -First 1
  Start-Sleep -Seconds 5
  $stillAlive = Get-Process -Id $found[0].Id -ErrorAction SilentlyContinue
  Save-FullScreen (Join-Path $EvidenceDir '20-ac3-portable.png')
  [pscustomobject]@{
    pids = ($found | Select-Object -ExpandProperty Id)
    mainWindowTitle = $titleOk.MainWindowTitle
    aliveAfter20s = [bool]$stillAlive
  } | ConvertTo-Json | Out-File (Join-Path $EvidenceDir '20-ac3-portable.json')
  Get-Process Arckeep -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500
  if (-not $titleOk) { throw 'Arckeep process has no visible main window title (portable)' }
}

# -----------------------------------------------------------------
# AC3: NSIS installer /S smoke
# -----------------------------------------------------------------
Write-Section 'AC3-installer' {
  if (-not $setupExe) { throw 'NSIS Setup exe missing from arckeep-windows artifact' }
  $proc = Start-Process -FilePath $setupExe.FullName -ArgumentList '/S' -Wait -PassThru
  $exitCode = $proc.ExitCode
  $shortcuts = @()
  foreach ($dir in @("$env:APPDATA\Microsoft\Windows\Start Menu\Programs", "$env:ProgramData\Microsoft\Windows\Start Menu\Programs")) {
    if (Test-Path $dir) {
      Get-ChildItem $dir -Recurse -Filter 'Arckeep*.lnk' -ErrorAction SilentlyContinue | ForEach-Object {
        $wshell = New-Object -ComObject WScript.Shell
        $target = $wshell.CreateShortcut($_.FullName).TargetPath
        $shortcuts += [pscustomobject]@{ link = $_.FullName; target = $target }
      }
    }
  }
  [pscustomobject]@{ exitCode = $exitCode; shortcuts = $shortcuts } | ConvertTo-Json -Depth 4 |
    Out-File (Join-Path $EvidenceDir '21-ac3-installer.json')
  if ($exitCode -ne 0) { throw "installer exit code was $exitCode, not 0" }
  if ($shortcuts.Count -eq 0) { throw 'no Arckeep*.lnk shortcut found under Start Menu Programs' }
  $target = $shortcuts[0].target
  if (-not (Test-Path $target)) { throw "shortcut target does not exist: $target" }
  Start-Process -FilePath $target
  Start-Sleep -Seconds 20
  $found = Get-Process Arckeep -ErrorAction SilentlyContinue
  Save-FullScreen (Join-Path $EvidenceDir '22-ac3-installed-launch.png')
  Get-Process Arckeep -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  if (-not $found) { throw 'installed Arckeep did not produce a running process' }
}

# -----------------------------------------------------------------
# Start the AC9 hotkey holder before the Playwright-driven scenes.
# -----------------------------------------------------------------
Get-Process Arckeep -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 300

$holderProc = Start-Process -FilePath 'pwsh' -ArgumentList @('-NoProfile','-File','verify/hold-hotkey.ps1','-EvidenceDir',(Resolve-Path $EvidenceDir).Path) -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 3

# -----------------------------------------------------------------
# Main Playwright-driven scenes (AC4-AC9, X1, X4, X6) live in smoke.mjs.
# -----------------------------------------------------------------
Write-Section 'smoke.mjs' {
  $env:ARCKEEP_UNPACKED_EXE = $unpackedExe.FullName
  $env:ARCKEEP_EVIDENCE_DIR = (Resolve-Path $EvidenceDir).Path
  $env:FAKE_TOKEN = 'ghp_Vf9QzXk2LmP4rT8wYb6nHc3JdA1sE7uG0oKi'
  Push-Location verify
  try {
    node smoke.mjs
    if ($LASTEXITCODE -ne 0) { throw "smoke.mjs exited with code $LASTEXITCODE" }
  } finally {
    Pop-Location
  }
}

if ($holderProc -and -not $holderProc.HasExited) { Stop-Process -Id $holderProc.Id -Force -ErrorAction SilentlyContinue }
Get-Process Arckeep -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

# -----------------------------------------------------------------
# X1 retest: fresh-process, network-cut-before-launch retest of the
# "network unreachable" classification. Isolated from smoke.mjs on purpose
# (see verify/x1-network-retest.mjs header). Firewall rules it creates are
# always removed in its own finally block before this returns, so later
# steps (e.g. the Release smoke test, which needs network) are unaffected.
# -----------------------------------------------------------------
Write-Section 'x1-network-retest.mjs' {
  $env:ARCKEEP_UNPACKED_EXE = $unpackedExe.FullName
  $env:ARCKEEP_EVIDENCE_DIR = (Resolve-Path $EvidenceDir).Path
  $env:FAKE_TOKEN = 'ghp_Vf9QzXk2LmP4rT8wYb6nHc3JdA1sE7uG0oKi'
  Push-Location verify
  try {
    node x1-network-retest.mjs
  } finally {
    Pop-Location
  }
}
Get-Process Arckeep -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

# -----------------------------------------------------------------
# Bonus: Ctrl+Alt+Space occupied before a cold start (does not affect the AC9 verdict).
# -----------------------------------------------------------------
Write-Section 'bonus-default-hotkey-occupied' {
  $spaceHolder = Start-Process -FilePath 'pwsh' -ArgumentList @('-NoProfile','-File','verify/hold-hotkey-space.ps1','-EvidenceDir',(Resolve-Path $EvidenceDir).Path) -WindowStyle Hidden -PassThru
  Start-Sleep -Seconds 3
  Remove-Item -Recurse -Force "$env:APPDATA\Arckeep" -ErrorAction SilentlyContinue
  $proc = Start-Process -FilePath $unpackedExe.FullName -PassThru
  Start-Sleep -Seconds 5
  Save-FullScreen (Join-Path $EvidenceDir '23-bonus-default-hotkey-occupied.png')
  Get-Process Arckeep -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  if ($spaceHolder -and -not $spaceHolder.HasExited) { Stop-Process -Id $spaceHolder.Id -Force -ErrorAction SilentlyContinue }
}

# -----------------------------------------------------------------
# evidence/index.md
# -----------------------------------------------------------------
$indexPath = Join-Path $EvidenceDir 'index.md'
@'
# Arckeep Issue #1 / PR #8 (fef78d5) - evidence index

Generated by `verify/run-all.ps1` + `verify/smoke.mjs` on the `verify/issue-1` branch.
This is verification tooling only; it is not part of the Arckeep product.

| 文件 | 对应勾选项 | 说明 |
|---|---|---|
| 00-artifact-tree.txt / 00-exe-sha256.txt | - | 下载的 artifact 目录树和 exe 的 SHA256 |
| 01-main-window.png / 01-main-window-win.png | AC4 | 清空数据目录后冷启动，主窗口默认尺寸 |
| 02-nav-waiting.png | AC4 | 点击「等我处理」后 |
| 03-nav-overview.png | AC4 | 点击「项目总览」后 |
| 04-nav-todo.png | AC4 | 点击「待办」后 |
| 05-nav-toolshelf.png | AC4 | 点击「工具架」后 |
| 06-settings-empty.png | AC4/AC5 | 首次进入设置页的空状态 |
| 07-settings-invalid-token.png | AC5c/X2 | 粘贴假 token 点「测试连接」后的错误提示，token 仍在输入框 |
| 08a-settings-hotkey-conflict-no-scroll.png | AC9/X3 | 点「保存热键」后**不滚动**的原样截图（第一眼能不能看到提示） |
| 08-settings-hotkey-conflict.png | AC9/X3 | `scrollIntoViewIfNeeded()` 后的冲突提示，能看到警告和旁边的输入框/录制/改用这个 |
| 09-window-narrow-800.png | X6 | 窗口宽度约 800px |
| 10-window-narrow-min.png | X6 | 窗口缩到 getMinimumSize() |
| 11-settings-network-error.png | X1（方法论存疑，见 x1-retest.json） | 复用长时间运行进程时，防火墙封锁出站后点「测试连接」的提示 |
| 11-settings-network-error-retest.png / -retest-win.png | X1（权威结果） | **全新进程**：先断网（程序级+CIDR+解析IP 三重防火墙规则）再冷启动，点「测试连接」的提示 |
| x1-retest.json / x1-retest-verdict.txt | X1（权威结果） | 断网重测的完整步骤记录（DNS 解析、防火墙规则、Test-NetConnection 前后结果）和最终判定 |
| 12-hooks-off.png | X4 | 不设 ARCKEEP_TEST_HOOKS 冷启动，`--arckeep-test=quit` 不起作用 |
| 13-settings-repos-hotkey-saved.png | AC7 | 添加两个关注仓库后 |
| 14-hook-close-fullscreen.png | AC8/F | close 钩子后的全屏截图（窗口应不可见） |
| 15-hook-show.png | AC8/F | show 钩子后窗口恢复可见 |
| 16-appdata-tree.txt | AC6/AC7 | %APPDATA%\Arckeep 目录树 |
| 17-settings.json.copy.json | AC6/AC7 | settings.json 副本 |
| 18-settings-after-restart.png | AC7 | 重启后设置页，确认仓库/热键/PAT 仍在 |
| 19-eventlog-arckeep.txt | AC3 | Application 事件日志中与 Arckeep 相关的 1000/1001/1026 |
| 20-ac3-portable.png / .json | AC3 | portable exe 双击式启动 |
| 21-ac3-installer.json | AC3 | NSIS 安装包 /S 静默安装结果、快捷方式 |
| 22-ac3-installed-launch.png | AC3 | 安装后启动的全屏截图 |
| 23-bonus-default-hotkey-occupied.png | 附加 | 默认热键 Ctrl+Alt+Space 被占用时冷启动的表现（不影响 AC9 结论） |
| 24-release-view.json / 24-release-tag-sha.txt / 24-release-exe-sha256.txt | AC2（绑定 4c5f83b） | Release 元数据、tag 对应的 commit sha、下载资产现算的 SHA256 |
| 25-release-portable-launch.png / .json | AC2（绑定 4c5f83b） | 从 Release 下载的 portable exe 启动冒烟 |
| 26-release-installer.json / 26-release-installed-launch.png | AC2（绑定 4c5f83b） | 从 Release 下载的 Setup.exe `/S` 静默安装 + 启动冒烟 |
| scenes.json | 全部 | 每个检查场景的机器可读结果（PASS/FAIL + 细节） |
| invalid-token-message.txt / hotkey-warning-message.txt | AC5c/AC9 | 提示文案原文 |
| run-all-errors.txt / release-smoke-errors.txt | - | 各脚本里失败场景的错误堆栈 |
'@ | Out-File -Encoding utf8 $indexPath

Write-Host "Evidence written to $EvidenceDir"
exit 0
