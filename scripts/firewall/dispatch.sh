#!/usr/bin/env bash
set -euo pipefail
# Route make expose/hide/admin-* to the host firewall backend in .firewall.conf.

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
conf="$root/.firewall.conf"

die() { echo "error: $*" >&2; exit 1; }

action="${1:-}"
[ -n "$action" ] || die "usage: dispatch.sh game-open|game-close|admin-open|admin-close"

[ -f "$conf" ] || die ".firewall.conf missing — run make init"

FIREWALL_BACKEND=""
FIREWALL_ZONE=""
CADDY_ENABLED=""
ADMIN_HTTP_PORT=""
ADMIN_HTTPS_PORT=""

while IFS='=' read -r key value; do
    case "$key" in
        ''|\#*) continue ;;
    esac
    value="${value%$'\r'}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    if [[ ${#value} -ge 2 ]]; then
        if [[ ${value:0:1} == '"' && ${value: -1} == '"' ]] || \
           [[ ${value:0:1} == "'" && ${value: -1} == "'" ]]; then
            value="${value:1:-1}"
        fi
    fi
    case "$key" in
        FIREWALL_BACKEND) FIREWALL_BACKEND="$value" ;;
        FIREWALL_ZONE) FIREWALL_ZONE="$value" ;;
        CADDY_ENABLED) CADDY_ENABLED="$value" ;;
        ADMIN_HTTP_PORT) ADMIN_HTTP_PORT="$value" ;;
        ADMIN_HTTPS_PORT) ADMIN_HTTPS_PORT="$value" ;;
    esac
done < "$conf"

case "$action" in
    game-open|game-close|admin-open|admin-close) ;;
    *) die "unknown action $action" ;;
esac

if [[ "$action" == admin-* && "${CADDY_ENABLED:-false}" != "true" ]]; then
    die "public admin needs Caddy (make init). Panel stays on http://127.0.0.1:8100"
fi

backend="${FIREWALL_BACKEND:-manual}"
script="$here/$backend/$action.sh"
if [ ! -f "$script" ]; then
    echo "no $backend/$action.sh — using manual" >&2
    script="$here/manual/$action.sh"
fi
[ -f "$script" ] || die "no handler for $action"

export FIREWALL_ZONE="${FIREWALL_ZONE:-}"
export PZ_GAME_PORT="${PZ_GAME_PORT:-16261}"
export PZ_DIRECT_PORT="${PZ_DIRECT_PORT:-16262}"
export CADDY_HTTP_PORT="${ADMIN_HTTP_PORT:-${CADDY_HTTP_PORT:-80}}"
export CADDY_HTTPS_PORT="${ADMIN_HTTPS_PORT:-${CADDY_HTTPS_PORT:-443}}"

exec bash "$script"
