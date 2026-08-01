#!/usr/bin/env bash
# Fix ZomboidManager Lua bridge write permissions on the host bind mount.
# Run on the host from the repo root if you see:
#   [ZomboidManager] ERROR: cannot open file writer for <player>
#   [ZomboidManager] ERROR: cannot write export_requests.json
set -euo pipefail
cd "$(dirname "$0")/.."

LUA="${1:-data/zomboid/Lua}"
echo "Fixing permissions under: $LUA"
mkdir -p "$LUA/inventory"
chmod 777 "$LUA" 2>/dev/null || true
chmod 777 "$LUA/inventory" 2>/dev/null || true
# sticky world-writable preferred
chmod 1777 "$LUA" 2>/dev/null || true
chmod 1777 "$LUA/inventory" 2>/dev/null || true

for f in export_requests.json player_stats.json players_live.json game_state.json items_catalog.json; do
  path="$LUA/$f"
  if [ ! -e "$path" ]; then
    : >"$path" || true
  fi
  chmod 666 "$path" 2>/dev/null || true
done
find "$LUA" -type f -exec chmod 666 {} + 2>/dev/null || true
find "$LUA" -type d -exec chmod 1777 {} + 2>/dev/null || true

echo "Result:"
ls -la "$LUA" || true
ls -la "$LUA/inventory" 2>/dev/null || true

# Also fix inside running game container if present
if docker ps --format '{{.Names}}' | grep -qx pz-game-server; then
  echo "Applying inside pz-game-server..."
  docker exec pz-game-server sh -c '
    mkdir -p /home/steam/Zomboid/Lua/inventory
    chmod -R 1777 /home/steam/Zomboid/Lua 2>/dev/null || chmod -R 777 /home/steam/Zomboid/Lua
    chmod 666 /home/steam/Zomboid/Lua/* 2>/dev/null || true
    chmod 666 /home/steam/Zomboid/Lua/inventory/* 2>/dev/null || true
    ls -la /home/steam/Zomboid/Lua
  ' || true
fi

echo "Done. Errors should stop within ~1 minute of in-game time (no restart required)."
