#!/usr/bin/env bash
# Fail if any Rust source silences unused items with allow(dead_code).
#
# Workspace rustc `deny`s dead_code. This grep is what stops anyone silencing
# that deny with the attribute (sqlx macros emit allow(dead_code), so the
# lint cannot be `forbid` without breaking compile).

set -euo pipefail
cd "$(dirname "$0")/.."

hits="$(
  grep -RIn --include='*.rs' -E 'allow\(\s*dead_code|allow\([^)]*dead_code' web/api \
    | grep -v '/target/' \
    || true
)"

if [ -n "$hits" ]; then
  echo "Forbidden: allow(dead_code) is not permitted. Delete the item or wire it in."
  echo "$hits"
  exit 1
fi

echo "OK  no allow(dead_code) in web/api"
