param([string]$DistDir = 'dist')

$ErrorActionPreference = 'Stop'
$packageDir = (Resolve-Path -LiteralPath $DistDir).Path
$exe = Get-Item -LiteralPath (Join-Path $packageDir 'win-unpacked/Arckeep.exe')
$resultDir = Join-Path $packageDir ('package-smoke/' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $resultDir -Force | Out-Null
$imagePath = Join-Path $resultDir 'signed-out.png'
$environmentNames = @('ARCKEEP_SCREENSHOT', 'ARCKEEP_SCREENSHOT_SCENE', 'ARCKEEP_DEV', 'VITE_DEV_SERVER_URL', 'ELECTRON_RUN_AS_NODE', 'GH_TOKEN', 'GITHUB_TOKEN', 'TEMP', 'TMP')
$savedEnvironment = @{}
foreach ($name in $environmentNames) {
  $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
$smokeProcess = $null
try {
  foreach ($name in $environmentNames) {
    Remove-Item -LiteralPath ('Env:' + $name) -ErrorAction SilentlyContinue
  }
  [Environment]::SetEnvironmentVariable('ARCKEEP_SCREENSHOT', $imagePath, 'Process')
  [Environment]::SetEnvironmentVariable('ARCKEEP_SCREENSHOT_SCENE', 'signed-out', 'Process')
  [Environment]::SetEnvironmentVariable('TEMP', $resultDir, 'Process')
  [Environment]::SetEnvironmentVariable('TMP', $resultDir, 'Process')
  $smokeProcess = Start-Process -FilePath $exe.FullName -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $resultDir 'stdout.log') `
    -RedirectStandardError (Join-Path $resultDir 'stderr.log')
  $deadline = [DateTime]::UtcNow.AddSeconds(45)
  while (-not $smokeProcess.WaitForExit(1000)) {
    if ([DateTime]::UtcNow -ge $deadline) { throw 'Packaged fixture startup timed out after 45 seconds' }
  }
  if ($smokeProcess.ExitCode -ne 0) { throw "Packaged fixture startup exited with code $($smokeProcess.ExitCode)" }
  if (-not (Test-Path -LiteralPath $imagePath)) { throw 'Packaged renderer did not produce its ready-state screenshot' }
  $png = [IO.File]::ReadAllBytes($imagePath)
  if ($png.Length -lt 1024 -or [BitConverter]::ToString($png[0..7]) -ne '89-50-4E-47-0D-0A-1A-0A') {
    throw 'Packaged renderer screenshot is not a valid PNG payload'
  }
  Write-Output "Packaged fixture startup smoke passed: $imagePath"
} finally {
  if ($smokeProcess -and -not $smokeProcess.HasExited) {
    # Kill only the process tree started by this invocation, never every Arckeep process.
    & (Join-Path $env:SystemRoot 'System32/taskkill.exe') /PID $smokeProcess.Id /T /F | Out-Null
    if (-not $smokeProcess.WaitForExit(5000)) { Write-Warning 'Owned smoke process did not exit after cleanup' }
  }
  foreach ($name in $environmentNames) {
    if ($null -eq $savedEnvironment[$name]) {
      Remove-Item -LiteralPath ('Env:' + $name) -ErrorAction SilentlyContinue
    } else {
      [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process')
    }
  }
}
