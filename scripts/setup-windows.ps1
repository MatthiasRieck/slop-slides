#Requires -Version 5.1
<#
.SYNOPSIS
Prepare the native x64 Windows build tools in the current PowerShell process.
.DESCRIPTION
Run from PowerShell: ./scripts/setup-windows.ps1
Finds Visual Studio's C++ tools, its linker and CMake. No machine settings are changed.
Use ./start.ps1 to set up and build in one command.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/windows-build.ps1"
Initialize-WindowsBuildTools
Write-Host 'Native Windows build environment ready. See docs/windows-build.md for the remaining app prerequisites.'
