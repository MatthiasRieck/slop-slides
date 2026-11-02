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
function Write-FakeOpenBlas([string] $Directory) {
    foreach ($file in @('include/openblas/cblas.h', 'include/openblas/openblas_config.h', 'lib/openblas.lib', 'share/openblas/copyright')) {
        $path = Join-Path $Directory $file
        New-Item -ItemType Directory -Path (Split-Path $path) -Force | Out-Null
        [IO.File]::WriteAllText($path, 'fixture')
    }
}

$temporaryRoot = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) "slopslide-build-tests-$([guid]::NewGuid())"))
$savedEnvironment = @{}
foreach ($name in @('SLOPSLIDE_OPENBLAS_DIR', 'SLOPSLIDE_REQUIRE_NARRATION_ENGINE', 'SLOPSLIDE_NO_NARRATION_ENGINE')) {
    $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    [Environment]::SetEnvironmentVariable($name, $null, 'Process')
}
try {
    # Exercise the real native-command wrapper before replacing external calls.
    Assert-Throws { Invoke-BuildCommand $env:ComSpec @('/c', 'exit', '7') } 'exit code 7'
    Assert-Throws { Require-BuildTool 'slopslide-nonexistent-tool' 'Install the fixture tool.' } 'Install the fixture tool'

    $script:fixtureRepo = Join-Path $temporaryRoot ('checkout with spaces ' + [char]0x7a7a + [char]0x9593)
    New-Item -ItemType Directory -Path $script:fixtureRepo -Force | Out-Null
    $script:mockRevision = $script:VcpkgRevision
    $script:dirty = $false
    $script:failBuild = $false
    $script:failFetch = $false
    $script:calls = [Collections.Generic.List[string]]::new()
    function Invoke-BuildCommand([string] $Command, [string[]] $Arguments) {
        $script:calls.Add("$Command $($Arguments -join ' ')")
        if ($Arguments -contains 'init') {
            New-Item -ItemType Directory -Path (Join-Path $Arguments[1] '.git') -Force | Out-Null
        } elseif ($Arguments -contains 'fetch') {
            if ($script:failFetch) { throw 'fixture download failure' }
        } elseif ($Arguments -contains 'rev-parse') {
            return $script:mockRevision
        } elseif ($Arguments -contains 'status') {
            if ($script:dirty) { return ' M ports/openblas/portfile.cmake' }
        } elseif ($Command.EndsWith('bootstrap-vcpkg.bat')) {
            [IO.File]::WriteAllText((Join-Path (Split-Path $Command) 'vcpkg.exe'), '')
            Write-Output 'bootstrap progress must not become the library path'
        } elseif ($Command.EndsWith('vcpkg.exe')) {
            if ($script:failBuild) { throw 'fixture build failure' }
            Write-FakeOpenBlas (Join-Path (Split-Path $Command) 'installed/x64-windows-narration')
            Write-Output 'installation progress must not become the library path'
        }
    }

    # First run clones/pins/builds; output remains exactly one usable path.
    $root = Install-NarrationOpenBlas $script:fixtureRepo
    Assert ($root -is [string]) 'Build output contaminated the returned path'
    Assert (Test-OpenBlasInstallation $root) 'Expected a validated static installation'
    Assert (($script:calls -join "`n") -match 'checkout --detach bcd3a4f') 'Expected the pinned revision'
    Assert (($script:calls -join "`n") -match 'openblas\[threads\]:x64-windows-narration') 'Expected the narration triplet'

    $script:calls.Clear()
    Assert ((Install-NarrationOpenBlas $script:fixtureRepo) -eq $root) 'Rerun changed the installation'
    Assert (-not (($script:calls -join "`n") -match 'bootstrap| install | clone ')) 'Complete cached installation was rebuilt'

    # GitHub's cache restores installed/ without a Git checkout.
    $cachedRepo = Join-Path $temporaryRoot 'cache only'
    Write-FakeOpenBlas (Join-Path $cachedRepo '.vcpkg-narration/installed/x64-windows-narration')
    $script:calls.Clear()
    $cachedRoot = Install-NarrationOpenBlas $cachedRepo
    Assert (Test-OpenBlasInstallation $cachedRoot) 'Cache-only restore did not set up a checkout'
    Assert (($script:calls -join "`n") -match 'fetch --depth=1') 'Cache-only restore did not fetch the pin'
    Assert (-not (($script:calls -join "`n") -match 'bootstrap| install ')) 'Cache-only restore rebuilt OpenBLAS'
    $occupiedRepo = Join-Path $temporaryRoot 'occupied'
    Write-FakeOpenBlas (Join-Path $occupiedRepo '.vcpkg-narration')
    Assert-Throws { Install-NarrationOpenBlas $occupiedRepo } 'contains files but is not a vcpkg checkout'
    $retryRepo = Join-Path $temporaryRoot 'retry download'
    $script:failFetch = $true
    Assert-Throws { Install-NarrationOpenBlas $retryRepo } 'fixture download failure'
    $script:failFetch = $false
    $retryRoot = Install-NarrationOpenBlas $retryRepo
    Assert (Test-OpenBlasInstallation $retryRoot) 'Interrupted download could not be retried'

    $script:mockRevision = 'unexpected-revision'
    Assert-Throws { Install-NarrationOpenBlas $script:fixtureRepo } 'will not be overwritten'
    $script:mockRevision = $script:VcpkgRevision
    $script:dirty = $true
    Assert-Throws { Install-NarrationOpenBlas $script:fixtureRepo } 'tracked changes'
    $script:dirty = $false

    # A partial cache is repaired; failures propagate rather than enabling speech.
    Remove-Item -LiteralPath (Join-Path $root 'lib/openblas.lib')
    $script:failBuild = $true
    Assert-Throws { Install-NarrationOpenBlas $script:fixtureRepo } 'fixture build failure'
    $script:failBuild = $false
    Assert ((Install-NarrationOpenBlas $script:fixtureRepo) -eq $root) 'Partial installation was not repaired'

    $env:SLOPSLIDE_OPENBLAS_DIR = $root
    $env:SLOPSLIDE_NO_NARRATION_ENGINE = '1'
    Set-NarrationBuildEnvironment $script:fixtureRepo
    Assert ($env:SLOPSLIDE_REQUIRE_NARRATION_ENGINE -eq '1') 'Build should require speech'
    Assert (-not $env:SLOPSLIDE_NO_NARRATION_ENGINE) 'Default setup retained a stale opt-out'
    Set-NarrationBuildEnvironment $script:fixtureRepo -NoNarration
    Assert ($env:SLOPSLIDE_NO_NARRATION_ENGINE -eq '1') 'Explicit opt-out was ignored'
    Assert (-not $env:SLOPSLIDE_REQUIRE_NARRATION_ENGINE) 'Opt-out retained the requirement'

    # Import libraries/DLL distributions must not pass validation as static BLAS.
    New-Item -ItemType Directory -Path (Join-Path $root 'bin') | Out-Null
    [IO.File]::WriteAllText((Join-Path $root 'bin/openblas.dll'), '')
    Assert (-not (Test-OpenBlasInstallation $root)) 'DLL installation was accepted'
    Assert-Throws { Set-NarrationBuildEnvironment $script:fixtureRepo } 'Unset it to let setup build one'
    $env:SLOPSLIDE_OPENBLAS_DIR = (Join-Path $temporaryRoot 'missing')
    Assert-Throws { Set-NarrationBuildEnvironment $script:fixtureRepo } 'Unset it to let setup build one'

    # Run the real launcher in a child shell with fake tools: verify routing,
    # browser mode without native setup, opt-out forwarding, and failure handling.
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
param([switch] $NoNarration)
Add-Content -LiteralPath $env:SLOPSLIDE_TEST_LOG -Value "setup NoNarration=$NoNarration"
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
            Assert ($log -match 'setup NoNarration=False') 'Launcher did not enable narration by default'
        }
        if ($mode -eq 'dev') { Assert ($log -match 'pnpm app:dev') 'Dev mode did not start Tauri' }
        if ($mode -eq 'build') { Assert ($log -match 'pnpm tauri build\s*$') 'Build mode unexpectedly launched the app' }
        if ($mode -eq 'release') { Assert ($log -match 'pnpm tauri build --no-bundle\s+launch') 'Release did not build before launching' }
    }
    & $realBuildCommand $shellExecutable @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $launcherRoot 'start.ps1'), '-NoNarration')
    Assert ((Get-Content -LiteralPath $env:SLOPSLIDE_TEST_LOG -Raw) -match 'setup NoNarration=True') 'Launcher dropped the explicit opt-out'
    [IO.File]::WriteAllText($env:SLOPSLIDE_TEST_LOG, '')
    $env:SLOPSLIDE_TEST_FAIL = '1'
    Assert-Throws { & $realBuildCommand $shellExecutable @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $launcherRoot 'start.ps1'), '-Mode', 'release') } 'exit code 1'
    Assert ((Get-Content -LiteralPath $env:SLOPSLIDE_TEST_LOG -Raw) -notmatch 'launch') 'Failed build launched an executable'
    Write-Host 'Windows build setup regression tests passed.'
} finally {
    Remove-Item Env:SLOPSLIDE_TEST_LOG, Env:SLOPSLIDE_TEST_FAIL -ErrorAction SilentlyContinue
    foreach ($name in $savedEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process')
    }
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
