#Requires -Version 5.1
<#
.SYNOPSIS
    Zomboid Manager - PowerShell equivalent of Makefile for Windows.
.DESCRIPTION
    Run: .\make.ps1 <command>
    Example: .\make.ps1 up
             .\make.ps1 logs game-server
             .\make.ps1 init
.NOTES
    Requires Docker CLI + Compose with a Linux container backend.
#>

param(
    [Parameter(Position = 0)]
    [string]$Command = "help",

    [Parameter(Position = 1, ValueFromRemainingArguments)]
    [string[]]$CmdArgs
)

$ErrorActionPreference = "Continue"

# Service names (or extra args) that follow the command, e.g.
#   .\make.ps1 logs game-server web-api
# Kept separate from $CmdArgs so `exec` keeps its own raw argument handling.
$script:PassthruArgs = @()
if ($CmdArgs) {
    $script:PassthruArgs = @($CmdArgs | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
}

# Per-container stop timeout. game-server sets stop_grace_period: 60s, so an
# unbounded stop looks like a hang; mirror PZ_STOP_TIMEOUT from compose-env.sh.
function Get-StopTimeout {
    if ($env:PZ_STOP_TIMEOUT) { return "$($env:PZ_STOP_TIMEOUT)" }
    return "15"
}

# ── Architecture detection ──────────────────────────────────────────
$arch = if ([System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture -eq [System.Runtime.InteropServices.Architecture]::Arm64) {
    "aarch64"
} else {
    "x86_64"
}

$ArchFile = if ($arch -eq "aarch64") { "docker-compose.arm64.yml" } else { "docker-compose.amd64.yml" }

function Get-WebProxyMode {
    $mode = $env:WEB_PROXY_MODE
    if (-not $mode -and (Test-Path ".env")) {
        $line = Select-String -Path ".env" -Pattern '^WEB_PROXY_MODE=' | Select-Object -Last 1
        if ($line) { $mode = ($line.Line -split '=', 2)[1].Trim().Trim('"').Trim("'") }
    }
    $mode = if ($mode) { $mode.ToLowerInvariant() } else { "local" }
    switch -Regex ($mode) {
        '^(caddy|ports)$' { return "caddy" }
        '^(npm|external|proxy|traefik)$' { return "npm" }
        default { return "local" }
    }
}

function Get-ComposeArgs {
    $args = @("compose", "-f", "docker-compose.yml", "-f", $ArchFile, "-f", "docker-compose.web.yml")
    switch (Get-WebProxyMode) {
        "caddy" {
            $args += @("-f", "docker-compose.web-caddy.yml", "--profile", "caddy")
        }
        "npm" {
            $args += @("-f", "docker-compose.web-npm.yml")
        }
    }
    return $args
}

$ComposeArgs = Get-ComposeArgs

# ── Port defaults (override via env vars) ───────────────────────────
$PZ_GAME_PORT   = if ($env:PZ_GAME_PORT)   { $env:PZ_GAME_PORT }   else { "16261" }
$PZ_DIRECT_PORT = if ($env:PZ_DIRECT_PORT) { $env:PZ_DIRECT_PORT } else { "16262" }
# The admin UI is web-ui, published on this port by docker-compose.web.yml.
$WEB_UI_PORT    = if ($env:WEB_UI_PORT)    { $env:WEB_UI_PORT }    else { "8100" }

# ── Helpers ─────────────────────────────────────────────────────────
function Ensure-DataDirs {
    $dirs = @(
        "data\zomboid",
        "data\zomboid\Lua",
        "data\server",
        "data\backups",
        "data\map-tiles",
        "data\map-tiles\html\map_data\base",
        "data\server\media\texturepacks",
        "data\postgres",
        "data\redis",
        "data\caddy-data",
        "data\caddy-config",
        "data\web-postgres"
    )
    foreach ($d in $dirs) {
        if (-not (Test-Path $d)) {
            New-Item -ItemType Directory -Force -Path $d | Out-Null
        }
    }
    $info = "data\map-tiles\html\map_data\base\map_info.json"
    $vanilla = "web\tools\map-tiles\map_info.vanilla.json"
    if (-not (Test-Path $info) -and (Test-Path $vanilla)) {
        Copy-Item $vanilla $info
    }
}

function Ensure-Networks {
    docker network inspect proxy-network 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Creating external Docker network: proxy-network" -ForegroundColor Yellow
        docker network create proxy-network | Out-Null
    }
}

# pz-app and pz-queue no longer exist; they stay so an upgrade from an install
# that predates c318e99 still has its old containers cleaned up.
$script:StackContainers = @(
    "pz-app", "pz-queue", "pz-game-server", "pz-db",
    "pz-redis", "pz-docker-proxy", "pz-caddy",
    "pz-web-db", "pz-web-api", "pz-web-ui", "pz-data-init"
)

function Remove-StackContainers {
    $timeout = Get-StopTimeout
    $any = $false
    foreach ($name in $script:StackContainers) {
        docker container inspect $name 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) {
            $any = $true
            $state = (docker inspect -f "{{.State.Status}}" $name 2>$null | Out-String).Trim()
            if (-not $state) { $state = "unknown" }
            Write-Host "  [$name] status=$state - stop -t $timeout..." -ForegroundColor Yellow
            docker stop -t $timeout $name 2>$null | Out-Null
            docker rm -f $name 2>$null | Out-Null
            Write-Host "  [$name] removed" -ForegroundColor DarkGray
        }
    }
    if (-not $any) {
        Write-Host "  (no leftover stack containers)" -ForegroundColor DarkGray
    }
}

function Invoke-Compose {
    param([string[]]$Arguments)
    Assert-DockerEnvironment
    Ensure-DataDirs
    $script:ComposeArgs = Get-ComposeArgs
    if ($Arguments.Count -gt 0 -and $Arguments[0] -in @("up", "run")) {
        Ensure-Networks
        Write-Host "  Web proxy mode: $(Get-WebProxyMode)" -ForegroundColor DarkGray
        Remove-StackContainers
    }
    # For "down", include all web overlays + caddy profile so containers always stop
    $baseArgs = $script:ComposeArgs
    if ($Arguments.Count -gt 0 -and $Arguments[0] -eq "down") {
        $baseArgs = @(
            "compose",
            "-f", "docker-compose.yml",
            "-f", $ArchFile,
            "-f", "docker-compose.web.yml",
            "-f", "docker-compose.web-caddy.yml",
            "-f", "docker-compose.web-npm.yml",
            "--profile", "caddy"
        )
        $timeout = Get-StopTimeout
        # Stop by name first: `compose down` on its own waits out game-server's
        # 60s stop_grace_period with no output and reads as a hang.
        Write-Host "  Step 1/3: stop/remove known containers..." -ForegroundColor DarkGray
        Remove-StackContainers
        $downArgs = @("down", "-t", $timeout, "--remove-orphans") + @($Arguments | Select-Object -Skip 1)
        $allArgs = $baseArgs + $downArgs
        Write-Host "  Step 2/3: > docker $($allArgs -join ' ')" -ForegroundColor DarkGray
        & docker @allArgs
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  (compose down reported an error - continuing with force cleanup)" -ForegroundColor Yellow
        }
        Write-Host "  Step 3/3: final container sweep..." -ForegroundColor DarkGray
        Remove-StackContainers
        Write-Host "Stack stopped." -ForegroundColor Green
        return
    }
    $allArgs = $baseArgs + $Arguments
    Write-Host "  > docker $($allArgs -join ' ')" -ForegroundColor DarkGray
    & docker @allArgs
    if ($LASTEXITCODE -ne 0) { throw "Command failed with exit code $LASTEXITCODE" }
}

function Assert-DockerEnvironment {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        throw "Docker CLI was not found in PATH. Install Docker and try again."
    }

    docker compose version 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Docker Compose v2 is required. Install Docker Compose and try again."
    }

    $serverOs = (docker version --format "{{.Server.Os}}" 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($serverOs)) {
        throw "Docker is not reachable. Start your Docker backend and try again."
    }

    if ($serverOs -ne "linux") {
        throw "This stack requires Linux containers. Current Docker server OS: $serverOs. Windows container mode is not supported."
    }
}

function Invoke-CompatibleWebRequest {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Uri,

        [int]$TimeoutSec = 5
    )

    $params = @{
        Uri        = $Uri
        TimeoutSec = $TimeoutSec
    }

    if ($PSVersionTable.PSEdition -eq "Desktop") {
        $params.UseBasicParsing = $true
    }

    return Invoke-WebRequest @params
}

function Test-VolumeExists {
    param([string]$Name)
    docker volume inspect $Name 2>$null | Out-Null
    return $LASTEXITCODE -eq 0
}

function Confirm-AdminPrivileges {
    $identity = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    if (-not $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        Write-Host "Error: This command requires Administrator privileges. Run PowerShell as Administrator." -ForegroundColor Red
        return $false
    }
    return $true
}

function Ensure-DbVolume {
    # Postgres is bind-mounted at ./data/postgres
    Ensure-DataDirs
}

# ── Commands ────────────────────────────────────────────────────────

function Do-Init {
    Write-Host ""
    Write-Host "Starting setup wizard..." -ForegroundColor Cyan
    Assert-DockerEnvironment
    & (Join-Path $PSScriptRoot "scripts\setup.ps1")
    if ($LASTEXITCODE -ne 0) { throw "Setup wizard failed with exit code $LASTEXITCODE" }
}

function Do-Deploy {
    if (-not (Test-Path ".env")) {
        Write-Host "Environment files not found. Running first-time setup..." -ForegroundColor Yellow
        Do-Init
        return
    }

    Write-Host "Starting services..." -ForegroundColor Cyan
    Do-Up
    Write-Host ""
    Do-Info
}

function Do-Up {
    Ensure-DbVolume
    Invoke-Compose @("up", "-d", "--build", "--remove-orphans")
}

function Do-Down {
    Invoke-Compose @("down")
}

function Do-Build {
    Invoke-Compose @("build")
}

function Do-Restart {
    Invoke-Compose (@("restart") + $script:PassthruArgs)
}

# Rebuild the local fixed images on top of their upstream bases, then start.
function Do-Rebuild {
    Write-Host "Rebuilding images from upstream bases (--pull)..." -ForegroundColor Cyan
    Invoke-Compose @("build", "--pull", "web-api", "web-ui", "game-server")
    Do-Up
}

# Rebuild only the game-server overlay (upstream base + our entrypoints).
function Do-RebuildGame {
    Write-Host "Rebuilding game-server local image from upstream base..." -ForegroundColor Cyan
    Invoke-Compose @("build", "--pull", "game-server")
    Invoke-Compose @("up", "-d", "game-server")
}

# Renders the isometric basemap from the game files into data\map-tiles.
# Takes hours and about 15 GB. Safe to interrupt; re-run to resume.
# Cells/squares for a regional job, from the args after the command.
#
# NOT the automatic $Args: this script has an explicit param() block, so $Args
# is always empty here and the region targets silently rendered the whole
# county (hours, ~15 GB, overwrites the pack) instead of one cell. The
# Makefile refuses an empty CELLS/SQUARES; do the same rather than fall
# through to a full render.
function Get-RegionArg {
    param([string]$Target)
    # PowerShell's argument mode treats an unquoted `41,38` as an array, so the
    # rect reaches here either as several elements or as one space-joined
    # string ("41 38"). Both mean the same thing the Makefile spells CELLS=41,38.
    # Put the commas back; a quoted "41,38;42,39" has no whitespace and passes
    # through untouched.
    $joined = ($script:PassthruArgs -join ",")
    $joined = ($joined -replace '\s+', ',') -replace ',+', ','
    $joined = $joined.Trim(',')
    if ([string]::IsNullOrWhiteSpace($joined)) {
        Write-Host "set cells or squares, e.g. .\make.ps1 $Target 41,38" -ForegroundColor Red
        Write-Host "                      or  .\make.ps1 $Target squares=8704,7680,256,256" -ForegroundColor Red
        exit 1
    }
    return $joined
}

function Do-MapTiles {
    param(
        [string]$Cells = "",
        [string]$Squares = "",
        [string]$Detail = "",
        [switch]$DetailOnly,
        [switch]$HealOnly
    )

    if ($HealOnly -and -not (Test-Path "data\map-tiles\tiles.sqlite")) {
        Write-Host "need data\map-tiles\tiles.sqlite (the original county pack, left there after import)" -ForegroundColor Red
        exit 1
    }

    if ($Squares -or $Cells) {
        $what = if ($Squares) { "squares $Squares" } else { "cells $Cells" }
        if ($HealOnly) {
            Write-Host "Copying original tiles over $what (seconds; no re-render)..." -ForegroundColor Cyan
        } elseif ($DetailOnly) {
            Write-Host "Filling z21 for $what (minutes; leaves z20 in place)..." -ForegroundColor Cyan
        } else {
            Write-Host "Redrawing map $what from the live save (minutes; updates the existing pack)..." -ForegroundColor Cyan
        }
    } else {
        Write-Host "Rendering the isometric basemap from the game files (hours, ~15 GB)..." -ForegroundColor Cyan
    }
    # Docker cannot create a mountpoint inside a read-only bind mount, and /pz
    # is one. Without this the run dies on "read-only file system" before it
    # reaches the texture check.
    New-Item -ItemType Directory -Force "data\server\media\texturepacks" | Out-Null
    Invoke-Compose @("--profile", "tools", "build", "map-tiles")
    # --no-deps --use-aliases matches the Makefile: compose must not start
    # game-server, and the render container needs the service's network alias
    # to reach it over RCON.
    $run = @("--profile", "tools", "run", "--rm", "--no-deps", "--use-aliases",
             "-e", "PZ_MAP_CELLS=$Cells", "-e", "PZ_MAP_SQUARES=$Squares")
    if ($HealOnly) {
        $run += @("-e", "PZ_MAP_HEAL_ONLY=1")
    } elseif ($DetailOnly) {
        $run += @("-e", "PZ_MAP_DETAIL_ONLY=1", "-e", "PZ_MAP_DETAIL=21")
    } elseif ($Detail) {
        $run += @("-e", "PZ_MAP_DETAIL=$Detail", "-e", "PZ_MAP_SAVE=1")
    } elseif ($Squares -or $Cells) {
        $run += @("-e", "PZ_MAP_DETAIL=21", "-e", "PZ_MAP_SAVE=1")
    }
    $run += @("map-tiles")
    # `Invoke-Compose $run`, NOT `@run`. Invoke-Compose is a PowerShell
    # function taking one [string[]]; splatting a plain array into it binds
    # only the first element and drops the rest into the automatic $args,
    # where they are silently ignored. That shipped `docker compose -f ...
    # --profile` with nothing after it -- "flag needs an argument: --profile"
    # -- so every regional render died before it started a container.
    Invoke-Compose $run
}

function Do-MapTilesRecompress {
    Write-Host "Recompressing packed JPEGs at quality 70 (WAL, no VACUUM)..." -ForegroundColor Cyan
    Invoke-Compose @("--profile", "tools", "build", "map-tiles")
    Invoke-Compose @("--profile", "tools", "run", "--rm", "--entrypoint", "python", "map-tiles", "/tools/recompress.py", "/pack/tiles.sqlite")
}

# Copy an existing host pack into the named volume. Run with web-api down, or
# against an empty volume — overwriting a live open sqlite is the Windows
# filename-reservation trap again. Prints size / percent / ETA while it copies.
function Do-MapTilesImport {
    $src = Join-Path (Get-Location) "data\map-tiles\tiles.sqlite"
    if (-not (Test-Path $src)) {
        Write-Host "no data\map-tiles\tiles.sqlite to import" -ForegroundColor Red
        exit 1
    }
    $hostDir = (Resolve-Path "data\map-tiles").Path
    $script = (Resolve-Path "web\tools\map-tiles\import.sh").Path
    Write-Host "Importing $src into volume pz-map-tiles-sqlite..." -ForegroundColor Cyan
    docker volume create pz-map-tiles-sqlite | Out-Null
    # -t only when this is a real console. That is what makes isatty(2) true
    # inside Alpine so import.sh can rewrite one line instead of printing more.
    $run = @("--rm")
    if (-not [Console]::IsOutputRedirected) {
        $run += "-t"
    }
    $cols = 80
    try {
        if ([Console]::WindowWidth -gt 0) {
            $cols = [Console]::WindowWidth
        }
    } catch { }
    $run += @("-e", "COLUMNS=$cols")
    if ($env:NO_COLOR) {
        $run += @("-e", "NO_COLOR=$($env:NO_COLOR)")
    }
    if ($env:TERM) {
        $run += @("-e", "TERM=$($env:TERM)")
    } else {
        $run += @("-e", "TERM=xterm-256color")
    }
    $run += @(
        "-v", "pz-map-tiles-sqlite:/pack",
        "-v", "${hostDir}:/src:ro",
        "-v", "${script}:/import.sh:ro",
        "alpine:3.20", "sh", "/import.sh"
    )
    docker run @run
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

function Do-Stop {
    Invoke-Compose @("stop")
}

function Do-Logs {
    # Don't use Invoke-Compose - Ctrl+C exit code is non-zero and that's OK
    $allArgs = $script:ComposeArgs + @("logs", "-f", "--tail", "200") + $script:PassthruArgs
    Write-Host "  > docker $($allArgs -join ' ')" -ForegroundColor DarkGray
    & docker @allArgs
}

function Do-Ps {
    Invoke-Compose @("ps")
}

function Do-Pull {
    Invoke-Compose @("pull")
}

# migrate, test and exec drove the Laravel app container, parked in c318e99.
# They fail loudly rather than silently targeting a service that is not there.
function Do-Migrate {
    Write-Host "There is no migrate step any more." -ForegroundColor Yellow
    Write-Host "  web-api runs its sqlx migrations itself at start-up, so bringing the"
    Write-Host "  container up is what applies them:  .\make.ps1 restart web-api"
    exit 1
}

function Do-Test {
    Write-Host "The Laravel suite went away with the app container in c318e99." -ForegroundColor Yellow
    Write-Host "  cd web/api; cargo test --workspace   Rust API tests"
    Write-Host "  .\make.ps1 test-game-server          host-side shell and Lua suites"
    exit 1
}

# Host-side shell suites. No containers needed: they run the real scripts
# against throwaway trees, so they work before the stack is even up.
function Do-TestGameServer {
    # Resolve Git Bash deliberately. A bare "bash" on PATH is usually WSL's
    # shim in System32, which cannot see this working directory and fails with
    # a disk-attach error before any test runs.
    $bash = $null
    $git = Get-Command git -ErrorAction SilentlyContinue
    if ($git) {
        $gitRoot = Split-Path (Split-Path $git.Source -Parent) -Parent
        $candidate = Join-Path (Join-Path $gitRoot "bin") "bash.exe"
        if (Test-Path $candidate) { $bash = $candidate }
    }
    if (-not $bash) {
        foreach ($candidate in @("C:/Program Files/Git/bin/bash.exe", "C:/Program Files (x86)/Git/bin/bash.exe")) {
            if (Test-Path $candidate) { $bash = $candidate; break }
        }
    }
    if (-not $bash) {
        Write-Host "Git Bash not found - install Git for Windows to run the shell suites" -ForegroundColor Red
        return
    }

    $failed = $false
    foreach ($suite in @("configure-server.test.sh", "steam-update-check.test.sh")) {
        Write-Host "Running $suite" -ForegroundColor Cyan
        & $bash "game-server/tests/$suite"
        if ($LASTEXITCODE -ne 0) { $failed = $true }
    }

    if (Get-Command luajit -ErrorAction SilentlyContinue) {
        foreach ($suite in @("kr-vitals", "kr-enrol", "kr-report", "kr-console", "kr-desk")) {
            & luajit "game-server/tests/$suite.test.lua"
            if ($LASTEXITCODE -ne 0) { $failed = $true }
        }
    } else {
        Write-Host "SKIP: Lua suites need luajit (PZ runs Lua 5.1)" -ForegroundColor Yellow
    }

    if ($failed) { exit 1 }
}

function Do-Exec {
    Write-Host "There is no app container to exec into - it was parked in c318e99." -ForegroundColor Yellow
    Write-Host "  To run something in a service that does exist, name it:"
    Write-Host "    docker compose exec web-api <cmd>"
    Write-Host "    docker compose exec game-server <cmd>"
    exit 1
}

function Do-Arch {
    Write-Host "Detected: $arch -> $ArchFile"
}

function Do-Info {
    $publicIp = try { (Invoke-CompatibleWebRequest -Uri "https://api.ipify.org" -TimeoutSec 5).Content.Trim() } catch { "" }

    Write-Host ""
    Write-Host ([char]0x2554 + ([string][char]0x2550 * 46) + [char]0x2557) -ForegroundColor Cyan
    Write-Host ([char]0x2551 + "          Zomboid Manager - Status            " + [char]0x2551) -ForegroundColor Cyan
    Write-Host ([char]0x255A + ([string][char]0x2550 * 46) + [char]0x255D) -ForegroundColor Cyan
    Write-Host ""
    # Mirrors pz_info in scripts/compose-env.sh, which make and deploy.sh share.
    # This copy exists only because PowerShell cannot source that bash; keep the
    # two outputs in step when either changes.
    $mode = Get-WebProxyMode
    Write-Host "  Local Admin:   http://localhost:$WEB_UI_PORT"
    Write-Host "  Web mode:      $mode"
    switch ($mode) {
        "caddy" { Write-Host "  Public Admin:  Caddy on host ports 80/443" }
        "npm" {
            Write-Host "  Public Admin:  via Nginx Proxy Manager on proxy-network"
            Write-Host "                 Forward to: http://pz-web-ui:8080"
        }
        default { Write-Host "  Public Admin:  disabled (localhost only)" }
    }

    if (Test-Path ".firewall.conf") {
        $conf = Get-Content ".firewall.conf" | Where-Object { $_ -match "=" -and $_ -notmatch "^\s*#" }
        $fwVars = @{}
        foreach ($line in $conf) {
            $parts = $line -split "=", 2
            $key = $parts[0].Trim()
            $val = $parts[1].Trim().Trim("'", '"')
            $fwVars[$key] = $val
        }
        $httpPort  = if ($fwVars["ADMIN_HTTP_PORT"])  { $fwVars["ADMIN_HTTP_PORT"] }  else { "80" }
        $httpsPort = if ($fwVars["ADMIN_HTTPS_PORT"]) { $fwVars["ADMIN_HTTPS_PORT"] } else { "443" }
        $publicHost = $fwVars["ADMIN_PUBLIC_HOST"]
        if ($publicHost -and $publicHost -ne "localhost") {
            $url = if ($httpsPort -eq "443") { "https://$publicHost" } else { "https://${publicHost}:$httpsPort" }
            Write-Host "  Public host:   $url  (requires '.\make.ps1 admin-expose')"
        }
        Write-Host "  Caddy Ports:   $httpPort (HTTP) / $httpsPort (HTTPS)"
        Write-Host "  Firewall:      $($fwVars['FIREWALL_BACKEND'])"
    } else {
        Write-Host "  Firewall:      not configured"
    }

    if ($publicIp) {
        Write-Host "  Public IP:     $publicIp"
    } else {
        Write-Host "  Public IP:     unavailable"
    }
    Write-Host "  Game Ports:    $PZ_GAME_PORT/udp, $PZ_DIRECT_PORT/udp"
    Write-Host "  Data dir:      $((Get-Location).Path)\data\"
    Write-Host ""
    Write-Host "  Containers:"
    $psArgs = $script:ComposeArgs + @("ps", "--format", "table {{.Name}}`t{{.Status}}`t{{.Ports}}")
    & docker @psArgs
    Write-Host ""
    Write-Host "  Open game ports to remote players:  .\make.ps1 expose"
    Write-Host "  Open public admin access:           .\make.ps1 admin-expose"
    Write-Host ""
}

function Do-DbCheck {
    Assert-DockerEnvironment
    Ensure-DbVolume
}

function Do-DbInit {
    Assert-DockerEnvironment
    Ensure-DataDirs
    Write-Host "Postgres data dir: ./data/postgres (bind mount). Run '.\make.ps1 up' to start."
}

function Do-DbReset {
    Assert-DockerEnvironment
    Write-Host "WARNING: This will PERMANENTLY delete ./data/postgres." -ForegroundColor Red
    $confirm = Read-Host "Type RESET_DB and press Enter to continue"
    if ($confirm -ne "RESET_DB") {
        Write-Host "Cancelled."
        return
    }
    Invoke-Compose @("down")
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue "data\postgres"
    New-Item -ItemType Directory -Force -Path "data\postgres" | Out-Null
    Write-Host "Postgres data dir recreated. Run '.\make.ps1 up' to start with an empty DB."
}

function Do-DbBackup {
    Assert-DockerEnvironment
    if (-not (Test-Path "db-backups")) { New-Item -ItemType Directory -Path "db-backups" | Out-Null }
    $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $backupFile = "db-backups\backup-$timestamp.sql"
    $stderrFile = [System.IO.Path]::GetTempFileName()
    Write-Host "Backing up database..."
    try {
        $process = Start-Process -FilePath "docker" `
            -ArgumentList @("exec", "pz-db", "pg_dump", "-U", "zomboid", "-d", "zomboid", "--no-owner") `
            -RedirectStandardOutput $backupFile `
            -RedirectStandardError $stderrFile `
            -NoNewWindow `
            -PassThru `
            -Wait

        if ($process.ExitCode -eq 0 -and (Test-Path $backupFile) -and (Get-Item $backupFile).Length -gt 0) {
            Write-Host "Backup saved to $backupFile"
        } else {
            Remove-Item -Force -ErrorAction SilentlyContinue $backupFile
            Write-Host "No database to backup (first run?)" -ForegroundColor Yellow
        }
    } finally {
        Remove-Item -Force -ErrorAction SilentlyContinue $stderrFile
    }
}

function Do-DbRestore {
    Assert-DockerEnvironment
    if (-not (Test-Path "db-backups") -or -not (Get-ChildItem "db-backups\*.sql" -ErrorAction SilentlyContinue)) {
        Write-Host "No backups found in db-backups\"
        return
    }
    $latest = Get-ChildItem "db-backups\*.sql" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    Write-Host "Restoring from $($latest.Name)..."
    # Use docker cp to avoid PowerShell pipe encoding issues
    docker cp $latest.FullName "pz-db:/tmp/restore.sql"
    docker exec pz-db psql -U zomboid -d zomboid -f /tmp/restore.sql
    docker exec pz-db rm /tmp/restore.sql
    Write-Host "Restored."
}

function Do-Nuke {
    Assert-DockerEnvironment
    Write-Host "WARNING: This will destroy ALL data (database, game saves, backups, config)." -ForegroundColor Red
    $confirm = Read-Host "Type NUKE_ALL and press Enter to continue"
    if ($confirm -ne "NUKE_ALL") {
        Write-Host "Cancelled."
        return
    }
    Invoke-Compose @("down", "--remove-orphans")
    # Remove leftover named volumes, but never the generated website map pack.
    $remaining = @(docker volume ls -q --filter "name=pz-" 2>$null | Where-Object { $_ -notmatch "map-tiles" })
    if ($remaining) {
        Write-Host "Removing leftover volumes: $remaining"
        $remaining | ForEach-Object { docker volume rm $_ 2>$null | Out-Null }
    }
    Write-Host "Keeping data\map-tiles and pz-map-tiles-sqlite (website map). Delete those by hand." -ForegroundColor Cyan
    if (Test-Path "data") {
        Write-Host "Removing host data under ./data except map-tiles ..." -ForegroundColor Yellow
        Get-ChildItem "data" -Force | Where-Object { $_.Name -ne "map-tiles" } | ForEach-Object {
            Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $_.FullName
        }
        Ensure-DataDirs
    }
    Remove-Item -Force -ErrorAction SilentlyContinue .env, .firewall.conf
    Remove-Item -Force -ErrorAction SilentlyContinue caddy\Caddyfile, caddy\certs\cert.pem, caddy\certs\key.pem
    Write-Host "Nuke complete. ./data and config removed." -ForegroundColor Green
}

# ── Firewall (Windows Firewall via netsh) ───────────────────────────

function Do-Expose {
    if (-not (Confirm-AdminPrivileges)) { return }
    Write-Host "Opening game ports in Windows Firewall..." -ForegroundColor Cyan
    # Remove existing rules first (idempotent)
    netsh advfirewall firewall delete rule name="PZ Game UDP $PZ_GAME_PORT" 2>$null | Out-Null
    netsh advfirewall firewall delete rule name="PZ Game UDP $PZ_DIRECT_PORT" 2>$null | Out-Null
    # Add rules
    netsh advfirewall firewall add rule name="PZ Game UDP $PZ_GAME_PORT" dir=in action=allow protocol=UDP localport=$PZ_GAME_PORT | Out-Null
    netsh advfirewall firewall add rule name="PZ Game UDP $PZ_DIRECT_PORT" dir=in action=allow protocol=UDP localport=$PZ_DIRECT_PORT | Out-Null
    Write-Host "  Opened UDP $PZ_GAME_PORT and $PZ_DIRECT_PORT" -ForegroundColor Green
    Write-Host ""
    Do-Info
}

function Do-Hide {
    if (-not (Confirm-AdminPrivileges)) { return }
    Write-Host "Closing game ports in Windows Firewall..." -ForegroundColor Cyan
    netsh advfirewall firewall delete rule name="PZ Game UDP $PZ_GAME_PORT" 2>$null | Out-Null
    netsh advfirewall firewall delete rule name="PZ Game UDP $PZ_DIRECT_PORT" 2>$null | Out-Null
    Write-Host "  Closed UDP $PZ_GAME_PORT and $PZ_DIRECT_PORT" -ForegroundColor Green
}

function Do-AdminExpose {
    if (-not (Confirm-AdminPrivileges)) { return }
    if (-not (Test-Path ".firewall.conf")) {
        Write-Host "Error: run '.\make.ps1 init' first." -ForegroundColor Red
        return
    }
    $conf = Get-Content ".firewall.conf" | Where-Object { $_ -match "=" -and $_ -notmatch "^\s*#" }
    $fwVars = @{}
    foreach ($line in $conf) {
        $parts = $line -split "=", 2
        $fwVars[$parts[0].Trim()] = $parts[1].Trim().Trim("'", '"')
    }
    $httpPort  = if ($fwVars["ADMIN_HTTP_PORT"])  { $fwVars["ADMIN_HTTP_PORT"] }  else { "80" }
    $httpsPort = if ($fwVars["ADMIN_HTTPS_PORT"]) { $fwVars["ADMIN_HTTPS_PORT"] } else { "443" }

    Write-Host "Opening admin ports in Windows Firewall..." -ForegroundColor Cyan
    netsh advfirewall firewall delete rule name="PZ Admin HTTP $httpPort" 2>$null | Out-Null
    netsh advfirewall firewall delete rule name="PZ Admin HTTPS $httpsPort" 2>$null | Out-Null
    netsh advfirewall firewall add rule name="PZ Admin HTTP $httpPort" dir=in action=allow protocol=TCP localport=$httpPort | Out-Null
    netsh advfirewall firewall add rule name="PZ Admin HTTPS $httpsPort" dir=in action=allow protocol=TCP localport=$httpsPort | Out-Null
    Write-Host "  Admin panel exposed on ports $httpPort (HTTP) / $httpsPort (HTTPS)" -ForegroundColor Green
    Write-Host "  Local:  http://localhost:$WEB_UI_PORT"
}

function Do-AdminHide {
    if (-not (Confirm-AdminPrivileges)) { return }
    if (-not (Test-Path ".firewall.conf")) {
        Write-Host "Error: run '.\make.ps1 init' first." -ForegroundColor Red
        return
    }
    $conf = Get-Content ".firewall.conf" | Where-Object { $_ -match "=" -and $_ -notmatch "^\s*#" }
    $fwVars = @{}
    foreach ($line in $conf) {
        $parts = $line -split "=", 2
        $fwVars[$parts[0].Trim()] = $parts[1].Trim().Trim("'", '"')
    }
    $httpPort  = if ($fwVars["ADMIN_HTTP_PORT"])  { $fwVars["ADMIN_HTTP_PORT"] }  else { "80" }
    $httpsPort = if ($fwVars["ADMIN_HTTPS_PORT"]) { $fwVars["ADMIN_HTTPS_PORT"] } else { "443" }

    netsh advfirewall firewall delete rule name="PZ Admin HTTP $httpPort" 2>$null | Out-Null
    netsh advfirewall firewall delete rule name="PZ Admin HTTPS $httpsPort" 2>$null | Out-Null
    Write-Host "Admin panel restricted to local access." -ForegroundColor Green
    Write-Host "  Local:  http://localhost:$WEB_UI_PORT"
}

function Do-UpdateVersion {
    Write-Host "Current version:"
    if (Test-Path "game-version.conf") {
        $content = Get-Content "game-version.conf"
        foreach ($line in $content) {
            if ($line -match "^PZ_VERSION=(.+)") { Write-Host "  $($Matches[1])" }
            if ($line -match "^PZ_VERSION_FULL=(.+)") { Write-Host "  $($Matches[1])" }
        }
    } else {
        Write-Host "  (not set)"
    }
    Write-Host ""
    Write-Host "Paste the full version string from the game"
    Write-Host '(e.g. 42.16.1 679520210a22497d1cb91ca6105ed544637604c6 2026-04-02 14:57:34 (ZB))'
    Write-Host ""
    $full = Read-Host ">"
    if (-not $full) { Write-Host "Cancelled."; return }
    if ($full -match "^(\d+\.\d+(\.\d+)*)") {
        $ver = $Matches[1]
    } else {
        Write-Host "Error: could not parse version number." -ForegroundColor Red
        return
    }
    $content = Get-Content "game-version.conf"
    $content = $content -replace "^PZ_VERSION=.*", "PZ_VERSION=$ver"
    $content = $content -replace "^PZ_VERSION_FULL=.*", "PZ_VERSION_FULL=$full"
    [System.IO.File]::WriteAllLines("game-version.conf", $content, [System.Text.UTF8Encoding]::new($false))
    Write-Host ""
    Write-Host "Updated game-version.conf:"
    Write-Host "  PZ_VERSION=$ver"
    Write-Host "  PZ_VERSION_FULL=$full"
}

function Do-Help {
    Write-Host ""
    Write-Host "Zomboid Manager - Windows PowerShell Commands" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  Setup:" -ForegroundColor White
    Write-Host "    .\make.ps1 init             Interactive first-run setup wizard"
    Write-Host "    .\make.ps1 setup            Alias for init"
    Write-Host "    .\make.ps1 deploy           Start services, or run init if env is missing"
    Write-Host ""
    Write-Host "  Services:" -ForegroundColor White
    Write-Host "    .\make.ps1 up               Start services"
    Write-Host "    .\make.ps1 down             Stop services"
    Write-Host "    .\make.ps1 build            Build Docker images"
    Write-Host "    .\make.ps1 restart [svc...] Restart all services, or the named ones"
    Write-Host "    .\make.ps1 rebuild          Rebuild images from upstream bases, then start"
    Write-Host "    .\make.ps1 rebuild-game     Rebuild game-server only"
    Write-Host "    .\make.ps1 map-tiles        Render the isometric basemap locally (hours, ~15 GB)"
    Write-Host "    .\make.ps1 map-tiles-region x,y,w,h   Redraw cells (or squares=x,y,w,h) (minutes)"
    Write-Host "    .\make.ps1 map-tiles-detail x,y,w,h   Paint z21 for those cells (minutes)"
    Write-Host "    .\make.ps1 map-tiles-heal x,y         Copy original tiles over a damaged region (seconds)"
    Write-Host "    .\make.ps1 map-tiles-recompress  Re-encode packed JPEGs at quality 70"
    Write-Host "    .\make.ps1 map-tiles-import Copy data\map-tiles\tiles.sqlite into the named volume (prints progress)"
    Write-Host "    .\make.ps1 stop             Stop without removing containers"
    Write-Host "    .\make.ps1 logs [svc...]    Follow logs (all services, or the named ones)"
    Write-Host "    .\make.ps1 ps               List running containers"
    Write-Host "    .\make.ps1 pull             Pull latest images"
    Write-Host ""
    Write-Host "  Service names:" -ForegroundColor White
    Write-Host "    game-server  web-api  web-ui  web-db  db  redis  docker-socket-proxy"
    Write-Host ""
    Write-Host "  Firewall (Windows Firewall - requires Administrator):" -ForegroundColor White
    Write-Host "    .\make.ps1 expose           Open game ports (UDP)"
    Write-Host "    .\make.ps1 hide             Close game ports (UDP)"
    Write-Host "    .\make.ps1 admin-expose     Open admin HTTPS ports"
    Write-Host "    .\make.ps1 admin-hide       Close admin HTTPS ports"
    Write-Host ""
    Write-Host "  Database:" -ForegroundColor White
    Write-Host "    .\make.ps1 db-check         Check/create DB volume"
    Write-Host "    .\make.ps1 db-init          Create empty DB volume"
    Write-Host "    .\make.ps1 db-reset         Reset DB volume (DANGER)"
    Write-Host "    .\make.ps1 db-backup        Backup database"
    Write-Host "    .\make.ps1 db-restore       Restore latest backup"
    Write-Host ""
    Write-Host "  App:" -ForegroundColor White
    Write-Host '    .\make.ps1 migrate          Run database migrations'
    Write-Host '    .\make.ps1 test             Run tests'
    Write-Host '    .\make.ps1 test-game-server Run the host-side shell suites'
    Write-Host '    .\make.ps1 exec "CMD"       Run command in app container'
    Write-Host ""
    Write-Host "  Other:" -ForegroundColor White
    Write-Host "    .\make.ps1 info             Show URLs, IP, firewall status"
    Write-Host "    .\make.ps1 arch             Show detected CPU architecture"
    Write-Host "    .\make.ps1 update-version   Update game-version.conf"
    Write-Host "    .\make.ps1 nuke             Destroy ALL data (DANGER)"
    Write-Host ""
}

# ── Dispatch ────────────────────────────────────────────────────────
switch ($Command) {
    "init"           { Do-Init }
    "setup"          { Do-Init }
    "deploy"         { Do-Deploy }
    "up"             { Do-Up }
    "down"           { Do-Down }
    "build"          { Do-Build }
    "restart"        { Do-Restart }
    "rebuild"        { Do-Rebuild }
    "rebuild-game"   { Do-RebuildGame }
    "map-tiles"      { Do-MapTiles }
    "map-tiles-import" { Do-MapTilesImport }
    "map-tiles-recompress" { Do-MapTilesRecompress }
    "map-tiles-detail" {
        $joined = Get-RegionArg "map-tiles-detail"
        if ($joined -match '^squares=') {
            Do-MapTiles -Squares ($joined -replace '^squares=','') -DetailOnly
        } else {
            Do-MapTiles -Cells $joined -DetailOnly
        }
    }
    "map-tiles-region" {
        $joined = Get-RegionArg "map-tiles-region"
        if ($joined -match '^squares=') {
            Do-MapTiles -Squares ($joined -replace '^squares=','') -Detail "21"
        } else {
            Do-MapTiles -Cells $joined -Detail "21"
        }
    }
    "map-tiles-heal" {
        $joined = Get-RegionArg "map-tiles-heal"
        if ($joined -match '^squares=') {
            Do-MapTiles -Squares ($joined -replace '^squares=','') -HealOnly
        } else {
            Do-MapTiles -Cells $joined -HealOnly
        }
    }
    "stop"           { Do-Stop }
    "logs"           { Do-Logs }
    "ps"             { Do-Ps }
    "pull"           { Do-Pull }
    "migrate"        { Do-Migrate }
    "test"           { Do-Test }
    "test-game-server" { Do-TestGameServer }
    "exec"           { Do-Exec }
    "arch"           { Do-Arch }
    "info"           { Do-Info }
    "db-check"       { Do-DbCheck }
    "db-init"        { Do-DbInit }
    "db-reset"       { Do-DbReset }
    "db-backup"      { Do-DbBackup }
    "db-restore"     { Do-DbRestore }
    "nuke"           { Do-Nuke }
    "expose"         { Do-Expose }
    "hide"           { Do-Hide }
    "admin-expose"   { Do-AdminExpose }
    "admin-hide"     { Do-AdminHide }
    "update-version" { Do-UpdateVersion }
    "help"           { Do-Help }
    default {
        Write-Host "Unknown command: $Command" -ForegroundColor Red
        Write-Host "Run '.\make.ps1 help' for available commands."
        exit 1
    }
}
