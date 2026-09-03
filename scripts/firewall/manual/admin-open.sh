#!/usr/bin/env bash
set -euo pipefail
h="${CADDY_HTTP_PORT:-80}"
s="${CADDY_HTTPS_PORT:-443}"
echo "[manual] allow TCP $h (HTTP) and $s (HTTPS) for Caddy"
echo "  web-ui stays on 127.0.0.1:8100 — do not publish 8100"
echo "  iptables: sudo iptables -A INPUT -p tcp --dport $h -j ACCEPT"
echo "  iptables: sudo iptables -A INPUT -p tcp --dport $s -j ACCEPT"
echo "docs/firewall-manual.md"
