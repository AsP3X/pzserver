#!/bin/bash
# Ensure JVM -Xmx/-Xms values in ProjectZomboid64.json have a unit (m/g).
# Bare numbers are bytes in Java → "Too small maximum heap" (e.g. -Xmx8192).
# The renegademaster image often strips the unit from MAX_RAM=8192m → -Xmx8192.

set -e

JSON="${1:-/home/steam/ZomboidDedicatedServer/ProjectZomboid64.json}"
if [ ! -f "$JSON" ]; then
    # ARM install path fallback
    if [ -f /home/steam/pzserver/ProjectZomboid64.json ]; then
        JSON=/home/steam/pzserver/ProjectZomboid64.json
    else
        exit 0
    fi
fi

# Prefer env MAX_RAM / PZ_MAX_RAM if set (normalize to Nm or Ng)
RAM="${MAX_RAM:-${PZ_MAX_RAM:-}}"
if [ -n "$RAM" ]; then
    RAM=$(printf '%s' "$RAM" | tr -d '[:space:]')
    if printf '%s' "$RAM" | grep -Eq '^[0-9]+$'; then
        RAM="${RAM}m"
    fi
    # If JSON has any -Xmx, replace with normalized value
    if grep -qE -- '-Xmx' "$JSON"; then
        # Replace existing -Xmx* tokens in quoted vm args
        sed -i -E "s/\"-Xmx[0-9]+[mMgGkK]?\"/\"-Xmx${RAM}\"/g" "$JSON"
        echo "[fix-heap] Set -Xmx${RAM} from MAX_RAM/PZ_MAX_RAM in $JSON"
    fi
fi

# Fix any remaining bare -XmxNNNN / -XmsNNNN (digits only → megabytes)
if grep -qE -- '"-Xmx[0-9]+"' "$JSON"; then
    sed -i -E 's/"-Xmx([0-9]+)"/"-Xmx\1m"/g' "$JSON"
    echo "[fix-heap] Appended 'm' to bare -Xmx values in $JSON"
fi
if grep -qE -- '"-Xms[0-9]+"' "$JSON"; then
    sed -i -E 's/"-Xms([0-9]+)"/"-Xms\1m"/g' "$JSON"
    echo "[fix-heap] Appended 'm' to bare -Xms values in $JSON"
fi

# Show resulting heap args
if grep -E -- '-Xm[xs]' "$JSON" >/dev/null 2>&1; then
    echo "[fix-heap] JVM heap args:"
    grep -oE -- '-Xm[xs][0-9]+[mMgGkK]?' "$JSON" | sort -u | sed 's/^/  /'
fi
