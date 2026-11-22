<#
.SYNOPSIS
  Uninstall herdr-nameplate.

.DESCRIPTION
  Unlinks the plugin and, with -Purge, deletes the installed files and the
  per-plugin config directory (config.json + state.json + log). Without -Purge,
  your configuration and state are left in place.

.PARAMETER Purge
  Also delete %LOCALAPPDATA%\herdr-nameplate and
  %APPDATA%\herdr\plugins\config\herdr-nameplate.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1
#>
[CmdletBinding()]
param(
  [switch]$Purge
)

$ErrorActionPreference = 'Stop'
$pluginId = 'herdr-nameplate'

$herdr = Get-Command 'herdr' -ErrorAction SilentlyContinue
if ($herdr) {
  & herdr plugin disable $pluginId 2>$null | Out-Null
  & herdr plugin unlink $pluginId 2>$null | Out-Null
  Write-Host "Unlinked $pluginId."
} else {
  Write-Warning "herdr is not on PATH; skipped unlink."
}

$configDir = Join-Path $env:APPDATA "herdr\plugins\config\$pluginId"
$installDir = Join-Path $env:LOCALAPPDATA 'herdr-nameplate'

if ($Purge) {
  foreach ($path in @($installDir, $configDir)) {
    if (Test-Path $path) {
      Remove-Item $path -Recurse -Force
      Write-Host "Removed $path"
    }
  }
} else {
  Write-Host "Kept configuration and state in $configDir"
  Write-Host 'Re-run with -Purge to delete them.'
}
