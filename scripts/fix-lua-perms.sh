#!/usr/bin/env bash
# Fix ZomboidManager Lua bridge write permissions on the host bind mount.
# Run on the host from the repo root if you see:
#   [ZomboidManager] ERROR: cannot open file writer for <player>
#   [ZomboidManager] ERROR: cannot write export_requests.json
#
# Root cause: Laravel (www-data) and the game (steam/root) share this directory.
# Sticky bit (1777) + 0644 files owned by www-data make getFileWriter() fail.
# Use plain 0777 dirs and 0666 files so either UID can open/replace them.
set -euo pipefail
cd "$(dirname "$0")/.."

LUA="${1:-data/zomboid/Lua}"
echo "Fixing permissions under: $LUA"
mkdir -p "$LUA/inventory"

# Drop sticky bit if present — required for cross-UID atomic rename/replace
chmod 777 "$LUA" 2>/dev/null || true
chmod 777 "$LUA/inventory" 2>/dev/null || true

for f in export_requests.json player_stats.json players_live.json game_state.json \
         items_catalog.json delivery_queue.json delivery_results.json \
         deposit_requests.json deposit_results.json; do
  path="$LUA/$f"
  if [ ! -e "$path" ]; then
    : >"$path" || true
  fi
  chmod 666 "$path" 2>/dev/null || true
done

# All files 0666, all dirs 0777 (no sticky)
find "$LUA" -type f -exec chmod 666 {} + 2>/dev/null || true
find "$LUA" -type d -exec chmod 777 {} + 2>/dev/null || true

# Make host user own nothing restrictive if we can (optional best-effort)
chmod a+rwX "$LUA" "$LUA/inventory" 2>/dev/null || true

echo "Result:"
ls -la "$LUA" || true
ls -la "$LUA/inventory" 2>/dev/null || true

# Also fix inside running containers if present
if docker ps --format '{{.Names}}' | grep -qx pz-game-server; then
  echo "Applying inside pz-game-server..."
  docker exec pz-game-server sh -c '
    mkdir -p /home/steam/Zomboid/Lua/inventory
    find /home/steam/Zomboid/Lua -type d -exec chmod 777 {} + 2>/dev/null || true
    find /home/steam/Zomboid/Lua -type f -exec chmod 666 {} + 2>/dev/null || true
    ls -la /home/steam/Zomboid/Lua
    ls -la /home/steam/Zomboid/Lua/inventory 2>/dev/null || true
    # Prove game user can write a test file
    touch /home/steam/Zomboid/Lua/.write_test && rm -f /home/steam/Zomboid/Lua/.write_test \
      && echo "WRITE_OK" || echo "WRITE_FAIL"
  ' || true
fi

if docker ps --format '{{.Names}}' | grep -qx pz-app; then
  echo "Applying inside pz-app..."
  docker exec pz-app sh -c '
    mkdir -p /lua-bridge/inventory
    find /lua-bridge -type d -exec chmod 777 {} + 2>/dev/null || true
    find /lua-bridge -type f -exec chmod 666 {} + 2>/dev/null || true
    ls -la /lua-bridge
  ' || true
fi

echo "Done. Errors should stop within ~1 minute of in-game time (no restart required)."
echo "If WRITE_FAIL appeared above, the bind mount may be read-only or blocked by SELinux."
