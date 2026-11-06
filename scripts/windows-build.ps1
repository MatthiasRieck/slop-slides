# Shared by the local setup/launcher and CI. Dot-source to load functions only.
Set-StrictMode -Version Latest

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

function Initialize-WindowsBuildTools {
    if ($env:OS -ne 'Windows_NT' -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') {
        throw 'These scripts require x64 Windows and a 64-bit PowerShell. Use start.sh on macOS/Linux.'
    }
    Add-BuildToolPath (Join-Path $env:USERPROFILE '.cargo/bin')
    $locator = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
    if (-not (Test-Path -LiteralPath $locator -PathType Leaf)) {
        throw 'Install Visual Studio Build Tools with Desktop development with C++, a Windows SDK, and C++ CMake tools for Windows. See docs/windows-build.md.'
    }
    $installation = Invoke-BuildCommand $locator @('-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath')
    if (-not $installation) {
        throw 'Visual Studio C++ build tools were not found. In Visual Studio Installer, enable Desktop development with C++.'
    }
    & (Join-Path $installation 'Common7/Tools/Launch-VsDevShell.ps1') -Arch amd64 -HostArch amd64 -SkipAutomaticLocation
    Add-BuildToolPath (Join-Path $installation 'Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin')
    Add-BuildToolPath (Join-Path $installation 'Common7/IDE/CommonExtensions/Microsoft/CMake/Ninja')
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
}
