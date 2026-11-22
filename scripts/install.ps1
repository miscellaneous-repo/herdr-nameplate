<#
.SYNOPSIS
  Install herdr-automatic-rename-win from a checkout or an unpacked release.

.DESCRIPTION
  Copies the plugin to %LOCALAPPDATA%\herdr-automatic-rename\<version>, links it
  with herdr, and runs a dry pass so you can see what it would name.

.PARAMETER Source
  Directory to install from. Defaults to the parent of this script.

.PARAMETER NoLink
  Copy the files but do not touch herdr's plugin list.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
#>
[CmdletBinding()]
param(
  [string]$Source = (Split-Path -Parent $PSScriptRoot),
  [switch]$NoLink
)

$ErrorActionPreference = 'Stop'
$pluginId = 'herdr-automatic-rename-win'
$payload = @('bin', 'src', 'herdr-plugin.toml', 'package.json', 'README.md', 'README.en.md', 'LICENSE', 'CHANGELOG.md', 'docs', 'examples')

function Require-Command([string]$Name, [string]$Hint) {
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  if (-not $cmd) {
    throw "Missing '$Name'. $Hint"
  }
  return $cmd
}

Require-Command 'herdr' 'Install herdr and make sure `herdr` is on PATH.' | Out-Null
$node = Require-Command 'node' 'Install Node.js 20 or newer.'

$packageJson = Join-Path $Source 'package.json'
if (-not (Test-Path $packageJson)) {
  throw "No package.json in '$Source'. Point -Source at the plugin root."
}
$meta = Get-Content $packageJson -Raw | ConvertFrom-Json
$version = $meta.version

$nodeMajor = [int](& $node.Source -p 'process.versions.node.split(".")[0]')
if ($nodeMajor -lt 20) {
  throw "Node.js 20 or newer is required (found $(& $node.Source --version))."
}

$destination = Join-Path $env:LOCALAPPDATA "$pluginId\$version"
Write-Host "Installing $pluginId $version"
Write-Host "  from $Source"
Write-Host "  to   $destination"

if (Test-Path $destination) {
  Remove-Item $destination -Recurse -Force
}
New-Item -ItemType Directory -Path $destination -Force | Out-Null

foreach ($item in $payload) {
  $from = Join-Path $Source $item
  if (-not (Test-Path $from)) {
    if ($item -in @('README.en.md')) { continue }
    throw "Missing '$item' in $Source"
  }
  Copy-Item $from -Destination $destination -Recurse -Force
}

if ($NoLink) {
  Write-Host 'Skipped herdr plugin link (-NoLink).'
  exit 0
}

# Re-linking is how herdr picks up a new path; ignore "not linked" on first run.
& herdr plugin unlink $pluginId 2>$null | Out-Null
& herdr plugin link $destination --enabled
if ($LASTEXITCODE -ne 0) {
  throw "herdr plugin link failed with exit code $LASTEXITCODE"
}

Write-Host ''
Write-Host 'Installed. A dry pass follows; nothing is renamed yet.'
& node (Join-Path $destination 'bin\ar.mjs') doctor
