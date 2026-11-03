#Requires -Version 5.1
<#
.SYNOPSIS
Prepare native x64 Windows build tools and the pinned static OpenBLAS dependency.
.DESCRIPTION
Run from PowerShell: ./scripts/setup-windows.ps1
Downloads/builds OpenBLAS on first use and reuses it on subsequent runs. The
environment is configured in the current PowerShell process; no machine settings
are changed. Use ./start.ps1 to set up and build in one command.
.PARAMETER NoNarration
Explicitly skip OpenBLAS and build without the narration engine.
#>
[CmdletBinding()]
param([switch] $NoNarration)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/windows-build.ps1"
$repoRoot = Split-Path -Parent $PSScriptRoot
Initialize-WindowsBuildTools -Narration (-not $NoNarration)
Set-NarrationBuildEnvironment -RepoRoot $repoRoot -NoNarration:$NoNarration
Write-Host 'Native Windows build environment ready. See docs/windows-narration.md for the remaining app prerequisites.'
