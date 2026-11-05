#Requires -Version 5.1
# Offline regression tests; no Pester installation, downloads, or compiler required.
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/windows-build.ps1"
$realBuildCommand = ${function:Invoke-BuildCommand}

function Assert([bool] $Condition, [string] $Message) {
    if (-not $Condition) { throw $Message }
}

function Assert-Throws([scriptblock] $Action, [string] $Pattern) {
    try { & $Action } catch {
        Assert ($_.Exception.Message -match $Pattern) "Unexpected error: $_"
        return
    }
    throw "Expected failure matching $Pattern"
}

$temporaryRoot = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) "slopslide-build-tests-$([guid]::NewGuid())"))
try {
    # Exercise the real native-command wrapper before replacing external calls.
    Assert-Throws { Invoke-BuildCommand $env:ComSpec @('/c', 'exit', '7') } 'exit code 7'
    Assert-Throws { Require-BuildTool 'slopslide-nonexistent-tool' 'Install the fixture tool.' } 'Install the fixture tool'

    # Run the real launcher in a child shell with fake tools: verify routing,
    # browser mode without native setup, and failure handling.
    $launcherRoot = Join-Path $temporaryRoot 'launcher with spaces'
    New-Item -ItemType Directory -Path (Join-Path $launcherRoot 'scripts') -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path (Split-Path $PSScriptRoot) 'start.ps1') -Destination $launcherRoot
    @'
function Add-BuildToolPath($Directory) {}
function Require-BuildTool($Name, $HelpText) {}
function Invoke-BuildCommand($Command, $Arguments) {
    if ($Command -eq 'node') { return 22 }
    Add-Content -LiteralPath $env:SLOPSLIDE_TEST_LOG -Value "$Command $($Arguments -join ' ')"
    if ($env:SLOPSLIDE_TEST_FAIL -and $Arguments -contains 'build') { throw 'fixture launch failure' }
}
function Start-Process($FilePath, $WindowStyle) {
    Add-Content -LiteralPath $env:SLOPSLIDE_TEST_LOG -Value 'launch'
}
'@ | Set-Content -LiteralPath (Join-Path $launcherRoot 'scripts/windows-build.ps1')
    @'
Add-Content -LiteralPath $env:SLOPSLIDE_TEST_LOG -Value 'setup'
'@ | Set-Content -LiteralPath (Join-Path $launcherRoot 'scripts/setup-windows.ps1')
    $shellExecutable = Join-Path $PSHOME 'powershell.exe'
    if (Test-Path -LiteralPath (Join-Path $PSHOME 'pwsh.exe')) { $shellExecutable = Join-Path $PSHOME 'pwsh.exe' }
    $env:SLOPSLIDE_TEST_LOG = Join-Path $launcherRoot 'calls.txt'
    foreach ($mode in @('dev', 'browser', 'build', 'release')) {
        [IO.File]::WriteAllText($env:SLOPSLIDE_TEST_LOG, '')
        & $realBuildCommand $shellExecutable @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $launcherRoot 'start.ps1'), '-Mode', $mode)
        $log = Get-Content -LiteralPath $env:SLOPSLIDE_TEST_LOG -Raw
        Assert ($log -match 'pnpm install --frozen-lockfile') 'Launcher did not install locked dependencies'
        if ($mode -eq 'browser') {
            Assert ($log -notmatch 'setup') 'Browser preview unexpectedly required native tools'
            Assert ($log -match 'pnpm dev') 'Browser preview did not start Vite'
        } else {
            Assert ($log -match 'setup') 'Launcher did not set up the build tools'
        }
        if ($mode -eq 'dev') { Assert ($log -match 'pnpm app:dev') 'Dev mode did not start Tauri' }
        if ($mode -eq 'build') { Assert ($log -match 'pnpm tauri build\s*$') 'Build mode unexpectedly launched the app' }
        if ($mode -eq 'release') { Assert ($log -match 'pnpm tauri build --no-bundle\s+launch') 'Release did not build before launching' }
    }
    [IO.File]::WriteAllText($env:SLOPSLIDE_TEST_LOG, '')
    $env:SLOPSLIDE_TEST_FAIL = '1'
    Assert-Throws { & $realBuildCommand $shellExecutable @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $launcherRoot 'start.ps1'), '-Mode', 'release') } 'exit code 1'
    Assert ((Get-Content -LiteralPath $env:SLOPSLIDE_TEST_LOG -Raw) -notmatch 'launch') 'Failed build launched an executable'
    Write-Host 'Windows build setup regression tests passed.'
} finally {
    Remove-Item Env:SLOPSLIDE_TEST_LOG, Env:SLOPSLIDE_TEST_FAIL -ErrorAction SilentlyContinue
    # Only delete the exact, uniquely named test directory under the temp root.
    $resolvedTemporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if ($temporaryRoot.StartsWith($resolvedTemporaryRoot, [StringComparison]::OrdinalIgnoreCase) -and
        (Split-Path $temporaryRoot -Leaf) -like 'slopslide-build-tests-*' -and
        (Test-Path -LiteralPath $temporaryRoot)) {
        Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
    }
}

# Expected child-process failures above must not become the CI step's exit code.
$global:LASTEXITCODE = 0
