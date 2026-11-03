#Requires -Version 5.1
<#
.SYNOPSIS
Set up and start SlopSlide on x64 Windows.
.DESCRIPTION
./start.ps1                 desktop dev mode with hot reload
./start.ps1 -Mode release   build an optimized executable and launch it
./start.ps1 -Mode build     build installers without launching
./start.ps1 -Mode browser   UI preview only; no native build tools required
Add -NoNarration to explicitly omit the speech engine.
#>
[CmdletBinding()]
param(
    [ValidateSet('dev', 'release', 'build', 'browser')]
    [string] $Mode = 'dev',
    [switch] $NoNarration
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/scripts/windows-build.ps1"
Push-Location $PSScriptRoot
try {
    Add-BuildToolPath (Join-Path $env:USERPROFILE '.cargo/bin')
    Require-BuildTool node 'Install Node.js 22 or newer from https://nodejs.org.'
    Require-BuildTool pnpm 'Install pnpm using npm install --global pnpm.'
    $nodeMajor = [int] ((Invoke-BuildCommand node @('-p', 'process.versions.node.split(".")[0]')))
    if ($nodeMajor -lt 22) { throw 'SlopSlide requires Node.js 22 or newer.' }
    if ($Mode -ne 'browser') {
        Require-BuildTool cargo 'Install stable Rust with the x86_64-pc-windows-msvc toolchain from https://rustup.rs.'
        & "$PSScriptRoot/scripts/setup-windows.ps1" -NoNarration:$NoNarration
    }
    Invoke-BuildCommand pnpm @('install', '--frozen-lockfile')
    switch ($Mode) {
        'dev' { Invoke-BuildCommand pnpm @('app:dev') }
        'browser' { Invoke-BuildCommand pnpm @('dev') }
        'build' { Invoke-BuildCommand pnpm @('tauri', 'build') }
        'release' {
            Invoke-BuildCommand pnpm @('tauri', 'build', '--no-bundle')
            Start-Process -FilePath (Join-Path $PSScriptRoot 'src-tauri/target/release/slopslide.exe') -WindowStyle Normal
        }
    }
} finally {
    Pop-Location
}
