# verify/release-smoke.ps1
#
# Read-only verification helper (not part of the Arckeep product).
# Downloads the `v0.0.1-test` GitHub Release assets with `gh release download`,
# using only the workflow's own GITHUB_TOKEN (passed in as GH_TOKEN by the
# calling step), and does a launch smoke test. This checks a DIFFERENT
# tested object than the rest of this branch's evidence: the Release build
# at commit 4c5f83b (via PR #11), not PR #8's fef78d5 CI artifacts.

param(
  [string]$EvidenceDir = "evidence",
  [string]$Tag = "v0.0.1-test",
  [string]$Repo = "Dylan5237/arckeep",
  [string]$AssetsDir = "release-assets"
)

$ErrorActionPreference = 'Continue'
New-Item -ItemType Directory -Force -Path $EvidenceDir | Out-Null
New-Item -ItemType Directory -Force -Path $AssetsDir | Out-Null

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
    "$Name FAILED: $($_.Exception.Message)`n$($_.ScriptStackTrace)" | Out-File -Append (Join-Path $EvidenceDir 'release-smoke-errors.txt')
  }
}

Write-Section 'release-view' {
  $releaseJson = gh release view $Tag --repo $Repo --json tagName,targetCommitish,assets,url,isPrerelease,publishedAt
  $releaseJson | Out-File (Join-Path $EvidenceDir '24-release-view.json')
  $tagRef = gh api "repos/$Repo/git/refs/tags/$Tag" --jq '.object.sha'
  "tag=$Tag`ntagCommitSha=$tagRef" | Out-File (Join-Path $EvidenceDir '24-release-tag-sha.txt')
}

Write-Section 'release-download' {
  gh release download $Tag --repo $Repo -D $AssetsDir --clobber
  if ($LASTEXITCODE -ne 0) { throw "gh release download exited with code $LASTEXITCODE" }
}

$setup = Get-ChildItem $AssetsDir -Filter '*.exe' -ErrorAction SilentlyContinue | Where-Object { $_.Name -like '*Setup*' } | Select-Object -First 1
$portable = Get-ChildItem $AssetsDir -Filter '*.exe' -ErrorAction SilentlyContinue | Where-Object { $_.Name -notlike '*Setup*' } | Select-Object -First 1

Write-Section 'release-hashes' {
  if (-not $setup -or -not $portable) { throw "downloaded assets missing: setup=$($setup.FullName) portable=$($portable.FullName)" }
  $expected = @{
    'Arckeep-Setup-0.1.0.exe'    = 'B2BB471DC471EFC6045AC140F7D16619E2EC1F987193423222C84828F60FE47A'
    'Arckeep-0.1.0-portable.exe' = '1F7F323E437027518D6280DDA40A28527488F678CF633EF42018398BA9641EFC'
  }
  $hashes = Get-FileHash $setup.FullName, $portable.FullName
  $hashes | Format-Table | Out-String -Width 400 | Out-File (Join-Path $EvidenceDir '24-release-exe-sha256.txt')
  foreach ($h in $hashes) {
    $name = Split-Path $h.Path -Leaf
    if ($expected.ContainsKey($name) -and $h.Hash -ne $expected[$name]) {
      throw "hash mismatch for $name : got $($h.Hash), expected $($expected[$name])"
    }
  }
}

Write-Section 'release-portable-smoke' {
  Get-Process Arckeep -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 300
  if (-not $portable) { throw 'portable exe not found in downloaded release assets' }
  Start-Process -FilePath $portable.FullName
  Start-Sleep -Seconds 25
  $p = Get-Process Arckeep -ErrorAction SilentlyContinue
  Save-FullScreen (Join-Path $EvidenceDir '25-release-portable-launch.png')
  [pscustomobject]@{
    pids  = ($p | Select-Object -ExpandProperty Id)
    title = ($p | Where-Object { $_.MainWindowTitle -ne '' } | Select-Object -First 1 -ExpandProperty MainWindowTitle)
  } | ConvertTo-Json | Out-File (Join-Path $EvidenceDir '25-release-portable-launch.json')
  Get-Process Arckeep -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 300
  if (-not $p) { throw 'no Arckeep process observed after launching the Release portable exe' }
}

Write-Section 'release-installer-smoke' {
  if (-not $setup) { throw 'setup exe not found in downloaded release assets' }
  $proc = Start-Process -FilePath $setup.FullName -ArgumentList '/S' -Wait -PassThru
  $exitCode = $proc.ExitCode
  $lnk = Get-ChildItem "$env:APPDATA\Microsoft\Windows\Start Menu\Programs" -Recurse -Filter 'Arckeep*.lnk' -ErrorAction SilentlyContinue | Select-Object -First 1
  $target = $null
  if ($lnk) {
    $wshell = New-Object -ComObject WScript.Shell
    $target = $wshell.CreateShortcut($lnk.FullName).TargetPath
  }
  [pscustomobject]@{ exitCode = $exitCode; shortcutLink = $lnk.FullName; shortcutTarget = $target } |
    ConvertTo-Json | Out-File (Join-Path $EvidenceDir '26-release-installer.json')
  if ($target -and (Test-Path $target)) {
    Start-Process -FilePath $target
    Start-Sleep -Seconds 20
    Save-FullScreen (Join-Path $EvidenceDir '26-release-installed-launch.png')
    Get-Process Arckeep -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  }
  if ($exitCode -ne 0) { throw "installer exit code was $exitCode, not 0" }
  if (-not $target) { throw 'no Arckeep*.lnk shortcut found after silent install' }
}

exit 0
