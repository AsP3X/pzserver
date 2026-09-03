#!/usr/bin/env bash
set -euo pipefail
g="${PZ_GAME_PORT:-16261}"
d="${PZ_DIRECT_PORT:-16262}"
echo "[manual] allow UDP $g and $d for players"
echo "  iptables: sudo iptables -A INPUT -p udp --dport $g -j ACCEPT"
echo "  nftables: sudo nft add rule inet filter input udp dport { $g, $d } accept"
echo "Forward those ports on the router for internet players. docs/firewall-manual.md"
