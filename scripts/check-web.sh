#!/usr/bin/env bash
# Full web health check — does not stop on first error.
cd "$(dirname "$0")/.." || exit 1

ok() { echo "  OK  $*"; }
bad() { echo "  BAD $*"; }

echo "=== 1) Env mode ==="
grep -E '^(WEB_PROXY_MODE|APP_URL|APP_KEY|PZ_SERVER_NAME|APP_NAME|DB_PASSWORD)=' .env 2>/dev/null || bad "root .env missing keys"
grep -E '^(APP_URL|APP_KEY|PZ_SERVER_NAME|APP_NAME|DB_PASSWORD)=' app/.env 2>/dev/null || bad "app/.env missing keys"

echo ""
echo "=== 2) Unquoted values with spaces (breaks Laravel) ==="
found=0
for f in .env app/.env; do
  [ -f "$f" ] || continue
  while IFS= read -r line; do
    case "$line" in \#*|'') continue ;; esac
    case "$line" in
      *=*)
        key="${line%%=*}"
        val="${line#*=}"
        case "$val" in
          \"*|\'*) continue ;;
        esac
        case "$val" in
          *' '*) echo "  BAD  $f → $line"; found=1 ;;
        esac
        ;;
    esac
  done <"$f"
done
[ "$found" -eq 0 ] && ok "no unquoted spaced values"

echo ""
echo "=== 3) Containers ==="
docker ps -a --filter name=pz- --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' || true

echo ""
echo "=== 4) proxy-network ==="
members="$(docker network inspect proxy-network --format '{{range .Containers}}{{.Name}} {{end}}' 2>/dev/null || true)"
echo "  members: $members"
echo "$members" | grep -q 'pz-app' && ok "pz-app on proxy-network" || bad "pz-app NOT on proxy-network (set WEB_PROXY_MODE=npm and redeploy)"
echo "$members" | grep -qi 'proxy-manager\|npm' && ok "NPM on proxy-network" || bad "NPM not on proxy-network (docker network connect proxy-network nginx-proxy-manager)"

echo ""
echo "=== 5) App response (must be 200/302, not 500) ==="
if docker ps --format '{{.Names}}' | grep -qx pz-app; then
  code="$(docker exec pz-app curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8000/ 2>/dev/null || echo fail)"
  echo "  inside pz-app: HTTP $code"
  case "$code" in
    200|301|302) ok "app is answering" ;;
    500) bad "app returns 500 — almost always bad app/.env (run ./scripts/fix-dotenv.sh)" ;;
    *) bad "unexpected code $code" ;;
  esac
  echo "  artisan:"
  docker exec pz-app php artisan about --no-interaction 2>&1 | head -12 || true
else
  bad "pz-app not running"
fi

echo ""
echo "=== 6) NPM → pz-app ==="
NPM="$(docker ps --format '{{.Names}}' | grep -iE 'npm|proxy-manager' | head -1 || true)"
if [ -n "$NPM" ]; then
  code="$(docker exec "$NPM" curl -s -o /dev/null -w '%{http_code}' http://pz-app:8000/ 2>/dev/null || echo fail)"
  echo "  from $NPM: HTTP $code"
  case "$code" in
    200|301|302) ok "NPM can reach app — if browser still 502, re-check Proxy Host (http / pz-app / 8000)" ;;
    500) bad "NPM reaches app but app is 500 — fix dotenv first" ;;
    fail|000) bad "NPM cannot resolve/reach pz-app — network connect" ;;
    *) bad "from NPM: $code" ;;
  esac
else
  bad "no NPM container found"
fi

echo ""
echo "=== Next steps if still broken ==="
echo "  ./scripts/fix-dotenv.sh && docker restart pz-app pz-queue"
echo "  docker logs pz-app --tail 50"
echo "  docker logs pz-db --tail 30"
