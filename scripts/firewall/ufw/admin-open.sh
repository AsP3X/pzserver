#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=_common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"
need_ufw
allow "${CADDY_HTTP_PORT:-80}" tcp
allow "${CADDY_HTTPS_PORT:-443}" tcp
echo "ufw: Caddy TCP ${CADDY_HTTP_PORT:-80} ${CADDY_HTTPS_PORT:-443} open"
