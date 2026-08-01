#!/usr/bin/env bash
# Diagnose web panel (NPM / local) issues for the PZ stack.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "=== WEB_PROXY_MODE / APP_URL ==="
grep -E '^(WEB_PROXY_MODE|APP_URL|APP_KEY|PZ_SERVER_NAME|APP_NAME)=' .env app/.env 2>/dev/null || true

echo ""
echo "=== Unquoted .env values containing spaces (INVALID) ==="
# Lines with = then unquoted value that contains a space
bad=0
for f in .env app/.env; do
  [[ -f "$f" ]] || continue
  while IFS= read -r line; do
    [[ "$line" =~ ^# ]] && continue
    [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || continue
    val="${line#*=}"
    # skip already quoted
    if [[ "$val" == \"*\" || "$val" == \'*\' ]]; then
      continue
    fi
    if [[ "$val" == *" "* ]]; then
      echo "  BAD  $f: $line"
      bad=1
    fi
  done < "$f"
done
if [[ "$bad" -eq 0 ]]; then
  echo "  none found"
fi

echo ""
echo "=== Containers ==="
docker ps -a --filter name=pz- --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'

echo ""
echo "=== proxy-network members ==="
docker network inspect proxy-network --format '{{range .Containers}}{{.Name}} {{end}}' 2>/dev/null || echo "proxy-network missing"

echo ""
echo "=== App HTTP (inside container) ==="
if docker ps --format '{{.Names}}' | grep -qx pz-app; then
  docker exec pz-app curl -sI http://127.0.0.1:8000/ 2>&1 | head -8 || true
  echo ""
  echo "=== Artisan (dotenv load) ==="
  docker exec pz-app php artisan about --no-interaction 2>&1 | head -25 || true
else
  echo "pz-app is not running"
fi

echo ""
echo "=== From NPM container (if present) ==="
NPM=$(docker ps --format '{{.Names}}' | grep -iE 'npm|proxy-manager' | head -1 || true)
if [[ -n "${NPM:-}" ]]; then
  echo "NPM container: $NPM"
  docker exec "$NPM" curl -sI http://pz-app:8000/ 2>&1 | head -8 || true
else
  echo "no NPM container found"
fi

echo ""
echo "Done. For 500: fix BAD env lines (quote values with spaces), then:"
echo "  docker restart pz-app pz-queue"
echo "For 502 with good 200 from curl above: fix NPM forward host pz-app:8000 http + shared proxy-network."
