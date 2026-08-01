#!/usr/bin/env bash
# One-command deploy for Project Zomboid B42 server stack + web panel.
#
# Usage:
#   ./deploy.sh              # first-time setup or start
#   ./deploy.sh --init       # force setup wizard
#   ./deploy.sh --status     # status only
#   ./deploy.sh --down       # stop stack
#   ./deploy.sh --help

set -euo pipefail
cd "$(dirname "$0")"

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

  Day-to-day:
    make up | down | logs | restart | info | nuke

EOF
}

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: Docker is not installed or not on PATH."
  exit 1
fi

case "${1:-}" in
  --help|-h)
    show_help
    exit 0
    ;;
  --status)
    make info
    make ps
    exit 0
    ;;
  --down)
    make down
    exit 0
    ;;
  --init)
    echo "Running first-time setup (wizard)..."
    echo "  Defaults: B42 Stable (public), local panel on :8000"
    make init
    exit 0
    ;;
esac

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║   Project Zomboid B42 — Full Stack Deploy        ║"
echo "║   Game server + web panel + RCON + backups       ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

if [[ ! -f .env || ! -f app/.env ]]; then
  echo "Running first-time setup (wizard)..."
  echo "  Defaults: B42 Stable (public), local panel on :8000"
  echo "  Press Enter through prompts to accept defaults."
  echo ""
  make init
  exit 0
fi

echo "Environment found — starting stack..."
make up
make info
