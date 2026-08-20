#!/usr/bin/env bash
# Debug Nginx Proxy Manager upstream for a domain (default: pz.corespace.de)
set -euo pipefail
DOMAIN="${1:-pz.corespace.de}"
NPM="$(docker ps --format '{{.Names}}' | grep -iE 'npm|proxy-manager' | head -1 || true)"
if [[ -z "$NPM" ]]; then
  echo "ERROR: no NPM container running"
  exit 1
fi
echo "NPM container: $NPM"
echo "Domain: $DOMAIN"
echo ""

echo "=== Direct upstream (must be 200) ==="
docker exec "$NPM" curl -sI "http://pz-web-ui:8080/" | head -5 || true
echo ""

echo "=== Via NPM port 80 with Host header ==="
docker exec "$NPM" curl -sI -H "Host: $DOMAIN" "http://127.0.0.1:80/" | head -10 || true
echo ""

echo "=== Grep proxy_host configs ==="
docker exec "$NPM" sh -c "grep -RIn --include='*.conf' -E '${DOMAIN}|pz-web-ui|proxy_pass|server_name' /data/nginx/proxy_host/ 2>/dev/null | head -100" || true
echo ""

echo "=== Full conf files for domain ==="
mapfile -t files < <(docker exec "$NPM" sh -c "grep -RIl --include='*.conf' '${DOMAIN}' /data/nginx/proxy_host/ 2>/dev/null" || true)
if [[ ${#files[@]} -eq 0 ]]; then
  echo "  No conf file contains ${DOMAIN}"
  echo "  Listing all proxy_host confs:"
  docker exec "$NPM" ls -la /data/nginx/proxy_host/ 2>/dev/null || true
else
  for f in "${files[@]}"; do
    echo "----- $f -----"
    docker exec "$NPM" cat "$f" 2>/dev/null || true
    echo ""
  done
fi

echo "=== If proxy_pass is not http://pz-web-ui:8080; fix Proxy Host in NPM UI and Save ==="
