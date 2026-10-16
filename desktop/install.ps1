[CmdletBinding()]
param([switch]$ValidateOnly)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

function Get-AbsoluteLocalPath([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value) -or $Value -notmatch '^[A-Za-z]:[\\/]') {
        throw 'A local absolute drive path is required.'
    }
    $full = [IO.Path]::GetFullPath($Value)
    if ($full -eq [IO.Path]::GetPathRoot($full)) { return $full }
    return $full.TrimEnd([char[]]'\/')
}

function Test-Within([string]$Root, [string]$Candidate) {
    $prefix = $Root.TrimEnd([char[]]'\/') + [IO.Path]::DirectorySeparatorChar
    return $Candidate.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
}

function Assert-NoReparsePath([string]$Value) {
    $full = Get-AbsoluteLocalPath $Value
    $root = [IO.Path]::GetPathRoot($full)
    $cursor = $root
    $pieces = $full.Substring($root.Length).Split([char[]]'\/', [StringSplitOptions]::RemoveEmptyEntries)
    foreach ($piece in $pieces) {
        $cursor = Join-Path $cursor $piece
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Refusing a symbolic link or junction: $cursor"
            }
        }
    }
}

function Get-PublicPackageFiles([string]$Root) {
    $allowedRootFiles = @('Resonance.exe','chrome_100_percent.pak','chrome_200_percent.pak',
        'd3dcompiler_47.dll','dxcompiler.dll','dxil.dll','ffmpeg.dll','icudtl.dat',
        'LICENSE','LICENSES.chromium.html','resources.pak','snapshot_blob.bin',
        'v8_context_snapshot.bin','version','vk_swiftshader_icd.json','vk_swiftshader.dll',
        'vulkan-1.dll','build-info.json','DESKTOP.md','INSTALL.md','install.ps1','install.cmd')
    $queue = New-Object 'System.Collections.Generic.Queue[string]'
    $queue.Enqueue($Root)
    $files = New-Object 'System.Collections.Generic.List[object]'
    while ($queue.Count -gt 0) {
        $directory = $queue.Dequeue()
        Assert-NoReparsePath $directory
        foreach ($item in Get-ChildItem -LiteralPath $directory -Force) {
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Refusing a package symbolic link or junction: $($item.FullName)"
            }
            $relative = $item.FullName.Substring($Root.Length + 1).Replace('\','/')
            if ($relative -match '(^|/)(\.runtime|\.openai|\.git|\.env(?:\.[^/]*)?|node_modules|work|tests?|test-results|coverage|[^/]*credentials[^/]*)(/|$)') {
                throw "Private or unexpected package entry: $relative"
            }
            if ($directory -eq $Root) {
                if ($item.PSIsContainer) {
                    if ($item.Name -notin @('locales','resources')) { throw "Unexpected package directory: $relative" }
                } elseif ($item.Name -notin $allowedRootFiles) { throw "Unexpected package file: $relative" }
            }
            if ($relative -eq 'resources/app' -and -not $item.PSIsContainer) { throw 'resources/app must be a directory.' }
            if ($relative -like 'resources/*' -and $relative -ne 'resources/app' -and -not $relative.StartsWith('resources/app/')) {
                throw "Unexpected Electron resource: $relative"
            }
            if ($relative -like 'resources/app/*') {
                $appRelative = $relative.Substring('resources/app/'.Length)
                $first = $appRelative.Split('/')[0]
                if ($first -notin @('desktop','assets','dist','lib','server.mjs','package.json')) {
                    throw "Unexpected application entry: $relative"
                }
            }
            if ($item.PSIsContainer) { $queue.Enqueue($item.FullName) }
            else { $files.Add([pscustomobject]@{FullName=$item.FullName; Relative=$relative}) }
        }
    }
    return $files.ToArray()
}

try {
    $packageDirectory = Get-AbsoluteLocalPath $PSScriptRoot
    Assert-NoReparsePath $packageDirectory
    $manifestPath = Join-Path $packageDirectory 'build-info.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'Run install.cmd from the extracted Windows package, beside build-info.json.' }
    $files = @(Get-PublicPackageFiles $packageDirectory)
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($manifest.platform -ne 'win32' -or $manifest.executable -ne 'Resonance.exe' -or $manifest.includesUserData -ne $false) {
        throw 'The build manifest does not identify a public Resonance Windows package.'
    }
    $version = [string]$manifest.version
    if ($version -notmatch '^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$' -or $version.Length -gt 80) { throw 'Invalid package version.' }
    if ([string]$manifest.executableSha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'Missing executable checksum.' }
    $sourceExecutable = Join-Path $packageDirectory 'Resonance.exe'
    $expectedHash = [string]$manifest.executableSha256
    if ((Get-FileHash -LiteralPath $sourceExecutable -Algorithm SHA256).Hash -ne $expectedHash) { throw 'The executable checksum does not match build-info.json.' }
    $appManifest = Get-Content -LiteralPath (Join-Path $packageDirectory 'resources/app/package.json') -Raw | ConvertFrom-Json
    if ($appManifest.version -ne $version -or $appManifest.main -ne 'desktop/main.cjs') { throw 'Application metadata does not match this package.' }

    $localRoot = Get-AbsoluteLocalPath ([Environment]::GetFolderPath('LocalApplicationData'))
    $programRoot = Get-AbsoluteLocalPath (Join-Path $localRoot 'Programs/Resonance')
    $installDirectory = Get-AbsoluteLocalPath (Join-Path $programRoot $version)
    if (-not (Test-Within $localRoot $programRoot) -or -not (Test-Within $programRoot $installDirectory)) { throw 'Installation escaped the expected program directory.' }
    if ($packageDirectory -eq $installDirectory -or (Test-Within $packageDirectory $installDirectory) -or (Test-Within $installDirectory $packageDirectory)) { throw 'Package and installation directories must be separate.' }
    $privateDirectory = Get-AbsoluteLocalPath (Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'Gongming')
    if ($installDirectory -eq $privateDirectory -or (Test-Within $privateDirectory $installDirectory) -or (Test-Within $installDirectory $privateDirectory)) { throw 'Installation cannot overlap application user data.' }
    Assert-NoReparsePath $programRoot
    Assert-NoReparsePath $installDirectory
    if (Test-Path -LiteralPath $installDirectory) { throw "This version directory already exists. It will not be overwritten: $installDirectory" }
    $desktopDirectory = Get-AbsoluteLocalPath ([Environment]::GetFolderPath('DesktopDirectory'))
    $shortcutPath = Join-Path $desktopDirectory 'Resonance.lnk'
    Assert-NoReparsePath $desktopDirectory
    Assert-NoReparsePath $shortcutPath
    $shell = New-Object -ComObject WScript.Shell
    if (Test-Path -LiteralPath $shortcutPath) {
        $oldShortcut = $shell.CreateShortcut($shortcutPath)
        $oldTarget = Get-AbsoluteLocalPath $oldShortcut.TargetPath
        if (-not (Test-Within $programRoot $oldTarget) -or [IO.Path]::GetFileName($oldTarget) -ne 'Resonance.exe') {
            throw 'An unrelated Resonance desktop shortcut already exists; it will not be overwritten.'
        }
    }
    if ($ValidateOnly) {
        [pscustomobject]@{Package=$packageDirectory; Version=$version; Files=$files.Count; InstallDirectory=$installDirectory; Shortcut=$shortcutPath; WritesPerformed=$false} | ConvertTo-Json
        exit 0
    }

    # Copy only validated public files. Never remove or move an existing tree.
    New-Item -ItemType Directory -Path $installDirectory | Out-Null
    foreach ($file in $files) {
        $destination = Get-AbsoluteLocalPath (Join-Path $installDirectory $file.Relative)
        if (-not (Test-Within $installDirectory $destination)) { throw 'A package file escaped the installation directory.' }
        Assert-NoReparsePath $file.FullName
        Assert-NoReparsePath $destination
        $parent = Split-Path -Path $destination -Parent
        if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent | Out-Null }
        if (Test-Path -LiteralPath $destination) { throw "An unexpected destination file already exists: $destination" }
        Copy-Item -LiteralPath $file.FullName -Destination $destination
    }
    $installedExecutable = Join-Path $installDirectory 'Resonance.exe'
    if ((Get-FileHash -LiteralPath $installedExecutable -Algorithm SHA256).Hash -ne $expectedHash) { throw 'Installed executable verification failed.' }
    # This public program folder contains no keys or workspace data. Electron's
    # sandbox needs read/execute permission; do not apply this ACL to AppData.
    Assert-NoReparsePath $installDirectory
    $aclTool = Join-Path $env:SystemRoot 'System32/icacls.exe'
    & $aclTool $installDirectory '/grant' '*S-1-15-2-1:(OI)(CI)(RX)' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not configure Electron sandbox read permission on the installed program directory.' }
    Assert-NoReparsePath $shortcutPath
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $installedExecutable
    $shortcut.WorkingDirectory = $installDirectory
    $shortcut.IconLocation = "$installedExecutable,0"
    $shortcut.Description = 'Resonance local AI collaboration workspace'
    $shortcut.Save()
    Write-Host "Installed Resonance $version."
    Write-Host "Program: $installedExecutable"
    Write-Host "Shortcut: $shortcutPath"
    Write-Host 'Existing conversations and credentials were not modified. Open the shortcut when ready.'
    exit 0
} catch {
    Write-Host ('Installation stopped: ' + $_.Exception.Message) -ForegroundColor Red
    Write-Host 'Existing versions and user data were not removed. Any partial new version folder was left for inspection.'
    exit 1
}
