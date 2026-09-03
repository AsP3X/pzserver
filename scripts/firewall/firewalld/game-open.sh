#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=_common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"
need_firewalld
allow "${PZ_GAME_PORT:-16261}" udp
allow "${PZ_DIRECT_PORT:-16262}" udp
echo "firewalld ($ZONE): game UDP ${PZ_GAME_PORT:-16261} ${PZ_DIRECT_PORT:-16262} open"
