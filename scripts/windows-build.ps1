# Shared by the local setup/launcher and CI. Dot-source to load functions only.
Set-StrictMode -Version Latest

$script:VcpkgRevision = 'bcd3a4fa5419dbe6bfb23f7610062621b3f596f2'

function Add-BuildToolPath([string] $Directory) {
    if ((Test-Path -LiteralPath $Directory -PathType Container) -and
        $Directory -notin ($env:PATH -split ';')) {
        $env:PATH = "$Directory;$env:PATH"
    }
}

function Require-BuildTool([string] $Name, [string] $HelpText) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "$Name was not found. $HelpText"
    }
}

function Invoke-BuildCommand([string] $Command, [string[]] $Arguments) {
    # Handle native exit codes consistently in Windows PowerShell and PowerShell 7.
    $PSNativeCommandUseErrorActionPreference = $false
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Command failed (exit code $LASTEXITCODE). Fix the error above and rerun the command."
    }
}

function Initialize-WindowsBuildTools([bool] $Narration = $true) {
    if ($env:OS -ne 'Windows_NT' -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') {
        throw 'These scripts require x64 Windows and a 64-bit PowerShell. Use start.sh on macOS/Linux.'
    }
    Add-BuildToolPath (Join-Path $env:USERPROFILE '.cargo/bin')
    $locator = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
    if (-not (Test-Path -LiteralPath $locator -PathType Leaf)) {
        throw 'Install Visual Studio Build Tools with Desktop development with C++, a Windows SDK, and C++ CMake tools for Windows. See docs/windows-narration.md.'
    }
    $installation = Invoke-BuildCommand $locator @('-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath')
    if (-not $installation) {
        throw 'Visual Studio C++ build tools were not found. In Visual Studio Installer, enable Desktop development with C++.'
    }
    & (Join-Path $installation 'Common7/Tools/Launch-VsDevShell.ps1') -Arch amd64 -HostArch amd64 -SkipAutomaticLocation
    Add-BuildToolPath (Join-Path $installation 'Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin')
    Add-BuildToolPath (Join-Path $installation 'Common7/IDE/CommonExtensions/Microsoft/CMake/Ninja')
    Add-BuildToolPath (Join-Path $env:ProgramFiles 'LLVM/bin')
    Add-BuildToolPath (Join-Path $installation 'VC/Tools/Llvm/bin')
    Add-BuildToolPath (Join-Path $installation 'VC/Tools/Llvm/x64/bin')
    Require-BuildTool cl.exe 'Install the Visual Studio C++ x64/x86 build tools.'
    # Git Bash prepends its own link.exe. Pin Rust to the linker beside cl.exe
    # so checks/builds work even if a child shell reorders PATH.
    $linker = Join-Path (Split-Path (Get-Command cl.exe).Source) 'link.exe'
    if (-not (Test-Path -LiteralPath $linker -PathType Leaf)) {
        throw 'MSVC link.exe was not found beside cl.exe. Repair the Visual Studio C++ build tools.'
    }
    $env:CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER = $linker
    Require-BuildTool rc.exe 'Install a Windows SDK through Visual Studio Installer.'
    Require-BuildTool cmake.exe 'Install C++ CMake tools for Windows through Visual Studio Installer.'
    if ($Narration) {
        Require-BuildTool clang-cl.exe 'Install C++ Clang tools for Windows through Visual Studio Installer, or add an installed LLVM/bin to PATH.'
    }
}

function Test-OpenBlasInstallation([string] $Directory) {
    foreach ($file in @('include/openblas/cblas.h', 'include/openblas/openblas_config.h', 'lib/openblas.lib', 'share/openblas/copyright')) {
        if (-not (Test-Path -LiteralPath (Join-Path $Directory $file) -PathType Leaf)) {
            return $false
        }
    }
    return -not (Test-Path -LiteralPath (Join-Path $Directory 'bin/openblas.dll'))
}

function Install-NarrationOpenBlas([string] $RepoRoot) {
    Require-BuildTool git.exe 'Install Git for Windows and add it to PATH.'
    $checkout = Join-Path $RepoRoot '.vcpkg-narration'
    $pendingCheckout = Join-Path $checkout '.git/slopslide-setup-pending'
    if (-not (Test-Path -LiteralPath (Join-Path $checkout '.git'))) {
        # CI may have restored only installed/ before the checkout exists.
        if ((Test-Path -LiteralPath $checkout) -and
            @(Get-ChildItem -LiteralPath $checkout -Force | Where-Object Name -ne 'installed').Count -gt 0) {
            throw "$checkout contains files but is not a vcpkg checkout. Move it aside and rerun setup."
        }
        New-Item -ItemType Directory -Path $checkout -Force | Out-Null
        Invoke-BuildCommand git.exe @('-C', $checkout, 'init') | Out-Host
        New-Item -ItemType File -Path $pendingCheckout | Out-Null
    }
    if (Test-Path -LiteralPath $pendingCheckout) {
        # A failed/interrupted download can be retried without deleting the cache.
        Invoke-BuildCommand git.exe @('-C', $checkout, 'fetch', '--depth=1', 'https://github.com/microsoft/vcpkg.git', $script:VcpkgRevision) | Out-Host
        Invoke-BuildCommand git.exe @('-C', $checkout, 'checkout', '--detach', $script:VcpkgRevision) | Out-Host
        Remove-Item -LiteralPath $pendingCheckout
    }
    $revision = Invoke-BuildCommand git.exe @('-C', $checkout, 'rev-parse', 'HEAD')
    if ($revision -ne $script:VcpkgRevision) {
        throw "$checkout must be at vcpkg revision $script:VcpkgRevision. Move your existing checkout aside and rerun setup; it will not be overwritten."
    }
    $changes = Invoke-BuildCommand git.exe @('-C', $checkout, 'status', '--porcelain', '--untracked-files=no')
    if ($changes) {
        throw "$checkout has tracked changes. Move it aside or resolve your changes before rerunning setup."
    }
    $root = Join-Path $checkout 'installed/x64-windows-narration'
    # Reuse a complete local/CI installation without recompiling it.
    if (-not (Test-OpenBlasInstallation $root)) {
        $vcpkg = Join-Path $checkout 'vcpkg.exe'
        if (-not (Test-Path -LiteralPath $vcpkg -PathType Leaf)) {
            Invoke-BuildCommand (Join-Path $checkout 'bootstrap-vcpkg.bat') @('-disableMetrics') | Out-Host
        }
        Invoke-BuildCommand $vcpkg @('install', 'openblas[threads]:x64-windows-narration', "--overlay-triplets=$(Join-Path $RepoRoot 'scripts/vcpkg-triplets')", '--host-triplet=x64-windows-narration', '--disable-metrics') | Out-Host
    }
    if (-not (Test-OpenBlasInstallation $root)) {
        throw "OpenBLAS installation at $root is incomplete or uses a DLL. See docs/windows-narration.md."
    }
    return $root
}

function Set-NarrationBuildEnvironment([string] $RepoRoot, [switch] $NoNarration) {
    if ($NoNarration) {
        $env:SLOPSLIDE_NO_NARRATION_ENGINE = '1'
        Remove-Item Env:SLOPSLIDE_REQUIRE_NARRATION_ENGINE -ErrorAction SilentlyContinue
        Write-Host 'Narration engine explicitly disabled for this build.'
        return
    }
    $root = $env:SLOPSLIDE_OPENBLAS_DIR
    if ($root) {
        if (-not (Test-OpenBlasInstallation $root)) {
            throw "SLOPSLIDE_OPENBLAS_DIR=$root must contain a static x64-windows-narration OpenBLAS installation. Unset it to let setup build one."
        }
        $root = (Resolve-Path -LiteralPath $root).Path
    } else {
        $root = Install-NarrationOpenBlas $RepoRoot
    }
    $env:SLOPSLIDE_OPENBLAS_DIR = $root
    $env:SLOPSLIDE_REQUIRE_NARRATION_ENGINE = '1'
    Remove-Item Env:SLOPSLIDE_NO_NARRATION_ENGINE -ErrorAction SilentlyContinue
    Write-Host "Narration enabled using $root"
}
