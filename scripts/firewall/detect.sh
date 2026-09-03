#!/usr/bin/env bash
set -euo pipefail
# Write .firewall.conf for make expose / admin-expose.

conf="${1:-.firewall.conf}"

host_id() {
    if [ -f /etc/os-release ]; then
        # shellcheck disable=SC1091
        . /etc/os-release
        echo "$ID"
    else
        echo "unknown"
    fi
}

pick_backend() {
    if command -v firewall-cmd >/dev/null && systemctl is-active firewalld >/dev/null 2>&1; then
        echo firewalld
        return
    fi
    if command -v ufw >/dev/null; then
        echo ufw
        return
    fi
    echo manual
}

firewalld_zone() {
    firewall-cmd --get-default-zone 2>/dev/null || echo public
}

caddy_on() {
    if [ -f caddy/Caddyfile ] && grep -q reverse_proxy caddy/Caddyfile 2>/dev/null; then
        echo true
    else
        echo false
    fi
}

save() {
    local os="$1" backend="$2" zone="$3" caddy="$4"
    local host="${5:-}" http="${6:-80}" https="${7:-443}"
    cat > "$conf" <<EOF
# Written by make init. Edit or re-run init to change.
FIREWALL_BACKEND=$(printf '%q' "$backend")
FIREWALL_OS=$(printf '%q' "$os")
FIREWALL_ZONE=$(printf '%q' "$zone")
CADDY_ENABLED=$(printf '%q' "$caddy")
ADMIN_PUBLIC_HOST=$(printf '%q' "$host")
ADMIN_HTTP_PORT=$(printf '%q' "$http")
ADMIN_HTTPS_PORT=$(printf '%q' "$https")
EOF
}

if [ "${2:-}" = "--silent" ]; then
    host="" http=80 https=443
    if [ -f "$conf" ]; then
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
                ADMIN_PUBLIC_HOST) host="$value" ;;
                ADMIN_HTTP_PORT) http="$value" ;;
                ADMIN_HTTPS_PORT) https="$value" ;;
            esac
        done < "$conf"
    fi
    backend=$(pick_backend)
    zone=""
    [ "$backend" = firewalld ] && zone=$(firewalld_zone)
    save "$(host_id)" "$backend" "$zone" "$(caddy_on)" "$host" "$http" "$https"
    exit 0
fi

os=$(host_id)
backend=$(pick_backend)
zone=""
caddy=$(caddy_on)

echo ""
echo "Firewall"
echo "  OS: $os"
echo "  backend: $backend"

if [ "$backend" != manual ]; then
    if [ "$backend" = firewalld ]; then
        zone=$(firewalld_zone)
        echo "  zone: $zone"
    fi
    echo -n "  keep this backend? [Y/n] "
    read -r ans || true
    if [ "${ans,,}" = n ]; then
        backend=""
    fi
fi

if [ -z "$backend" ] || [ "$backend" = manual ]; then
    echo "  1) firewalld  2) ufw  3) manual"
    echo -n "  choice [3]: "
    read -r choice || true
    case "${choice:-3}" in
        1) backend=firewalld ;;
        2) backend=ufw ;;
        *) backend=manual ;;
    esac
    if [ "$backend" = firewalld ]; then
        zone=$(firewalld_zone)
        echo -n "  zone [$zone]: "
        read -r z || true
        zone="${z:-$zone}"
    fi
fi

if [ "$backend" = manual ]; then
    echo "  Manual: commands print ports only. See docs/firewall-manual.md"
fi

save "$os" "$backend" "$zone" "$caddy" \
    "${ADMIN_PUBLIC_HOST:-}" "${ADMIN_HTTP_PORT:-80}" "${ADMIN_HTTPS_PORT:-443}"
echo "  wrote $conf"
