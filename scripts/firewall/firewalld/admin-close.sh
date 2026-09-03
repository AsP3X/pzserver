#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=_common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"
need_firewalld
deny "${CADDY_HTTP_PORT:-80}" tcp
deny "${CADDY_HTTPS_PORT:-443}" tcp
echo "firewalld ($ZONE): Caddy TCP ${CADDY_HTTP_PORT:-80} ${CADDY_HTTPS_PORT:-443} closed"
