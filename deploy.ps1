#Requires -Version 5.1
<#
.SYNOPSIS
    One-command deploy for the Project Zomboid B42 server stack + web panel.

.DESCRIPTION
    - First run: interactive setup wizard (secrets, admin, branch, ports),
      builds images, starts all services, provisions the admin account.
    - Later runs: brings the stack up and prints access URLs.

.EXAMPLE
    .\deploy.ps1
    .\deploy.ps1 -Yes          # skip "Proceed?" style confirmations where supported
    .\deploy.ps1 -Init         # force re-run of the setup wizard
    .\deploy.ps1 -Status       # show status only
#>

param(
    [switch]$Yes,
    [switch]$Init,
    [switch]$Status,
    [switch]$Down,
    [switch]$Help
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $repoRoot

function Show-Help {
    Write-Host @"

  Project Zomboid Server + Admin Panel (Docker)

  Usage:
    .\deploy.ps1              First-time setup or start stack
    .\deploy.ps1 -Init        Force setup wizard again
    .\deploy.ps1 -Status      Show URLs and container status
    .\deploy.ps1 -Down        Stop all services
    .\deploy.ps1 -Help        This help

  After deploy:
    Panel:   http://localhost:8000
    Game:    UDP 16261 + 16262 (forward these for remote players)

  Day-to-day commands:
    .\make.ps1 up | down | logs | restart | info | nuke

"@
}

if ($Help) {
    Show-Help
    exit 0
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: Docker is not installed or not on PATH." -ForegroundColor Red
    Write-Host "Install Docker Desktop (Linux containers) and try again." -ForegroundColor Yellow
    exit 1
}

if ($Status) {
    & (Join-Path $repoRoot "make.ps1") info
    & (Join-Path $repoRoot "make.ps1") ps
    exit 0
}

if ($Down) {
    & (Join-Path $repoRoot "make.ps1") down
    exit 0
}

Write-Host ""
Write-Host "╔══════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║   Project Zomboid B42 - Full Stack Deploy        ║" -ForegroundColor Cyan
Write-Host "║   Game server + web panel + RCON + backups       ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

$hasRootEnv = Test-Path -LiteralPath (Join-Path $repoRoot ".env")
$hasAppEnv = Test-Path -LiteralPath (Join-Path $repoRoot "app\.env")
$needInit = $false
if ($Init) { $needInit = $true }
if (-not $hasRootEnv) { $needInit = $true }
if (-not $hasAppEnv) { $needInit = $true }

if ($needInit) {
    if ($Yes) {
        $env:PZ_SETUP_ASSUME_YES = "1"
    }
    Write-Host 'Running first-time setup wizard...' -ForegroundColor Yellow
    Write-Host '  Defaults: B42 Stable (public), local panel on :8000' -ForegroundColor DarkGray
    if (-not $Yes) {
        Write-Host '  Press Enter through prompts to accept defaults.' -ForegroundColor DarkGray
    } else {
        Write-Host '  Non-interactive mode (-Yes): auto-accepting defaults.' -ForegroundColor DarkGray
    }
    Write-Host ""
    & (Join-Path $repoRoot "make.ps1") init
    exit $LASTEXITCODE
}

Write-Host "Environment found - starting stack..." -ForegroundColor Green
& (Join-Path $repoRoot "make.ps1") deploy
exit $LASTEXITCODE
