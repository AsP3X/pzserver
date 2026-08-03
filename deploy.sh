#!/usr/bin/env bash
# One-command deploy for Project Zomboid B42 server stack + web panel.
# Does NOT require Make — only Docker Compose v2 + bash.
#
# Usage:
#   ./deploy.sh              # first-time setup or start
#   ./deploy.sh --init       # force setup wizard
#   ./deploy.sh --status     # status only
#   ./deploy.sh --down       # stop stack
#   ./deploy.sh --help

set -euo pipefail
cd "$(dirname "$0")"
# shellcheck disable=SC1091
source scripts/compose-env.sh

show_help() {
  cat <<'EOF'

  Project Zomboid Server + Admin Panel (Docker)

  Usage:
    ./deploy.sh              First-time setup or start stack
    ./deploy.sh --init       Force setup wizard again
    ./deploy.sh --status     Show URLs and container status
    ./deploy.sh --down       Stop all services
    ./deploy.sh --help       This help

  After deploy:
    Panel:   http://localhost:8000
    Game:    UDP 16261 + 16262 (forward these for remote players)
    Data:    ./data/zomboid  ./data/server  ./data/backups

  Day-to-day (no Make needed):
    ./deploy.sh              start (if .env exists) — builds local fixed images
    ./deploy.sh --down       stop
    ./deploy.sh --status     status
    ./deploy.sh --rebuild-game   rebuild game-server (upstream + our entrypoints)
    source scripts/compose-env.sh && pz_compose build app game-server

EOF
}

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: Docker is not installed or not on PATH."
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "ERROR: Docker Compose v2 is required (docker compose)."
  exit 1
fi

case "${1:-}" in
  --help|-h)
    show_help
    exit 0
    ;;
  --status)
    pz_info
    exit 0
    ;;
  --down)
    echo "Stopping stack…"
    pz_down
    exit 0
    ;;
  --rebuild-game)
    pz_rebuild_game
    exit 0
    ;;
  --init)
    echo "Running first-time setup (wizard)..."
    echo "  Defaults: B42 Stable (public), local panel on :8000"
    bash scripts/setup.sh
    exit 0
    ;;
esac

echo ""
echo "===================================================="
echo "  Project Zomboid B42 - Full Stack Deploy"
echo "  Game server + web panel + RCON + backups"
echo "===================================================="
echo ""

if [[ ! -f .env || ! -f app/.env ]]; then
  echo "Running first-time setup (wizard)..."
  echo "  Defaults: B42 Stable (public), local panel on :8000"
  echo "  Press Enter through prompts to accept defaults."
  echo ""
  bash scripts/setup.sh
  exit 0
fi

echo "Environment found — starting / redeploying stack..."
echo "(Progress lines below come from the deploy helper; builds can take a few minutes.)"
echo ""
pz_up
echo ""
pz_info
