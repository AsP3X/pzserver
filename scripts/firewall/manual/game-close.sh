#!/usr/bin/env bash
set -euo pipefail
g="${PZ_GAME_PORT:-16261}"
d="${PZ_DIRECT_PORT:-16262}"
echo "[manual] close UDP $g and $d"
echo "  iptables: sudo iptables -D INPUT -p udp --dport $g -j ACCEPT"
echo "  ufw:      sudo ufw delete allow $g/udp"
echo "docs/firewall-manual.md"
