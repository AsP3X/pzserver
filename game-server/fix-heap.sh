#!/bin/bash
# Ensure JVM -Xmx/-Xms values have a unit (m/g). Bare digits are BYTES in Java
# → "Too small maximum heap" (e.g. -Xmx8192 from MAX_RAM=8192m after the image
# strips the unit).
#
# Also installs a ProjectZomboid64 wrapper so this runs *after* the image
# rewrites ProjectZomboid64.json and *immediately before* the real binary.

set -e

fix_json() {
    local JSON="$1"
    [ -f "$JSON" ] || return 0

    local RAM="${MAX_RAM:-${PZ_MAX_RAM:-}}"
    if [ -n "$RAM" ]; then
        RAM=$(printf '%s' "$RAM" | tr -d '[:space:]')
        if printf '%s' "$RAM" | grep -Eq '^[0-9]+$'; then
            RAM="${RAM}m"
        fi
        if grep -qE -- '-Xmx' "$JSON"; then
            sed -i -E "s/\"-Xmx[0-9]+[mMgGkK]?\"/\"-Xmx${RAM}\"/g" "$JSON"
            echo "[fix-heap] Set -Xmx${RAM} in $JSON"
        fi
    fi

    # Any remaining bare -XmxNNNN / -XmsNNNN → add m
    if grep -qE -- '"-Xmx[0-9]+"' "$JSON"; then
        sed -i -E 's/"-Xmx([0-9]+)"/"-Xmx\1m"/g' "$JSON"
        echo "[fix-heap] Fixed bare -Xmx* to megabytes in $JSON"
    fi
    if grep -qE -- '"-Xms[0-9]+"' "$JSON"; then
        sed -i -E 's/"-Xms([0-9]+)"/"-Xms\1m"/g' "$JSON"
        echo "[fix-heap] Fixed bare -Xms* to megabytes in $JSON"
    fi

    if grep -oE -- '-Xm[xs][0-9]+[mMgGkK]?' "$JSON" >/dev/null 2>&1; then
        echo "[fix-heap] Effective heap args:"
        grep -oE -- '-Xm[xs][0-9]+[mMgGkK]?' "$JSON" | sort -u | sed 's/^/  /'
    fi
}

install_wrapper() {
    local DIR="$1"
    local BIN="$DIR/ProjectZomboid64"
    local REAL="$DIR/ProjectZomboid64.real"
    local JSON="$DIR/ProjectZomboid64.json"

    [ -e "$BIN" ] || return 0

    # Already our wrapper?
    if head -1 "$BIN" 2>/dev/null | grep -q '^#!'; then
        if grep -q 'fix-heap' "$BIN" 2>/dev/null; then
            echo "[fix-heap] Wrapper already installed at $BIN"
            fix_json "$JSON"
            return 0
        fi
    fi

    # Steam validate restores the real ELF binary each update — re-wrap every boot
    if file "$BIN" 2>/dev/null | grep -qi 'ELF\|executable'; then
        mv -f "$BIN" "$REAL"
    elif [ ! -f "$REAL" ]; then
        # Unknown type; still try to preserve
        mv -f "$BIN" "$REAL" 2>/dev/null || return 0
    fi

    cat > "$BIN" << 'WRAP'
#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
# Fix heap units after image rewrote JSON, before JVM starts
if [ -f /home/steam/fix-heap.sh ]; then
  bash /home/steam/fix-heap.sh --json-only "$DIR/ProjectZomboid64.json" || true
else
  # Inline fallback if script not mounted
  JSON="$DIR/ProjectZomboid64.json"
  if [ -f "$JSON" ]; then
    sed -i -E 's/"-Xmx([0-9]+)"/"-Xmx\1m"/g' "$JSON" 2>/dev/null || true
    sed -i -E 's/"-Xms([0-9]+)"/"-Xms\1m"/g' "$JSON" 2>/dev/null || true
  fi
fi
REAL="$DIR/ProjectZomboid64.real"
if [ ! -x "$REAL" ]; then
  echo "[fix-heap] ERROR: missing $REAL" >&2
  exit 1
fi
exec "$REAL" "$@"
WRAP
    chmod +x "$BIN"
    echo "[fix-heap] Installed ProjectZomboid64 wrapper in $DIR"
    fix_json "$JSON"
}

# --- main ---
JSON_ONLY=0
JSON_PATH=""
if [ "${1:-}" = "--json-only" ]; then
    JSON_ONLY=1
    JSON_PATH="${2:-}"
fi

if [ "$JSON_ONLY" -eq 1 ]; then
    if [ -n "$JSON_PATH" ]; then
        fix_json "$JSON_PATH"
    else
        fix_json /home/steam/ZomboidDedicatedServer/ProjectZomboid64.json
        fix_json /home/steam/pzserver/ProjectZomboid64.json
    fi
    exit 0
fi

# Full mode: fix json + install wrapper (called from configure-server / entrypoint)
for d in /home/steam/ZomboidDedicatedServer /home/steam/pzserver; do
    if [ -d "$d" ]; then
        fix_json "$d/ProjectZomboid64.json"
        install_wrapper "$d"
    fi
done
