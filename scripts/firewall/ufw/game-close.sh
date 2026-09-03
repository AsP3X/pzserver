#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=_common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"
need_ufw
deny "${PZ_GAME_PORT:-16261}" udp
deny "${PZ_DIRECT_PORT:-16262}" udp
echo "ufw: game UDP ${PZ_GAME_PORT:-16261} ${PZ_DIRECT_PORT:-16262} closed"
