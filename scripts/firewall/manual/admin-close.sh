#!/usr/bin/env bash
set -euo pipefail
h="${CADDY_HTTP_PORT:-80}"
s="${CADDY_HTTPS_PORT:-443}"
echo "[manual] close TCP $h and $s"
echo "Panel remains on http://127.0.0.1:8100"
echo "docs/firewall-manual.md"
