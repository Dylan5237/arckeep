<#
Arckeep Issue #5 独立验收 - Windows 原生辅助脚本。
只读观察 + 少量真实 Win32 调用（截图、读剪贴板、按进程树查子进程），不调用被测应用内部函数。

用法（每次调用一个 Action）：
  pwsh -File win.ps1 -Action Screenshot -Path C:\out.png
  pwsh -File win.ps1 -Action ReadClipboard
  pwsh -File win.ps1 -Action ProcessTree -Marker "SOME-UNIQUE-MARKER"
  pwsh -File win.ps1 -Action FindProcess -Name "ping"
#>
param(
  [Parameter(Mandatory = $true)][ValidateSet('Screenshot', 'ReadClipboard', 'ProcessTree', 'FindProcess', 'CompileWriteArgsExe', 'CompileGhStubExe', 'SnapshotPids', 'CheckPidsAlive', 'GetCommandLine')]
  [string]$Action,
  [string]$Path,
  [string]$Marker,
  [string]$Name,
  [string]$OutExe,
  [string]$Pids,
  [int]$Pid1
)

$ErrorActionPreference = 'Stop'

switch ($Action) {
  'Screenshot' {
    if (-not $Path) { throw '-Path is required' }
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
    $graphics = [System.Drawing.Graphics]::FromImage($bmp)
    $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bmp.Size)
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
    $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    $graphics.Dispose(); $bmp.Dispose()
    Write-Output (@{ ok = $true; path = $Path; width = $bounds.Width; height = $bounds.Height } | ConvertTo-Json -Compress)
  }
  'ReadClipboard' {
    Add-Type -AssemblyName System.Windows.Forms
    $text = $null
    try { $text = Get-Clipboard -Raw -ErrorAction Stop } catch { $text = $null }
    $bytes = $null
    if ($null -ne $text) { $bytes = [System.Text.Encoding]::UTF8.GetBytes($text) }
    $b64 = $null
    if ($null -ne $bytes) { $b64 = [Convert]::ToBase64String($bytes) }
    Write-Output (@{ ok = $true; base64 = $b64 } | ConvertTo-Json -Compress)
  }
  'ProcessTree' {
    if (-not $Marker) { throw '-Marker is required' }
    $procs = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($Marker) }
    $list = @()
    foreach ($p in $procs) {
      $list += @{ pid = $p.ProcessId; name = $p.Name; commandLine = $p.CommandLine; parentPid = $p.ParentProcessId }
    }
    Write-Output (@{ ok = $true; count = $list.Count; procs = $list } | ConvertTo-Json -Compress -Depth 5)
  }
  'FindProcess' {
    if (-not $Name) { throw '-Name is required' }
    $procs = Get-Process -Name $Name -ErrorAction SilentlyContinue
    $list = @()
    foreach ($p in $procs) { $list += @{ pid = $p.Id; name = $p.ProcessName } }
    Write-Output (@{ ok = $true; count = $list.Count; procs = $list } | ConvertTo-Json -Compress)
  }
  'SnapshotPids' {
    if (-not $Name) { throw '-Name is required' }
    $names = $Name.Split(',') | ForEach-Object { $_.Trim() }
    $procs = Get-CimInstance Win32_Process | Where-Object { $names -contains ($_.Name -replace '\.exe$', '') -or $names -contains $_.Name }
    $list = @()
    foreach ($p in $procs) {
      $list += @{ pid = $p.ProcessId; name = $p.Name; parentPid = $p.ParentProcessId; commandLine = $p.CommandLine }
    }
    Write-Output (@{ ok = $true; count = $list.Count; procs = $list } | ConvertTo-Json -Compress -Depth 5)
  }
  'CheckPidsAlive' {
    if (-not $Pids) { throw '-Pids is required' }
    $ids = $Pids.Split(',') | ForEach-Object { [int]$_.Trim() } | Where-Object { $_ -gt 0 }
    $alive = @()
    foreach ($id in $ids) {
      $p = Get-Process -Id $id -ErrorAction SilentlyContinue
      if ($p) { $alive += @{ pid = $id; name = $p.ProcessName } }
    }
    Write-Output (@{ ok = $true; alive = $alive; checked = $ids } | ConvertTo-Json -Compress -Depth 5)
  }
  'GetCommandLine' {
    if (-not $Pid1) { throw '-Pid1 is required' }
    $p = Get-CimInstance Win32_Process -Filter "ProcessId = $Pid1" -ErrorAction SilentlyContinue
    if (-not $p) {
      Write-Output (@{ ok = $false; found = $false } | ConvertTo-Json -Compress)
    } else {
      Write-Output (@{ ok = $true; found = $true; name = $p.Name; commandLine = $p.CommandLine } | ConvertTo-Json -Compress)
    }
  }
  'CompileWriteArgsExe' {
    if (-not $OutExe) { throw '-OutExe is required' }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutExe) | Out-Null
    $csc = Get-ChildItem -Path "$env:WINDIR\Microsoft.NET\Framework64" -Filter csc.exe -Recurse -ErrorAction SilentlyContinue |
      Sort-Object FullName -Descending | Select-Object -First 1
    if (-not $csc) {
      $csc = Get-ChildItem -Path "$env:WINDIR\Microsoft.NET\Framework" -Filter csc.exe -Recurse -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending | Select-Object -First 1
    }
    if (-not $csc) { throw 'csc.exe not found; cannot compile the argv-recording helper' }
    $srcPath = [System.IO.Path]::ChangeExtension($OutExe, '.cs')
    $source = @'
using System;
using System.IO;
using System.Text;

class WriteArgs {
  static int Main(string[] args) {
    string dir = AppDomain.CurrentDomain.BaseDirectory;
    string outFile = Path.Combine(dir, "editor-received.txt");
    string content = string.Join("\u0001", args);
    File.WriteAllText(outFile, content, new UTF8Encoding(false));
    return 0;
  }
}
'@
    Set-Content -Path $srcPath -Value $source -Encoding UTF8
    & $csc.FullName "/nologo" "/target:exe" "/out:$OutExe" $srcPath | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "csc.exe failed with exit code $LASTEXITCODE" }
    if (-not (Test-Path -LiteralPath $OutExe)) { throw 'write-args.exe was not produced' }
    Write-Output (@{ ok = $true; exe = $OutExe } | ConvertTo-Json -Compress)
  }
  'CompileGhStubExe' {
    # 独立验收工具用的假 gh.exe：立刻以非 0 退出码结束、不输出任何内容、不碰网络。
    # 用途：真机上观察到被测应用每次调用 getState()/refreshWaiting() 都会各自现场 spawn 一次
    # `gh auth token` 来判断 GitHub 登录状态；如果这台跑手上真的 gh.exe 存在但响应很慢
    # （或者被同名假设影响），会跟我们测试脚本自己触发的界面导航形成竞态（见 lib.mjs 里
    # saveToolShelfJson 的详细注释）。这里造一个跟真 gh 完全无关、瞬间返回的假 gh.exe，塞进测试
    # 进程 PATH 最前面，让「未登录 GitHub」这个状态在所有 session 里都是确定的、毫秒级返回的——
    # 这本身也更贴近硬性规则第 4 条「不使用真实 token」的精神（避免意外读到跑手上任何已登录状态）。
    if (-not $OutExe) { throw '-OutExe is required' }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutExe) | Out-Null
    $csc = Get-ChildItem -Path "$env:WINDIR\Microsoft.NET\Framework64" -Filter csc.exe -Recurse -ErrorAction SilentlyContinue |
      Sort-Object FullName -Descending | Select-Object -First 1
    if (-not $csc) {
      $csc = Get-ChildItem -Path "$env:WINDIR\Microsoft.NET\Framework" -Filter csc.exe -Recurse -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending | Select-Object -First 1
    }
    if (-not $csc) { throw 'csc.exe not found; cannot compile the fake gh.exe' }
    $srcPath = [System.IO.Path]::ChangeExtension($OutExe, '.cs')
    $source = @'
using System;

class GhStub {
  static int Main(string[] args) {
    // 模拟「未登录」：非 0 退出码、无输出、不碰网络、立刻返回。
    return 1;
  }
}
'@
    Set-Content -Path $srcPath -Value $source -Encoding UTF8
    & $csc.FullName "/nologo" "/target:exe" "/out:$OutExe" $srcPath | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "csc.exe failed with exit code $LASTEXITCODE" }
    if (-not (Test-Path -LiteralPath $OutExe)) { throw 'gh.exe (stub) was not produced' }
    Write-Output (@{ ok = $true; exe = $OutExe } | ConvertTo-Json -Compress)
  }
}
