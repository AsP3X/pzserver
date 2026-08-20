#Requires -Version 5.1
<#
.SYNOPSIS
    One-command deploy for the Project Zomboid B42 server stack + web panel.

.DESCRIPTION
    Windows counterpart of ./deploy.sh, with the same command surface.
    Does NOT require Make - only Docker Desktop (Linux containers) and
    PowerShell 5.1. All work is delegated to make.ps1.

    First run: interactive setup wizard (secrets, admin, branch, ports),
    builds images, starts all services. Later runs bring the stack up and
    print access URLs.

.PARAMETER Service
    Service names for -Logs and -Restart. Ignored by every other command.

.EXAMPLE
    .\deploy.ps1
    .\deploy.ps1 -Init
    .\deploy.ps1 -Logs game-server
    .\deploy.ps1 -Restart web-api web-ui
#>
param(
    [switch]$Init,
    [switch]$Status,
    [switch]$Ps,
    [switch]$Logs,
    [switch]$Restart,
    [switch]$Rebuild,
    [switch]$RebuildGame,
    [switch]$Down,
    [switch]$Yes,
    [switch]$NoColor,
    [switch]$Help,

    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Service
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSCommandPath
Set-Location -LiteralPath $repoRoot

$webUiPort = if ($env:WEB_UI_PORT) { $env:WEB_UI_PORT } else { "8100" }

# -- Output helpers ----------------------------------------------------------
$script:UseColor = -not ($NoColor -or $env:NO_COLOR)

function Write-Line {
    param([string]$Text, [string]$Color)
    if ($script:UseColor -and $Color) {
        Write-Host $Text -ForegroundColor $Color
    } else {
        Write-Host $Text
    }
}

function Write-Step { param([string]$Message) Write-Line "-> $Message" "Cyan" }
function Write-Ok   { param([string]$Message) Write-Line "OK: $Message" "Green" }
function Write-Warn { param([string]$Message) Write-Line "WARNING: $Message" "Yellow" }

function Write-Die {
    param([string]$Message)
    Write-Line "ERROR: $Message" "Red"
    exit 1
}

# Which phase we are in, so a failure can say what was being attempted.
$script:CurrentStage = "startup"

function Show-Help {
    Write-Host ""
    Write-Line "  Project Zomboid Server + Admin Panel (Docker)" "White"
    Write-Host ""
    Write-Line "  Usage:" "White"
    Write-Host "    .\deploy.ps1                     First-time setup, or start / redeploy the stack"
    Write-Host "    .\deploy.ps1 -Init               Force the setup wizard again"
    Write-Host "    .\deploy.ps1 -Status             Show URLs and container status"
    Write-Host "    .\deploy.ps1 -Ps                 Container table only"
    Write-Host "    .\deploy.ps1 -Logs [svc...]      Follow logs (all services, or the named ones)"
    Write-Host "    .\deploy.ps1 -Restart [svc...]   Restart all services, or the named ones"
    Write-Host "    .\deploy.ps1 -Rebuild            Rebuild images from upstream bases, then start"
    Write-Host "    .\deploy.ps1 -RebuildGame        Rebuild game-server only"
    Write-Host "    .\deploy.ps1 -Down               Stop and remove all services"
    Write-Host "    .\deploy.ps1 -Help               This help"
    Write-Host ""
    Write-Line "  Flags:" "White"
    Write-Host "    -Yes                             Accept wizard defaults (non-interactive setup)"
    Write-Host "    -NoColor                         Disable coloured output"
    Write-Host ""
    Write-Line "  Service names (for -Logs / -Restart):" "White"
    Write-Host "    game-server  web-api  web-ui  web-db  db  redis  docker-socket-proxy"
    Write-Host ""
    Write-Line "  After deploy:" "White"
    Write-Host "    Panel:   http://localhost:$webUiPort  (default WEB_UI_PORT; -Status shows the real one)"
    Write-Host "    Game:    UDP 16261 + 16262 (forward these for remote players)"
    Write-Host "    Data:    .\data\zomboid  .\data\server  .\data\backups"
    Write-Host ""
    Write-Line "  Environment:" "White"
    Write-Host "    PZ_STOP_TIMEOUT   per-container stop timeout, seconds (default 15)"
    Write-Host "    WEB_PROXY_MODE    local | caddy | npm - overrides the value in .env"
    Write-Host "    NO_COLOR          disable coloured output"
    Write-Host ""
    Write-Line "  Examples:" "White"
    Write-Host "    .\deploy.ps1 -Logs game-server         tail just the game server"
    Write-Host "    .\deploy.ps1 -Restart web-api web-ui   restart the panel services"
    Write-Host ""
    Write-Line "  Day-to-day commands:  .\make.ps1 help" "DarkGray"
    Write-Host ""
}

if ($Help) {
    Show-Help
    exit 0
}

# -- Argument parsing --------------------------------------------------------
$verbs = @()
if ($Init)        { $verbs += "init" }
if ($Status)      { $verbs += "status" }
if ($Ps)          { $verbs += "ps" }
if ($Logs)        { $verbs += "logs" }
if ($Restart)     { $verbs += "restart" }
if ($Rebuild)     { $verbs += "rebuild" }
if ($RebuildGame) { $verbs += "rebuild-game" }
if ($Down)        { $verbs += "down" }

if ($verbs.Count -gt 1) {
    Write-Die "only one command at a time (got: $($verbs -join ', ')). See .\deploy.ps1 -Help"
}
$cmd = if ($verbs.Count -eq 1) { $verbs[0] } else { "up" }

$services = @()
if ($Service) {
    $services = @($Service | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
}

# Anything left starting with "-" is a typo, not a service name. Refuse it
# rather than silently passing it to docker compose.
$unknown = @($services | Where-Object { $_.StartsWith("-") })
if ($unknown.Count -gt 0) {
    Write-Line "ERROR: unknown option: $($unknown -join ' ')" "Red"
    Write-Line "  Valid: -Init -Status -Ps -Logs -Restart -Rebuild -RebuildGame -Down -Yes -NoColor -Help" "DarkGray"
    exit 1
}

if ($services.Count -gt 0 -and $cmd -ne "logs" -and $cmd -ne "restart") {
    Write-Line "ERROR: unexpected argument: $($services -join ' ')" "Red"
    Write-Line "  Only -Logs and -Restart accept service names. See .\deploy.ps1 -Help" "DarkGray"
    exit 1
}

# -- Preflight ---------------------------------------------------------------
$archFile = if ([System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture -eq [System.Runtime.InteropServices.Architecture]::Arm64) {
    "docker-compose.arm64.yml"
} else {
    "docker-compose.amd64.yml"
}

function Assert-ComposeFiles {
    $required = @("docker-compose.yml", $archFile, "docker-compose.web.yml", "make.ps1", "scripts\setup.ps1")
    $missing = @($required | Where-Object { -not (Test-Path -LiteralPath (Join-Path $repoRoot $_)) })
    if ($missing.Count -gt 0) {
        Write-Line "ERROR: incomplete checkout - missing: $($missing -join ', ')" "Red"
        Write-Line "  Run .\deploy.ps1 from the repository root (currently: $repoRoot)." "DarkGray"
        exit 1
    }
}

function Assert-Docker {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        Write-Line "ERROR: Docker is not installed or not on PATH." "Red"
        Write-Line "  Install Docker Desktop and enable Linux containers:" "DarkGray"
        Write-Line "  https://docs.docker.com/desktop/install/windows-install/" "DarkGray"
        exit 1
    }

    docker compose version 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Die "Docker Compose v2 is required (the 'docker compose' subcommand, not 'docker-compose')."
    }

    $serverOs = (docker version --format "{{.Server.Os}}" 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($serverOs)) {
        Write-Line "ERROR: the Docker daemon is not reachable." "Red"
        Write-Line "  Start Docker Desktop and wait for it to report 'Engine running', then re-run." "DarkGray"
        exit 1
    }

    # The whole stack is Linux-only; Windows container mode fails much later
    # with confusing image-manifest errors.
    if ($serverOs -ne "linux") {
        Write-Line "ERROR: this stack requires Linux containers (Docker server OS: $serverOs)." "Red"
        Write-Line "  Right-click the Docker Desktop tray icon -> 'Switch to Linux containers...'" "DarkGray"
        exit 1
    }
}

# Steam downloads the whole B42 server; a thin disk fills up mid-build.
function Test-DiskSpace {
    try {
        $driveName = (Get-Item -LiteralPath $repoRoot).PSDrive.Name
        $free = (Get-PSDrive -Name $driveName -ErrorAction Stop).Free
    } catch {
        return
    }
    if ($null -eq $free) { return }
    $freeGb = [math]::Floor($free / 1GB)
    if ($freeGb -lt 10) {
        Write-Warn "only $freeGb GiB free on $repoRoot - the game server download plus images needs ~10 GiB."
    }
}

# -- make.ps1 delegation -----------------------------------------------------
function Invoke-Make {
    param(
        [string]$Target,
        [string[]]$Extra = @(),
        [switch]$IgnoreExitCode
    )
    $global:LASTEXITCODE = 0
    $makeArgs = @($Target) + $Extra
    & (Join-Path $repoRoot "make.ps1") @makeArgs
    if (-not $IgnoreExitCode -and $LASTEXITCODE -ne 0) {
        throw "make.ps1 $Target exited with code $LASTEXITCODE"
    }
}

function Invoke-Wizard {
    # setup.ps1 prompts; a redirected stdin would read EOF and abort halfway.
    if (-not $Yes -and [Console]::IsInputRedirected) {
        Write-Line "ERROR: the setup wizard needs an interactive terminal." "Red"
        Write-Line "  Run .\deploy.ps1 -Init from a terminal, or pass -Yes to accept defaults." "DarkGray"
        exit 1
    }
    if ($Yes) {
        $env:PZ_SETUP_ASSUME_YES = "1"
    }
    Write-Line "Running first-time setup (wizard)..." "Yellow"
    Write-Line "  Defaults: B42 Stable (public), local panel on :$webUiPort" "DarkGray"
    if ($Yes) {
        Write-Line "  Non-interactive mode (-Yes): auto-accepting defaults." "DarkGray"
    } else {
        Write-Line "  Press Enter through prompts to accept defaults." "DarkGray"
    }
    Write-Host ""
    Invoke-Make "init"
}

# -- Dispatch ----------------------------------------------------------------
try {
    $script:CurrentStage = "preflight"
    Assert-ComposeFiles
    Assert-Docker

    $script:CurrentStage = $cmd

    switch ($cmd) {
        "status" {
            Invoke-Make "info"
            Invoke-Make "ps"
            exit 0
        }
        "ps" {
            Invoke-Make "ps"
            exit 0
        }
        "logs" {
            Write-Step "Following logs (Ctrl-C to stop)..."
            # Ctrl-C out of `logs -f` is a normal exit, not a deploy failure.
            Invoke-Make "logs" $services -IgnoreExitCode
            exit 0
        }
        "restart" {
            $what = if ($services.Count -gt 0) { $services -join ' ' } else { "all services" }
            Write-Step "Restarting $what..."
            Invoke-Make "restart" $services
            Invoke-Make "info"
            exit 0
        }
        "down" {
            Invoke-Make "down"
            exit 0
        }
        "rebuild-game" {
            Invoke-Make "rebuild-game"
            exit 0
        }
        "init" {
            Test-DiskSpace
            Invoke-Wizard
            exit 0
        }
    }

    # -- Default: deploy -----------------------------------------------------
    Write-Host ""
    Write-Line "====================================================" "Cyan"
    Write-Line "  Project Zomboid B42 - Full Stack Deploy" "Cyan"
    Write-Line "  Game server + web panel + RCON + backups" "Cyan"
    Write-Line "====================================================" "Cyan"
    Write-Host ""

    Test-DiskSpace

    if (-not (Test-Path -LiteralPath (Join-Path $repoRoot ".env")) -or
        -not (Test-Path -LiteralPath (Join-Path $repoRoot "app\.env"))) {
        $script:CurrentStage = "setup wizard"
        Invoke-Wizard
        exit 0
    }

    $startedAt = Get-Date
    Write-Line "Environment found - starting / redeploying stack..." "Green"
    Write-Line "(Progress lines below come from make.ps1; builds can take a few minutes.)" "DarkGray"
    Write-Host ""

    $script:CurrentStage = "stack build/start"
    if ($cmd -eq "rebuild") {
        Invoke-Make "rebuild"
    } else {
        Invoke-Make "up"
    }

    $elapsed = (Get-Date) - $startedAt
    Write-Host ""
    Write-Ok ("Deploy finished in {0}m {1}s." -f [int][math]::Floor($elapsed.TotalMinutes), $elapsed.Seconds)
    Invoke-Make "info"
}
catch {
    Write-Host ""
    Write-Line "Failed during: $($script:CurrentStage)" "Red"
    Write-Line "  $($_.Exception.Message)" "DarkGray"
    if ($_.InvocationInfo -and $_.InvocationInfo.ScriptName) {
        $where = Split-Path -Leaf $_.InvocationInfo.ScriptName
        Write-Line "  At:      ${where}:$($_.InvocationInfo.ScriptLineNumber)" "DarkGray"
    }
    Write-Host ""
    Write-Line "  Inspect the stack:  .\deploy.ps1 -Ps" "DarkGray"
    Write-Line "  Read the logs:      .\deploy.ps1 -Logs" "DarkGray"
    Write-Line "  Stop and retry:     .\deploy.ps1 -Down ; .\deploy.ps1" "DarkGray"
    exit 1
}
