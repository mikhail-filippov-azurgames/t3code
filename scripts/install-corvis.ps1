#requires -Version 5.1
<#
.SYNOPSIS
Builds Corvis from corvis/main and creates a desktop shortcut.
.PARAMETER InstallDirectory
Source checkout directory. Defaults to a corvis directory beside this script.
#>
[CmdletBinding()]
param(
    [string] $InstallDirectory = (Join-Path $PSScriptRoot 'corvis')
)

$ErrorActionPreference = 'Stop'
$repositoryUrl = 'https://github.com/mikhail-filippov-azurgames/t3code'
$branch = 'corvis/main'
# Standalone downloads have no adjacent package.json. The test keeps this fallback
# aligned with the root engines.node. The cloned manifest is checked again below.
$requiredNodeVersion = '26.13.1'

function Invoke-Checked {
    param([string] $Command, [string[]] $Arguments)
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Command failed (exit $LASTEXITCODE). Resolve the error above and run the installer again."
    }
}

function Assert-NodeVersion {
    param([string] $RequiredVersion, [string] $ActualVersion)
    if ($ActualVersion -notmatch '^v(\d+)\.') {
        throw "Cannot read Node.js version $ActualVersion. Install Node.js 26 from https://nodejs.org/ and run the installer again."
    }
    if ([int] $Matches[1] -lt 26) {
        throw "Node.js 26 is required, found $ActualVersion (engines.node is $RequiredVersion). Install Node.js 26 from https://nodejs.org/ and run the installer again."
    }
    if ($ActualVersion -ne "v$RequiredVersion") {
        Write-Warning "Node.js $ActualVersion differs from engines.node ($RequiredVersion). Continuing with Node.js 26 support."
    }
}

function Test-VcRuntime {
    $systemDirectory = [Environment]::SystemDirectory
    (Test-Path -LiteralPath (Join-Path $systemDirectory 'vcruntime140.dll') -PathType Leaf) -and
        (Test-Path -LiteralPath (Join-Path $systemDirectory 'vcruntime140_1.dll') -PathType Leaf)
}

function Assert-VcRuntime {
    if (Test-VcRuntime) { return }
    $url = 'https://aka.ms/vs/17/release/vc_redist.x64.exe'
    $failure = "Microsoft Visual C++ Redistributable (x64) is required. Install it from $url and run the installer again."
    $installer = Join-Path ([IO.Path]::GetTempPath()) 'corvis-vc_redist.x64.exe'
    Write-Host 'Installing Microsoft Visual C++ Redistributable (x64)...'
    try {
        $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest -Uri $url -OutFile $installer -UseBasicParsing
        $process = Start-Process -FilePath $installer -ArgumentList '/install', '/quiet', '/norestart' -Wait -PassThru
    } catch {
        throw "$failure $($_.Exception.Message)"
    } finally {
        Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue
    }
    # 3010 asks for a reboot, 1638 means a newer version is present.
    if (@(0, 3010, 1638) -notcontains $process.ExitCode -or -not (Test-VcRuntime)) {
        throw "$failure (vc_redist exit $($process.ExitCode))"
    }
}

try {
    if (-not $PSBoundParameters.ContainsKey('InstallDirectory')) {
        $temporaryDirectory = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/')
        if ($PSScriptRoot -eq $temporaryDirectory -or $PSScriptRoot.StartsWith($temporaryDirectory + '\', [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Specify a permanent installation directory, for example -InstallDirectory "C:\Corvis", when running this script from temp.'
        }
    }
    $InstallDirectory = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($InstallDirectory)
    $sourceManifest = Join-Path (Split-Path -Parent $PSScriptRoot) 'package.json'
    if (Test-Path -LiteralPath $sourceManifest -PathType Leaf) {
        $requiredNodeVersion = (Get-Content -LiteralPath $sourceManifest -Raw | ConvertFrom-Json).engines.node
    }

    # Node 25+ no longer bundles Corepack, so it is installed for the current user when missing.
    if ((Get-Command npm -ErrorAction SilentlyContinue) -and -not (Get-Command corepack -ErrorAction SilentlyContinue)) {
        Write-Host 'Installing Corepack...'
        Invoke-Checked npm @('install', '--global', 'corepack') | Out-Host
        $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
    }
    if ((Get-Command corepack -ErrorAction SilentlyContinue) -and -not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
        $shimDirectory = Split-Path -Parent (Get-Command corepack).Source
        Invoke-Checked corepack @('enable', '--install-directory', $shimDirectory, 'pnpm') | Out-Host
    }

    $prerequisites = [ordered]@{
        node = "Install Node.js 26 from https://nodejs.org/ (engines.node is $requiredNodeVersion)."
        corepack = 'Install Corepack following https://github.com/nodejs/corepack#installation.'
        pnpm = 'Prepare pnpm using Corepack following https://pnpm.io/installation#using-corepack.'
        git = 'Install Git for Windows from https://git-scm.com/download/win.'
    }
    foreach ($command in $prerequisites.Keys) {
        if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
            throw "Missing $command. $($prerequisites[$command]) Open a new PowerShell window and run the installer again."
        }
    }
    $nodeVersion = (Invoke-Checked node @('--version') | Out-String).Trim()
    Assert-NodeVersion $requiredNodeVersion $nodeVersion
    Invoke-Checked corepack @('--version') | Out-Host
    Invoke-Checked pnpm @('--version') | Out-Host
    Invoke-Checked git @('--version') | Out-Host
    Assert-VcRuntime
    Write-Host 'Environment checks passed.'

    $existingDirectory = Test-Path -LiteralPath $InstallDirectory
    if ($existingDirectory) {
        $directory = Get-Item -LiteralPath $InstallDirectory -Force
        if (-not $directory.PSIsContainer -or ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'The installation path must be a directory without a symbolic link or junction.'
        }
    }
    if ($existingDirectory -and (Get-ChildItem -LiteralPath $InstallDirectory -Force | Select-Object -First 1)) {
        $parentPath = (Invoke-Checked git @('-C', $InstallDirectory, 'rev-parse', '--show-cdup') | Out-String).Trim()
        if ($parentPath) {
            throw 'The installation directory must be the root of its own Git checkout.'
        }
        $origin = (Invoke-Checked git @('-C', $InstallDirectory, 'remote', 'get-url', 'origin') | Out-String).Trim()
        if ($origin -ne $repositoryUrl -and $origin -ne "$repositoryUrl.git") {
            throw 'The installation directory belongs to a different repository. Choose another InstallDirectory.'
        }
        $changes = Invoke-Checked git @('-C', $InstallDirectory, 'status', '--porcelain', '--untracked-files=all')
        if ($changes) {
            throw 'The installation checkout has local changes or untracked files. Commit, stash, or move them before updating.'
        }
        $currentBranch = (Invoke-Checked git @('-C', $InstallDirectory, 'branch', '--show-current') | Out-String).Trim()
        if ($currentBranch -ne $branch) {
            throw 'The installation checkout must be on the corvis/main branch. Switch branches before updating.'
        }
        $localCommitCount = (Invoke-Checked git @('-C', $InstallDirectory, 'rev-list', '--count', "origin/$branch..HEAD") | Out-String).Trim()
        if ([int] $localCommitCount -gt 0) {
            throw 'The installation checkout has local commits. Preserve them before updating.'
        }
        Invoke-Checked git @('-C', $InstallDirectory, 'config', '--local', 'core.longpaths', 'true')
        Invoke-Checked git @('-c', 'core.longpaths=true', '-C', $InstallDirectory, 'fetch', '--depth', '1', 'origin', "+refs/heads/${branch}:refs/remotes/origin/$branch")
        Invoke-Checked git @('-C', $InstallDirectory, 'checkout', '-B', $branch)
        Invoke-Checked git @('-C', $InstallDirectory, 'reset', '--hard', "origin/$branch")
    } else {
        Write-Host "Cloning Corvis into $InstallDirectory"
        # Only the latest commit, and without .repos (vendored references the app never builds from).
        Invoke-Checked git @('-c', 'core.longpaths=true', 'clone', '--depth', '1', '--filter=blob:none', '--no-checkout', '--branch', $branch, '--single-branch', '--', $repositoryUrl, $InstallDirectory)
        Invoke-Checked git @('-C', $InstallDirectory, 'config', '--local', 'core.longpaths', 'true')
        Invoke-Checked git @('-C', $InstallDirectory, 'sparse-checkout', 'set', '--no-cone', '/*', '!/.repos/')
        Invoke-Checked git @('-c', 'core.longpaths=true', '-C', $InstallDirectory, 'checkout', $branch)
    }

    $manifest = Get-Content -LiteralPath (Join-Path $InstallDirectory 'package.json') -Raw | ConvertFrom-Json
    Assert-NodeVersion $manifest.engines.node $nodeVersion
    Push-Location -LiteralPath $InstallDirectory
    try {
        Write-Host 'Installing application dependencies...'
        Invoke-Checked pnpm @('install')
        Write-Host 'Building the desktop application...'
        Invoke-Checked pnpm @('run', 'build:desktop')
        # Use the desktop runtime repair seam, including its normal Electron cache.
        $runtimeOutput = @(Invoke-Checked node @('apps/desktop/scripts/ensure-electron-runtime.mjs'))
        $electronPath = [string] ($runtimeOutput | Select-Object -Last 1)
    } finally {
        Pop-Location
    }

    $entryPath = Join-Path $InstallDirectory 'apps/desktop/dist-electron/main.cjs'
    if (-not [IO.Path]::IsPathRooted($electronPath) -or -not (Test-Path -LiteralPath $electronPath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $entryPath -PathType Leaf)) {
        throw 'The desktop build or Electron runtime is missing. Resolve the build error and run the installer again.'
    }
    $desktopDirectory = [Environment]::GetFolderPath('DesktopDirectory')
    if (-not $desktopDirectory -or -not (Test-Path -LiteralPath $desktopDirectory -PathType Container)) {
        throw 'The Windows desktop directory is unavailable. Run this installer from your Windows user session.'
    }
    $shortcutPath = Join-Path $desktopDirectory 'Corvis.lnk'
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $electronPath
    $shortcut.Arguments = '"' + $entryPath + '"'
    $shortcut.WorkingDirectory = $InstallDirectory
    $shortcut.Description = 'Corvis'
    $shortcut.Save()
    Write-Host "Corvis is ready. Open $shortcutPath to start."
} catch {
    [Console]::Error.WriteLine("Corvis installation failed. $($_.Exception.Message)")
    exit 1
}
