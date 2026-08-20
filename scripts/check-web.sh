#!/usr/bin/env bash
# Full web health check — does not stop on first error.
#
# Targets the Rust web stack (web-ui + web-api). The Laravel panel this used to
# probe, and the artisan/app-dotenv checks that went with it, were parked in
# c318e99. For a verbose dump rather than verdicts, use ./scripts/fix-web.sh.
cd "$(dirname "$0")/.." || exit 1

# docker-compose.web.yml publishes web-ui on 127.0.0.1:${WEB_UI_PORT:-8100}.
WEB_UI_PORT="${WEB_UI_PORT:-8100}"
if [ -f .env ]; then
  _port="$(grep -E '^WEB_UI_PORT=' .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '\r"'"'" || true)"
  [ -n "$_port" ] && WEB_UI_PORT="$_port"
fi

# NPM only has to be reachable in npm mode; in local/caddy mode its absence is
# the expected state, not a fault. A check that always prints BAD gets ignored.
WEB_PROXY_MODE="${WEB_PROXY_MODE:-}"
if [ -z "$WEB_PROXY_MODE" ] && [ -f .env ]; then
  WEB_PROXY_MODE="$(grep -E '^WEB_PROXY_MODE=' .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '\r"'"'" || true)"
fi
WEB_PROXY_MODE="$(echo "${WEB_PROXY_MODE:-local}" | tr '[:upper:]' '[:lower:]')"

ok() { echo "  OK  $*"; }
bad() { echo "  BAD $*"; }
skip() { echo "  --  $*"; }

echo "=== 1) Env mode ==="
grep -E '^(WEB_PROXY_MODE|WEB_UI_PORT|WEB_PUBLIC_URL|PZ_SERVER_NAME|ADMIN_USERNAME|WEB_DB_PASSWORD)=' .env 2>/dev/null ||
  bad "root .env missing keys"

echo ""
echo "=== 2) Containers ==="
docker ps -a --filter name=pz- --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' || true

echo ""
echo "=== 3) proxy-network ==="
members="$(docker network inspect proxy-network --format '{{range .Containers}}{{.Name}} {{end}}' 2>/dev/null || true)"
echo "  members: $members"
if echo "$members" | grep -q 'pz-web-ui'; then
  ok "pz-web-ui on proxy-network"
else
  bad "pz-web-ui NOT on proxy-network (set WEB_PROXY_MODE=npm and redeploy)"
fi
if [ "$WEB_PROXY_MODE" = "npm" ]; then
  if echo "$members" | grep -qi 'proxy-manager\|npm'; then
    ok "NPM on proxy-network"
  else
    bad "NPM not on proxy-network (docker network connect proxy-network nginx-proxy-manager)"
  fi
else
  skip "NPM not expected in ${WEB_PROXY_MODE} mode"
fi

echo ""
echo "=== 4) Panel from the host (must be 200) ==="
code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${WEB_UI_PORT}/" 2>/dev/null || echo fail)"
echo "  http://127.0.0.1:${WEB_UI_PORT}/ -> HTTP $code"
case "$code" in
  200|301|302) ok "web-ui is answering" ;;
  fail|000)    bad "nothing listening on ${WEB_UI_PORT} — is pz-web-ui up?" ;;
  *)           bad "unexpected code $code" ;;
esac

echo ""
echo "=== 5) API health (nginx in web-ui fronts /api) ==="
code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${WEB_UI_PORT}/api/health" 2>/dev/null || echo fail)"
echo "  /api/health -> HTTP $code"
case "$code" in
  200)      ok "web-api healthy" ;;
  # The API returns 503 when a bind mount it must write is not writable.
  503)      bad "web-api up but unhealthy — check the writable bind mounts" ;;
  fail|000) bad "no answer — is pz-web-api up?" ;;
  *)        bad "unexpected code $code" ;;
esac
if [ "$code" = "503" ]; then
  echo "  detail:"
  curl -s "http://127.0.0.1:${WEB_UI_PORT}/api/health/detailed" 2>/dev/null | head -20 || true
fi

echo ""
echo "=== 6) NPM → pz-web-ui ==="
NPM="$(docker ps --format '{{.Names}}' | grep -iE 'npm|proxy-manager' | head -1 || true)"
if [ "$WEB_PROXY_MODE" != "npm" ]; then
  skip "web mode is ${WEB_PROXY_MODE} — the panel is not served through NPM"
elif [ -n "$NPM" ]; then
  code="$(docker exec "$NPM" curl -s -o /dev/null -w '%{http_code}' http://pz-web-ui:8080/ 2>/dev/null || echo fail)"
  echo "  from $NPM: HTTP $code"
  case "$code" in
    200|301|302) ok "NPM can reach the panel — if the browser still 502s, re-check Proxy Host (http / pz-web-ui / 8080)" ;;
    fail|000)    bad "NPM cannot resolve/reach pz-web-ui — docker network connect proxy-network $NPM" ;;
    *)           bad "from NPM: $code" ;;
  esac
else
  bad "no NPM container found"
fi

echo ""
echo "=== Next steps if still broken ==="
echo "  ./deploy.sh --logs web-ui web-api"
echo "  ./deploy.sh --restart web-ui web-api"
echo "  ./scripts/fix-web.sh          # verbose dump"
