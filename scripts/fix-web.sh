#!/usr/bin/env bash
# Verbose diagnostic dump for web panel (NPM / local) issues.
#
# Prints raw output rather than verdicts — reach for this when
# ./scripts/check-web.sh reports a BAD line and you want the detail. Targets the
# Rust web stack (web-ui + web-api); the Laravel panel and its artisan/dotenv
# checks were parked in c318e99.
set -euo pipefail
cd "$(dirname "$0")/.."

# docker-compose.web.yml publishes web-ui on 127.0.0.1:${WEB_UI_PORT:-8100}.
WEB_UI_PORT="${WEB_UI_PORT:-8100}"
if [[ -f .env ]]; then
  _port="$(grep -E '^WEB_UI_PORT=' .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '\r"'"'" || true)"
  [[ -n "$_port" ]] && WEB_UI_PORT="$_port"
fi

echo "=== Web env ==="
grep -E '^(WEB_PROXY_MODE|WEB_UI_PORT|WEB_PUBLIC_URL|WEB_CORS_ORIGINS|PZ_SERVER_NAME|ADMIN_USERNAME)=' .env 2>/dev/null || true

echo ""
echo "=== Containers ==="
docker ps -a --filter name=pz- --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'

echo ""
echo "=== proxy-network members ==="
docker network inspect proxy-network --format '{{range .Containers}}{{.Name}} {{end}}' 2>/dev/null || echo "proxy-network missing"

echo ""
echo "=== Panel from the host ==="
curl -sI "http://127.0.0.1:${WEB_UI_PORT}/" 2>&1 | head -8 || true

echo ""
echo "=== API health ==="
curl -s "http://127.0.0.1:${WEB_UI_PORT}/api/health" 2>&1 | head -5 || true
echo ""
curl -s "http://127.0.0.1:${WEB_UI_PORT}/api/health/detailed" 2>&1 | head -30 || true

echo ""
echo "=== web-api log tail ==="
docker logs pz-web-api --tail 30 2>&1 | head -40 || echo "pz-web-api is not running"

echo ""
echo "=== web-ui log tail ==="
docker logs pz-web-ui --tail 20 2>&1 | head -30 || echo "pz-web-ui is not running"

echo ""
echo "=== From NPM container (if present) ==="
NPM=$(docker ps --format '{{.Names}}' | grep -iE 'npm|proxy-manager' | head -1 || true)
if [[ -n "${NPM:-}" ]]; then
  echo "NPM container: $NPM"
  docker exec "$NPM" curl -sI http://pz-web-ui:8080/ 2>&1 | head -8 || true
else
  echo "no NPM container found"
fi

echo ""
echo "Done."
echo "For 503 on /api/health: a writable bind mount failed its start-up probe —"
echo "  read the detailed output above, then: ./deploy.sh --restart web-api"
echo "For 502 in the browser with a good 200 above: fix the NPM Proxy Host"
echo "  (scheme http, host pz-web-ui, port 8080) and share proxy-network."
