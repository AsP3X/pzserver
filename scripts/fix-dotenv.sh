#!/usr/bin/env bash
# Quote unquoted .env values that contain whitespace (Laravel dotenv requirement).
# Usage: ./scripts/fix-dotenv.sh
set -euo pipefail
cd "$(dirname "$0")/.."

fix_file() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  local tmp
  tmp="$(mktemp)"
  local changed=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    # Keep comments / blanks / export prefix-less simple lines
    if [[ "$line" =~ ^[[:space:]]*# ]] || [[ -z "${line// }" ]]; then
      printf '%s\n' "$line" >>"$tmp"
      continue
    fi
    if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      local key="${BASH_REMATCH[1]}"
      local val="${BASH_REMATCH[2]}"
      # already quoted
      if [[ "$val" == \"*\" && "$val" == *\" ]]; then
        printf '%s\n' "$line" >>"$tmp"
        continue
      fi
      if [[ "$val" == \'*\' && "$val" == *\' ]]; then
        printf '%s\n' "$line" >>"$tmp"
        continue
      fi
      # needs quotes if whitespace present
      if [[ "$val" == *[[:space:]]* ]]; then
        # escape existing double quotes inside value
        val="${val//\"/\\\"}"
        printf '%s="%s"\n' "$key" "$val" >>"$tmp"
        echo "  fixed $file: $key=... (quoted)"
        changed=1
        continue
      fi
    fi
    printf '%s\n' "$line" >>"$tmp"
  done <"$file"
  if [[ "$changed" -eq 1 ]]; then
    cp "$file" "${file}.bak.$(date +%Y%m%d%H%M%S)"
    mv "$tmp" "$file"
  else
    rm -f "$tmp"
  fi
}

echo "Fixing dotenv whitespace quoting in .env / app/.env ..."
fix_file .env
fix_file app/.env
echo "Done."
