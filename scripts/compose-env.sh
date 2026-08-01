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

pz_compose() {
  docker compose \
    -f "${PZ_REPO_ROOT}/docker-compose.yml" \
    -f "${PZ_REPO_ROOT}/${PZ_COMPOSE_ARCH_FILE}" \
    "$@"
}

pz_ensure_data_dirs() {
  mkdir -p \
    "${PZ_REPO_ROOT}/data/zomboid/Lua" \
    "${PZ_REPO_ROOT}/data/server" \
    "${PZ_REPO_ROOT}/data/backups" \
    "${PZ_REPO_ROOT}/data/map-tiles"
  chmod -R a+rwX "${PZ_REPO_ROOT}/data" 2>/dev/null || true
}

pz_ensure_db_volume() {
  if ! docker volume inspect pz-postgres >/dev/null 2>&1; then
    echo "Creating Postgres volume pz-postgres..."
    docker volume create pz-postgres >/dev/null
  fi
}

pz_up() {
  pz_ensure_db_volume
  pz_ensure_data_dirs
  pz_compose up -d --build
}

pz_down() {
  pz_compose down
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

  local PUBLIC_IP
  PUBLIC_IP="$(curl -4 -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"

  echo ""
  echo "=============================================="
  echo "  Project Zomboid B42 — Status"
  echo "=============================================="
  echo ""
  echo "  Local Admin:   http://localhost:${APP_PORT}"
  if [[ -f "${PZ_REPO_ROOT}/.firewall.conf" ]]; then
    # shellcheck disable=SC1091
    # shellcheck disable=SC1090
    source "${PZ_REPO_ROOT}/.firewall.conf"
    local HTTPS_PORT="${ADMIN_HTTPS_PORT:-443}"
    local HTTP_PORT="${ADMIN_HTTP_PORT:-80}"
    local HOST="${ADMIN_PUBLIC_HOST:-}"
    if [[ -n "$HOST" && "$HOST" != "localhost" ]]; then
      if [[ "$HTTPS_PORT" == "443" ]]; then
        echo "  Public Admin:  https://${HOST}  (open firewall if needed)"
      else
        echo "  Public Admin:  https://${HOST}:${HTTPS_PORT}"
      fi
    else
      echo "  Public Admin:  not configured (re-run ./deploy.sh --init to enable)"
    fi
    echo "  Caddy Ports:   ${HTTP_PORT} (HTTP) / ${HTTPS_PORT} (HTTPS)"
    echo "  Firewall:      ${FIREWALL_BACKEND:-unknown}"
  else
    echo "  Public Admin:  not configured (re-run ./deploy.sh --init)"
    echo "  Firewall:      not configured"
  fi
  if [[ -n "$PUBLIC_IP" ]]; then
    echo "  Public IP:     ${PUBLIC_IP}"
  else
    echo "  Public IP:     unavailable"
  fi
  echo "  Game Ports:    ${PZ_GAME_PORT}/udp, ${PZ_DIRECT_PORT}/udp"
  echo "  Data dir:      ${PZ_REPO_ROOT}/data/"
  echo ""
  echo "  Containers:"
  pz_compose ps --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null || pz_compose ps
  echo ""
}
