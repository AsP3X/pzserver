#!/usr/bin/env bash
# Shared Docker Compose helpers (no Make required).
# shellcheck shell=bash
# Usage: source "$(dirname "$0")/compose-env.sh"   # from scripts/
#    or: source scripts/compose-env.sh             # from repo root

# Resolve repo root (directory that contains docker-compose.yml)
if [[ -z "${PZ_REPO_ROOT:-}" ]]; then
  if [[ -f docker-compose.yml ]]; then
    PZ_REPO_ROOT="$(pwd)"
  elif [[ -f "$(dirname "${BASH_SOURCE[0]}")/../docker-compose.yml" ]]; then
    PZ_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  else
    echo "ERROR: cannot find docker-compose.yml (run from repo root or source from scripts/)." >&2
    return 1 2>/dev/null || exit 1
  fi
fi

_arch="$(uname -m 2>/dev/null || echo x86_64)"
if [[ "$_arch" == "aarch64" || "$_arch" == "arm64" ]]; then
  PZ_COMPOSE_ARCH_FILE="docker-compose.arm64.yml"
else
  PZ_COMPOSE_ARCH_FILE="docker-compose.amd64.yml"
fi

# WEB_PROXY_MODE:
#   local  — panel only on 127.0.0.1:APP_PORT (default; no :80/:443)
#   caddy  — built-in Caddy publishes host HTTP/HTTPS ports
#   npm    — Nginx Proxy Manager / external proxy on proxy-network (no :80/:443)
pz_load_web_mode() {
  WEB_PROXY_MODE="${WEB_PROXY_MODE:-}"
  if [[ -z "$WEB_PROXY_MODE" && -f "${PZ_REPO_ROOT}/.env" ]]; then
    # shellcheck disable=SC1090
    WEB_PROXY_MODE="$(grep -E '^WEB_PROXY_MODE=' "${PZ_REPO_ROOT}/.env" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '\r' | tr -d '"' | tr -d "'")"
  fi
  WEB_PROXY_MODE="$(echo "${WEB_PROXY_MODE:-local}" | tr '[:upper:]' '[:lower:]')"
  case "$WEB_PROXY_MODE" in
    caddy|ports) WEB_PROXY_MODE="caddy" ;;
    npm|external|proxy|traefik) WEB_PROXY_MODE="npm" ;;
    local|none|off) WEB_PROXY_MODE="local" ;;
    *) WEB_PROXY_MODE="local" ;;
  esac
  export WEB_PROXY_MODE
}

# Build docker compose CLI args (-f / --profile) for the selected web mode.
pz_compose_cli_args() {
  pz_load_web_mode
  local args=(
    -f "${PZ_REPO_ROOT}/docker-compose.yml"
    -f "${PZ_REPO_ROOT}/${PZ_COMPOSE_ARCH_FILE}"
    -f "${PZ_REPO_ROOT}/docker-compose.web.yml"
  )
  case "$WEB_PROXY_MODE" in
    caddy)
      args+=(-f "${PZ_REPO_ROOT}/docker-compose.web-caddy.yml" --profile caddy)
      ;;
    npm)
      args+=(-f "${PZ_REPO_ROOT}/docker-compose.web-npm.yml")
      ;;
    local)
      ;;
  esac
  printf '%s\n' "${args[@]}"
}

pz_compose() {
  # Read line-by-line rather than with `mapfile`: macOS ships bash 3.2, where
  # mapfile does not exist and the args array would silently come back empty.
  local args=() line
  while IFS= read -r line; do
    [[ -n "$line" ]] && args+=("$line")
  done < <(pz_compose_cli_args)
  docker compose "${args[@]}" "$@"
}

pz_ensure_data_dirs() {
  mkdir -p \
    "${PZ_REPO_ROOT}/data/zomboid/Lua" \
    "${PZ_REPO_ROOT}/data/server" \
    "${PZ_REPO_ROOT}/data/backups" \
    "${PZ_REPO_ROOT}/data/map-tiles" \
    "${PZ_REPO_ROOT}/data/postgres" \
    "${PZ_REPO_ROOT}/data/redis" \
    "${PZ_REPO_ROOT}/data/app-vendor" \
    "${PZ_REPO_ROOT}/data/app-node-modules" \
    "${PZ_REPO_ROOT}/data/app-build" \
    "${PZ_REPO_ROOT}/data/caddy-data" \
    "${PZ_REPO_ROOT}/data/caddy-config" \
    "${PZ_REPO_ROOT}/data/web-postgres"

  # Never chmod -R the whole ./data tree: map-tiles (DZI pyramids) and postgres
  # can contain hundreds of thousands of files and make deploy look "stuck".
  # Only ensure top-level dirs are traversable/writable; Lua bridge needs recurse.
  local d
  for d in zomboid server backups map-tiles postgres redis app-vendor app-node-modules app-build caddy-data caddy-config web-postgres; do
    chmod a+rwx "${PZ_REPO_ROOT}/data/${d}" 2>/dev/null || true
  done
  if [[ -d "${PZ_REPO_ROOT}/data/zomboid/Lua" ]]; then
    chmod -R a+rwX "${PZ_REPO_ROOT}/data/zomboid/Lua" 2>/dev/null || true
  fi
}

# Kept for callers; Postgres is a bind mount under ./data/postgres now.
pz_ensure_db_volume() {
  mkdir -p "${PZ_REPO_ROOT}/data/postgres"
}

# Public edge network is external (often shared with Traefik/NPM/other stacks).
# Create it if missing so first deploy works on a bare host.
pz_ensure_networks() {
  if ! docker network inspect proxy-network >/dev/null 2>&1; then
    echo "Creating external Docker network: proxy-network"
    docker network create proxy-network >/dev/null
  fi
}

# Fixed container names used by this stack (must match docker-compose.yml)
PZ_STACK_CONTAINERS=(
  pz-app
  pz-queue
  pz-game-server
  pz-db
  pz-redis
  pz-docker-proxy
  pz-caddy
  pz-web-db
  pz-web-api
  pz-web-ui
  pz-data-init
)

# Remove leftover containers by name (survives compose project / profile mismatches).
# $1 = stop timeout seconds (default 15). Game-server compose grace is 60s — we cap it.
pz_force_remove_stack_containers() {
  local timeout="${1:-${PZ_STOP_TIMEOUT:-15}}"
  local name
  local any=0
  for name in "${PZ_STACK_CONTAINERS[@]}"; do
    if docker container inspect "$name" >/dev/null 2>&1; then
      any=1
      local state
      state="$(docker inspect -f '{{.State.Status}}' "$name" 2>/dev/null || echo unknown)"
      echo "  [${name}] status=${state} — stop -t ${timeout}…"
      # Bounded stop so game-server (stop_grace_period: 60s) cannot hang deploy forever
      if ! docker stop -t "$timeout" "$name" 2>&1; then
        echo "  [${name}] stop failed or timed out — force remove"
      fi
      docker rm -f "$name" 2>&1 || true
      echo "  [${name}] removed"
    fi
  done
  if [[ "$any" -eq 0 ]]; then
    echo "  (no leftover stack containers)"
  fi
}

pz_up() {
  echo "→ Ensuring data directories..."
  pz_ensure_db_volume
  pz_ensure_data_dirs
  echo "→ Ensuring Docker networks..."
  pz_ensure_networks
  pz_load_web_mode
  echo "Web proxy mode: ${WEB_PROXY_MODE}"
  # Avoid "name already in use" after partial deploys / mode switches
  echo "→ Refreshing stack containers (stop + recreate)..."
  pz_force_remove_stack_containers
  # Always build local fixed images (web stack + game-server overlay)
  echo "→ Building local images (web-api + web-ui + game-server) — this can take several minutes..."
  pz_compose build web-api web-ui game-server
  echo "→ Starting containers..."
  pz_compose up -d --build --remove-orphans
  echo "→ Stack is up."
}

# Rebuild only the game-server overlay (FROM renegademaster / joyfui + our scripts)
pz_rebuild_game() {
  pz_load_web_mode
  echo "Rebuilding game-server local image from upstream base..."
  pz_compose build --pull game-server
  pz_compose up -d game-server
}

pz_down() {
  local timeout="${PZ_STOP_TIMEOUT:-15}"
  echo "Stopping stack (per-container timeout: ${timeout}s)…"
  echo "  Note: game-server used to wait up to 60s with no output; we stop by name first."
  echo ""

  # 1) Stop fixed-name containers with visible progress (avoids silent compose down hang)
  echo "→ Step 1/3: stop/remove known containers…"
  pz_force_remove_stack_containers "$timeout"
  echo ""

  # 2) Compose down for project metadata / orphans (short timeout; stderr visible)
  echo "→ Step 2/3: docker compose down -t ${timeout} (all web modes / profiles)…"
  # Include every overlay + caddy profile so nothing is left behind when WEB_PROXY_MODE changes
  if ! docker compose \
    -f "${PZ_REPO_ROOT}/docker-compose.yml" \
    -f "${PZ_REPO_ROOT}/${PZ_COMPOSE_ARCH_FILE}" \
    -f "${PZ_REPO_ROOT}/docker-compose.web.yml" \
    -f "${PZ_REPO_ROOT}/docker-compose.web-caddy.yml" \
    -f "${PZ_REPO_ROOT}/docker-compose.web-npm.yml" \
    --profile caddy \
    down -t "$timeout" --remove-orphans "$@"; then
    echo "  (compose down reported an error — continuing with force cleanup)"
  fi
  echo ""

  # 3) Final sweep if compose left anything
  echo "→ Step 3/3: final container sweep…"
  pz_force_remove_stack_containers "$timeout"
  echo ""
  echo "→ Stack stopped."
}

pz_ps() {
  pz_compose ps
}

pz_info() {
  local WEB_UI_PORT="${WEB_UI_PORT:-8100}"
  local PZ_GAME_PORT="${PZ_GAME_PORT:-16261}"
  local PZ_DIRECT_PORT="${PZ_DIRECT_PORT:-16262}"
  if [[ -f "${PZ_REPO_ROOT}/.env" ]]; then
    # shellcheck disable=SC1091
    set -a
    # shellcheck disable=SC1090
    source "${PZ_REPO_ROOT}/.env" 2>/dev/null || true
    set +a
    WEB_UI_PORT="${WEB_UI_PORT:-8100}"
    PZ_GAME_PORT="${PZ_GAME_PORT:-16261}"
    PZ_DIRECT_PORT="${PZ_DIRECT_PORT:-16262}"
  fi
  pz_load_web_mode

  local PUBLIC_IP
  PUBLIC_IP="$(curl -4 -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"

  echo ""
  echo "=============================================="
  echo "  Project Zomboid B42 — Status"
  echo "=============================================="
  echo ""
  echo "  Local Admin:   http://127.0.0.1:${WEB_UI_PORT}"
  echo "  Web mode:      ${WEB_PROXY_MODE}"
  case "$WEB_PROXY_MODE" in
    caddy)
      echo "  Public Admin:  Caddy on host ports ${CADDY_HTTP_PORT:-80}/${CADDY_HTTPS_PORT:-443}"
      ;;
    npm)
      echo "  Public Admin:  via Nginx Proxy Manager on proxy-network"
      echo "                 Forward to: http://pz-web-ui:8080"
      ;;
    local)
      echo "  Public Admin:  disabled (localhost only)"
      ;;
  esac
  if [[ -n "$PUBLIC_IP" ]]; then
    echo "  Public IP:     ${PUBLIC_IP}"
  fi
  echo "  Game Ports:    ${PZ_GAME_PORT}/udp, ${PZ_DIRECT_PORT}/udp"
  echo "  Data dir:      ${PZ_REPO_ROOT}/data/"
  echo ""
  echo "  Containers:"
  pz_compose ps --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null || pz_compose ps
  echo ""
}
