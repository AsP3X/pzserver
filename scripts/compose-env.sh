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
  local args=()
  # shellcheck disable=SC2207
  mapfile -t args < <(pz_compose_cli_args)
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
    "${PZ_REPO_ROOT}/data/caddy-config"
  chmod -R a+rwX "${PZ_REPO_ROOT}/data" 2>/dev/null || true
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
)

# Remove leftover containers by name (survives compose project / profile mismatches)
pz_force_remove_stack_containers() {
  local name
  for name in "${PZ_STACK_CONTAINERS[@]}"; do
    if docker container inspect "$name" >/dev/null 2>&1; then
      echo "  Removing leftover container: ${name}"
      docker rm -f "$name" >/dev/null 2>&1 || true
    fi
  done
}

pz_up() {
  pz_ensure_db_volume
  pz_ensure_data_dirs
  pz_ensure_networks
  pz_load_web_mode
  # Avoid "name already in use" after partial deploys / mode switches
  pz_force_remove_stack_containers
  echo "Web proxy mode: ${WEB_PROXY_MODE}"
  pz_compose up -d --build --remove-orphans
}

pz_down() {
  echo "Stopping compose project (all web modes / profiles)..."
  # Include every overlay + caddy profile so nothing is left behind when WEB_PROXY_MODE changes
  docker compose \
    -f "${PZ_REPO_ROOT}/docker-compose.yml" \
    -f "${PZ_REPO_ROOT}/${PZ_COMPOSE_ARCH_FILE}" \
    -f "${PZ_REPO_ROOT}/docker-compose.web-caddy.yml" \
    -f "${PZ_REPO_ROOT}/docker-compose.web-npm.yml" \
    --profile caddy \
    down --remove-orphans "$@" 2>/dev/null || true

  # Compose may miss containers created under another project name / cwd / old mode
  echo "Cleaning fixed-name stack containers..."
  pz_force_remove_stack_containers
  echo "Stack stopped."
}

pz_ps() {
  pz_compose ps
}

pz_info() {
  local APP_PORT="${APP_PORT:-8000}"
  local PZ_GAME_PORT="${PZ_GAME_PORT:-16261}"
  local PZ_DIRECT_PORT="${PZ_DIRECT_PORT:-16262}"
  if [[ -f "${PZ_REPO_ROOT}/.env" ]]; then
    # shellcheck disable=SC1091
    set -a
    # shellcheck disable=SC1090
    source "${PZ_REPO_ROOT}/.env" 2>/dev/null || true
    set +a
    APP_PORT="${APP_PORT:-8000}"
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
  echo "  Local Admin:   http://127.0.0.1:${APP_PORT}"
  echo "  Web mode:      ${WEB_PROXY_MODE}"
  case "$WEB_PROXY_MODE" in
    caddy)
      echo "  Public Admin:  Caddy on host ports ${CADDY_HTTP_PORT:-80}/${CADDY_HTTPS_PORT:-443}"
      ;;
    npm)
      echo "  Public Admin:  via Nginx Proxy Manager on proxy-network"
      echo "                 Forward to: http://pz-app:8000"
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
