[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$SourceRoot,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$PackageDir,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$EvidenceOutput
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:ToolResults = [System.Collections.Generic.List[object]]::new()
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)

function ConvertTo-WindowsCommandLineArgument {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value)

    $builder = [System.Text.StringBuilder]::new()
    [void]$builder.Append('"')
    $backslashCount = 0
    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq [char]92) {
            $backslashCount++
            continue
        }

        if ($character -eq [char]34) {
            if ($backslashCount -gt 0) {
                [void]$builder.Append(('\' * (2 * $backslashCount)))
            }
            [void]$builder.Append('\"')
            $backslashCount = 0
            continue
        }

        if ($backslashCount -gt 0) {
            [void]$builder.Append(('\' * $backslashCount))
            $backslashCount = 0
        }
        [void]$builder.Append($character)
    }

    if ($backslashCount -gt 0) {
        [void]$builder.Append(('\' * (2 * $backslashCount)))
    }
    [void]$builder.Append('"')
    return $builder.ToString()
}

function Write-Utf8Json {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][object]$Value
    )

    $json = ConvertTo-Json -InputObject $Value -Depth 12
    [System.IO.File]::WriteAllText($Path, $json + [Environment]::NewLine, $utf8NoBom)
}

function Invoke-CapturedTool {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Executable,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory
    )

    $startedUtc = [DateTime]::UtcNow.ToString('o')
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $Executable
    $startInfo.Arguments = [string]::Join(' ', [string[]]@($Arguments | ForEach-Object { ConvertTo-WindowsCommandLineArgument -Value $_ }))
    $startInfo.WorkingDirectory = $WorkingDirectory
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $startInfo.StandardErrorEncoding = [System.Text.Encoding]::UTF8

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    try {
        if (-not $process.Start()) {
            throw "Could not start tool: $Executable"
        }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        $process.WaitForExit()
        $stdout = $stdoutTask.GetAwaiter().GetResult()
        $stderr = $stderrTask.GetAwaiter().GetResult()
        $exitCode = $process.ExitCode
    }
    finally {
        $process.Dispose()
    }

    $record = [ordered]@{
        name = $Name
        executable = $Executable
        arguments = @($Arguments)
        workingDirectory = $WorkingDirectory
        startedUtc = $startedUtc
        exitCode = $exitCode
        stdout = $stdout
        stderr = $stderr
    }
    $script:ToolResults.Add($record)
    $logPath = Join-Path $script:ToolLogDirectory ($Name + '.json')
    $textLogPath = Join-Path $script:ToolLogDirectory ($Name + '.txt')
    Write-Utf8Json -Path $logPath -Value $record
    $argumentJson = ConvertTo-Json -InputObject @($Arguments) -Compress
    $textLog = @(
        "name: $Name"
        "executable: $Executable"
        "arguments-json: $argumentJson"
        "working-directory: $WorkingDirectory"
        "started-utc: $startedUtc"
        "exit-code: $exitCode"
        '--- stdout ---'
        $stdout.TrimEnd([char[]]@("`r", "`n"))
        '--- stderr ---'
        $stderr.TrimEnd([char[]]@("`r", "`n"))
    ) -join [Environment]::NewLine
    [System.IO.File]::WriteAllText($textLogPath, $textLog + [Environment]::NewLine, $utf8NoBom)

    if ($exitCode -ne 0) {
        throw "Tool '$Name' exited with code $exitCode. See $textLogPath"
    }
    return [pscustomobject]@{
        ExitCode = $exitCode
        StdOut = $stdout
        StdErr = $stderr
        LogPath = $logPath
        TextLogPath = $textLogPath
    }
}

function Get-SevenZipEntryRecords {
    param([Parameter(Mandatory = $true)][string]$Listing)

    $records = [System.Collections.Generic.List[hashtable]]::new()
    $current = @{}
    foreach ($line in ($Listing -split "`r?`n")) {
        if ([string]::IsNullOrWhiteSpace($line)) {
            if ($current.ContainsKey('Path')) {
                $records.Add($current)
            }
            $current = @{}
            continue
        }

        if ($line -match '^([^=]+?)\s*=\s?(.*)$') {
            $current[$Matches[1].Trim()] = $Matches[2]
        }
    }
    if ($current.ContainsKey('Path')) {
        $records.Add($current)
    }
    return @($records.ToArray())
}

function Get-RequiredSevenZipEntry {
    param(
        [Parameter(Mandatory = $true)][hashtable[]]$Entries,
        [Parameter(Mandatory = $true)][string]$RelativePath
    )

    $expected = $RelativePath.Replace('/', '\').TrimStart('\')
    $matches = @($Entries | Where-Object {
        $_.ContainsKey('Path') -and $_['Path'].Replace('/', '\').TrimStart('\').Equals($expected, [StringComparison]::OrdinalIgnoreCase)
    })
    if ($matches.Count -ne 1) {
        throw "Expected exactly one archive entry '$RelativePath'; found $($matches.Count)."
    }
    return $matches[0]
}

function Get-Sha256Upper {
    param([Parameter(Mandatory = $true)][string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToUpperInvariant()
}

function Write-AssociatedIconPng {
    param(
        [Parameter(Mandatory = $true)][string]$SourcePath,
        [Parameter(Mandatory = $true)][string]$OutputPath
    )

    $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($SourcePath)
    if ($null -eq $icon) {
        throw "System.Drawing.Icon.ExtractAssociatedIcon returned no icon for '$SourcePath'."
    }
    $bitmap = $null
    $stream = $null
    try {
        $bitmap = $icon.ToBitmap()
        $stream = [System.IO.File]::Open($OutputPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    }
    finally {
        if ($null -ne $stream) { $stream.Dispose() }
        if ($null -ne $bitmap) { $bitmap.Dispose() }
        $icon.Dispose()
    }
}

$sourcePath = [System.IO.Path]::GetFullPath($SourceRoot)
$packagePath = [System.IO.Path]::GetFullPath($PackageDir)
$evidencePath = [System.IO.Path]::GetFullPath($EvidenceOutput)
if (-not (Test-Path -LiteralPath $sourcePath -PathType Container)) { throw "SourceRoot does not exist: $sourcePath" }
if (-not (Test-Path -LiteralPath $packagePath -PathType Container)) { throw "PackageDir does not exist: $packagePath" }
if (Test-Path -LiteralPath $evidencePath) { throw "EvidenceOutput already exists; choose a new directory: $evidencePath" }
if (-not (Test-Path -LiteralPath (Split-Path -Parent $evidencePath) -PathType Container)) { throw "EvidenceOutput parent does not exist: $(Split-Path -Parent $evidencePath)" }

$sourcePrefix = $sourcePath.TrimEnd('\') + '\'
$packagePrefix = $packagePath.TrimEnd('\') + '\'
if ($evidencePath.StartsWith($sourcePrefix, [StringComparison]::OrdinalIgnoreCase) -or
    $evidencePath.StartsWith($packagePrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'EvidenceOutput must be outside SourceRoot and PackageDir.'
}

[void][System.IO.Directory]::CreateDirectory($evidencePath)
$script:ToolLogDirectory = Join-Path $evidencePath 'tool-logs'
[void][System.IO.Directory]::CreateDirectory($script:ToolLogDirectory)

$installerMatches = @(Get-ChildItem -LiteralPath $packagePath -File -Filter '*-Setup-*.exe')
$portableMatches = @(Get-ChildItem -LiteralPath $packagePath -File -Filter '*-portable.exe')
if ($installerMatches.Count -ne 1) { throw "Expected exactly one *-Setup-*.exe in PackageDir; found $($installerMatches.Count)." }
if ($portableMatches.Count -ne 1) { throw "Expected exactly one *-portable.exe in PackageDir; found $($portableMatches.Count)." }

$installerPath = $installerMatches[0].FullName
$portablePath = $portableMatches[0].FullName
$manifestPath = Join-Path $packagePath 'package-manifest.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$sevenZipPath = Join-Path $sourcePath 'node_modules\electron-winstaller\vendor\7z-x64.exe'
if (-not (Test-Path -LiteralPath $sevenZipPath -PathType Leaf)) { throw "7-Zip executable is missing: $sevenZipPath" }

try {
    $gitResult = Invoke-CapturedTool -Name 'source-revision' -Executable 'git.exe' -Arguments @('-C', $sourcePath, 'rev-parse', 'HEAD') -WorkingDirectory $sourcePath
    $sourceRevision = $gitResult.StdOut.Trim()
    if ($sourceRevision -notmatch '^[0-9a-fA-F]{40}$') { throw "git rev-parse returned an invalid revision: '$sourceRevision'" }

    $installerList = Invoke-CapturedTool -Name 'installer-list' -Executable $sevenZipPath -Arguments @('l', '-slt', $installerPath) -WorkingDirectory $packagePath
    $portableList = Invoke-CapturedTool -Name 'portable-list' -Executable $sevenZipPath -Arguments @('l', '-slt', $portablePath) -WorkingDirectory $packagePath
    $payloadEntryPath = '$PLUGINSDIR\app-64.7z'
    $installerEntry = Get-RequiredSevenZipEntry -Entries (Get-SevenZipEntryRecords -Listing $installerList.StdOut) -RelativePath $payloadEntryPath
    $portableEntry = Get-RequiredSevenZipEntry -Entries (Get-SevenZipEntryRecords -Listing $portableList.StdOut) -RelativePath $payloadEntryPath

    $rawPayloadRoot = Join-Path $evidencePath 'raw-payloads'
    [void][System.IO.Directory]::CreateDirectory($rawPayloadRoot)
    $containerRoot = Join-Path $rawPayloadRoot 'containers'
    [void][System.IO.Directory]::CreateDirectory($containerRoot)
    $installerContainerDirectory = Join-Path $containerRoot 'installer'
    $portableContainerDirectory = Join-Path $containerRoot 'portable'
    [void][System.IO.Directory]::CreateDirectory($installerContainerDirectory)
    [void][System.IO.Directory]::CreateDirectory($portableContainerDirectory)

    $installerExtract = Invoke-CapturedTool -Name 'installer-extract-app-64' -Executable $sevenZipPath -Arguments @('e', '-y', "-o$installerContainerDirectory", $installerPath, $payloadEntryPath) -WorkingDirectory $packagePath
    $portableExtract = Invoke-CapturedTool -Name 'portable-extract-app-64' -Executable $sevenZipPath -Arguments @('e', '-y', "-o$portableContainerDirectory", $portablePath, $payloadEntryPath) -WorkingDirectory $packagePath
    $installerPayloadArchive = Join-Path $installerContainerDirectory 'app-64.7z'
    $portablePayloadArchive = Join-Path $portableContainerDirectory 'app-64.7z'
    if (-not (Test-Path -LiteralPath $installerPayloadArchive -PathType Leaf)) { throw 'NSIS payload extraction did not produce app-64.7z.' }
    if (-not (Test-Path -LiteralPath $portablePayloadArchive -PathType Leaf)) { throw 'Portable payload extraction did not produce app-64.7z.' }

    $installerPayloadHash = Get-Sha256Upper -Path $installerPayloadArchive
    $portablePayloadHash = Get-Sha256Upper -Path $portablePayloadArchive
    $payloadArchivesMatch = $installerPayloadHash -eq $portablePayloadHash

    $installerPayloadList = Invoke-CapturedTool -Name 'installer-payload-list' -Executable $sevenZipPath -Arguments @('l', '-slt', $installerPayloadArchive) -WorkingDirectory $packagePath
    $portablePayloadList = Invoke-CapturedTool -Name 'portable-payload-list' -Executable $sevenZipPath -Arguments @('l', '-slt', $portablePayloadArchive) -WorkingDirectory $packagePath
    $installerPayloadEntries = Get-SevenZipEntryRecords -Listing $installerPayloadList.StdOut
    $portablePayloadEntries = Get-SevenZipEntryRecords -Listing $portablePayloadList.StdOut

    $unpackedRoot = Join-Path $packagePath 'win-unpacked'
    if (-not (Test-Path -LiteralPath $unpackedRoot -PathType Container)) { throw "win-unpacked is missing: $unpackedRoot" }
    $relativeKeyFiles = @('Arckeep.exe', 'resources/app.asar', 'resources/icon.ico', 'resources/icon.png')
    $payloadExtractionRoot = Join-Path $rawPayloadRoot 'payload-keyfiles'
    $installerKeyRoot = Join-Path $payloadExtractionRoot 'installer'
    $portableKeyRoot = Join-Path $payloadExtractionRoot 'portable'
    [void][System.IO.Directory]::CreateDirectory($installerKeyRoot)
    [void][System.IO.Directory]::CreateDirectory($portableKeyRoot)

    $keyFileResults = [System.Collections.Generic.List[object]]::new()
    foreach ($relativeKeyFile in $relativeKeyFiles) {
        $normalizedRelativePath = $relativeKeyFile.Replace('/', '\')
        $installerPayloadMember = Get-RequiredSevenZipEntry -Entries $installerPayloadEntries -RelativePath $normalizedRelativePath
        $portablePayloadMember = Get-RequiredSevenZipEntry -Entries $portablePayloadEntries -RelativePath $normalizedRelativePath
        $installerExtractRoot = Join-Path $installerKeyRoot ([System.IO.Path]::GetFileNameWithoutExtension($relativeKeyFile) + '-' + [guid]::NewGuid().ToString('N'))
        $portableExtractRoot = Join-Path $portableKeyRoot ([System.IO.Path]::GetFileNameWithoutExtension($relativeKeyFile) + '-' + [guid]::NewGuid().ToString('N'))
        [void][System.IO.Directory]::CreateDirectory($installerExtractRoot)
        [void][System.IO.Directory]::CreateDirectory($portableExtractRoot)

        $safeKeyName = $relativeKeyFile.Replace('/', '-').Replace('\\', '-').Replace('.', '-')
        $installerName = 'installer-payload-' + $safeKeyName
        $portableName = 'portable-payload-' + $safeKeyName
        $null = Invoke-CapturedTool -Name $installerName -Executable $sevenZipPath -Arguments @('x', '-y', "-o$installerExtractRoot", $installerPayloadArchive, $installerPayloadMember['Path']) -WorkingDirectory $packagePath
        $null = Invoke-CapturedTool -Name $portableName -Executable $sevenZipPath -Arguments @('x', '-y', "-o$portableExtractRoot", $portablePayloadArchive, $portablePayloadMember['Path']) -WorkingDirectory $packagePath

        $installerExtractedFile = Join-Path $installerExtractRoot $normalizedRelativePath
        $portableExtractedFile = Join-Path $portableExtractRoot $normalizedRelativePath
        if (-not (Test-Path -LiteralPath $installerExtractedFile -PathType Leaf)) { throw "NSIS payload key file was not extracted: $relativeKeyFile" }
        if (-not (Test-Path -LiteralPath $portableExtractedFile -PathType Leaf)) { throw "Portable payload key file was not extracted: $relativeKeyFile" }
        $unpackedFile = Join-Path $unpackedRoot $normalizedRelativePath
        if (-not (Test-Path -LiteralPath $unpackedFile -PathType Leaf)) { throw "win-unpacked key file is missing: $unpackedFile" }

        $installerHash = Get-Sha256Upper -Path $installerExtractedFile
        $portableHash = Get-Sha256Upper -Path $portableExtractedFile
        $unpackedHash = Get-Sha256Upper -Path $unpackedFile
        $keyFileResults.Add([ordered]@{
            name = $relativeKeyFile.Replace('\', '/')
            installerPayload = [ordered]@{ sha256 = $installerHash; extractedPath = $installerExtractedFile; matchesWinUnpacked = ($installerHash -eq $unpackedHash) }
            portablePayload = [ordered]@{ sha256 = $portableHash; extractedPath = $portableExtractedFile; matchesWinUnpacked = ($portableHash -eq $unpackedHash) }
            winUnpacked = [ordered]@{ sha256 = $unpackedHash; path = $unpackedFile }
        })
    }

    Add-Type -AssemblyName System.Drawing
    $iconDirectory = Join-Path $evidencePath 'icons'
    [void][System.IO.Directory]::CreateDirectory($iconDirectory)
    $iconSources = @(
        [pscustomobject]@{ name = 'application'; path = (Join-Path $unpackedRoot 'Arckeep.exe') },
        [pscustomobject]@{ name = 'installer'; path = $installerPath },
        [pscustomobject]@{ name = 'portable'; path = $portablePath }
    )
    $iconResults = [System.Collections.Generic.List[object]]::new()
    foreach ($iconSource in $iconSources) {
        $iconOutputPath = Join-Path $iconDirectory ($iconSource.name + '.png')
        Write-AssociatedIconPng -SourcePath $iconSource.path -OutputPath $iconOutputPath
        $bitmapInfo = [System.Drawing.Image]::FromFile($iconOutputPath)
        try {
            $iconResults.Add([ordered]@{
                name = $iconSource.name
                source = $iconSource.path
                method = 'System.Drawing.Icon.ExtractAssociatedIcon'
                output = $iconOutputPath
                width = $bitmapInfo.Width
                height = $bitmapInfo.Height
                bytes = (Get-Item -LiteralPath $iconOutputPath).Length
                sha256 = Get-Sha256Upper -Path $iconOutputPath
            })
        }
        finally {
            $bitmapInfo.Dispose()
        }
    }

    $allKeyFilesMatch = @($keyFileResults | Where-Object {
        -not $_.installerPayload.matchesWinUnpacked -or -not $_.portablePayload.matchesWinUnpacked
    }).Count -eq 0
    $manifestRevision = [string]$manifest.sourceRevision
    $manifestRevisionMatches = $manifestRevision -eq $sourceRevision
    $verification = [ordered]@{
        generatedUtc = [DateTime]::UtcNow.ToString('o')
        sourceRoot = $sourcePath
        packageDir = $packagePath
        sourceRevision = $sourceRevision
        packageManifestSourceRevision = $manifestRevision
        sourceRevisionMatchesPackageManifest = $manifestRevisionMatches
        scope = 'Read-only extraction and SHA-256 comparison of the literal $PLUGINSDIR\app-64.7z entry in the NSIS installer and portable package; selected payload files are compared with win-unpacked; application, installer, and portable associated icons are saved as PNG. This does not execute the installer or app and does not establish clean-machine installation or business acceptance.'
        package = [ordered]@{
            installer = $installerPath
            portable = $portablePath
            sevenZip = $sevenZipPath
        }
        containers = @(
            [ordered]@{
                kind = 'installer'
                packagePath = $installerPath
                entry = $payloadEntryPath
                entryBytes = [long]$installerEntry['Size']
                extractedPath = $installerPayloadArchive
                sha256 = $installerPayloadHash
            },
            [ordered]@{
                kind = 'portable'
                packagePath = $portablePath
                entry = $payloadEntryPath
                entryBytes = [long]$portableEntry['Size']
                extractedPath = $portablePayloadArchive
                sha256 = $portablePayloadHash
            }
        )
        payloadArchivesMatch = $payloadArchivesMatch
        keyFilesMatchWinUnpacked = $allKeyFilesMatch
        keyFiles = @($keyFileResults.ToArray())
        icons = @($iconResults.ToArray())
        toolLogDirectory = $script:ToolLogDirectory
        toolCommands = @($script:ToolResults.ToArray() | ForEach-Object {
            [ordered]@{
                name = $_.name
                executable = $_.executable
                arguments = $_.arguments
                workingDirectory = $_.workingDirectory
                exitCode = $_.exitCode
                log = (Join-Path $script:ToolLogDirectory ($_.name + '.json'))
                textLog = (Join-Path $script:ToolLogDirectory ($_.name + '.txt'))
            }
        })
        result = if ($payloadArchivesMatch -and $allKeyFilesMatch -and $manifestRevisionMatches) { 'PASS' } else { 'FAIL' }
    }
    Write-Utf8Json -Path (Join-Path $evidencePath 'verification.json') -Value $verification

    if ($verification.result -ne 'PASS') {
        throw 'Payload identity, key-file equality, or package manifest source revision check failed. See verification.json.'
    }
    Write-Output (Join-Path $evidencePath 'verification.json')
}
catch {
    $failure = [ordered]@{
        generatedUtc = [DateTime]::UtcNow.ToString('o')
        error = $_.Exception.Message
        toolLogDirectory = $script:ToolLogDirectory
        toolCommands = @($script:ToolResults.ToArray() | ForEach-Object {
            [ordered]@{
                name = $_.name
                executable = $_.executable
                arguments = $_.arguments
                workingDirectory = $_.workingDirectory
                exitCode = $_.exitCode
                log = (Join-Path $script:ToolLogDirectory ($_.name + '.json'))
                textLog = (Join-Path $script:ToolLogDirectory ($_.name + '.txt'))
            }
        })
    }
    if ($evidencePath -and (Test-Path -LiteralPath $evidencePath -PathType Container)) {
        Write-Utf8Json -Path (Join-Path $evidencePath 'failure.json') -Value $failure
    }
    throw
}
