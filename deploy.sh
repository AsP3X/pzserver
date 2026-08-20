#!/usr/bin/env bash
# One-command deploy for Project Zomboid B42 server stack + web panel.
# Does NOT require Make — only Docker Compose v2 + bash (3.2 or newer; the
# first-run setup wizard additionally needs bash 4+).
#
# Usage:
#   ./deploy.sh                  # first-time setup or start
#   ./deploy.sh --init           # force setup wizard
#   ./deploy.sh --status         # status only
#   ./deploy.sh --ps             # container table
#   ./deploy.sh --logs [svc...]  # follow logs
#   ./deploy.sh --restart [svc]  # restart services
#   ./deploy.sh --rebuild        # rebuild web + game-server, then start
#   ./deploy.sh --rebuild-game   # rebuild game-server only
#   ./deploy.sh --down           # stop stack
#   ./deploy.sh --help
#
# Environment:
#   PZ_STOP_TIMEOUT   per-container stop timeout in seconds (default 15)
#   WEB_PROXY_MODE    local | caddy | npm (default from .env, else local)
#   NO_COLOR          set to disable coloured output

# -E so the ERR trap is inherited by functions — the pz_* helpers live in
# scripts/compose-env.sh, and a failure in there must still report a diagnosis.
set -Eeuo pipefail

# This script and scripts/compose-env.sh stay bash 3.2 compatible so they run on
# stock macOS. Only scripts/setup.sh needs bash 4+ (it uses `${var,,}`), and that
# requirement is enforced in run_wizard() rather than here.
cd "$(dirname "${BASH_SOURCE[0]}")" || {
  echo "ERROR: cannot enter the repository directory." >&2
  exit 1
}
REPO_ROOT="$(pwd)"

# ── Output helpers ────────────────────────────────────────────────────────────
if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[0;31m'
  GREEN=$'\033[0;32m'; YELLOW=$'\033[0;33m'; CYAN=$'\033[0;36m'; NC=$'\033[0m'
else
  BOLD=''; DIM=''; RED=''; GREEN=''; YELLOW=''; CYAN=''; NC=''
fi

step() { printf '%s→ %s%s\n' "$CYAN" "$*" "$NC"; }
ok()   { printf '%s✓ %s%s\n' "$GREEN" "$*" "$NC"; }
warn() { printf '%sWARNING: %s%s\n' "$YELLOW" "$*" "$NC" >&2; }
die()  { printf '%sERROR: %s%s\n' "$RED" "$*" "$NC" >&2; exit 1; }

CURRENT_STAGE="startup"
on_error() {
  local rc=$? line="$1" cmd="$2" src="${3:-$0}"
  printf '\n%sFailed during: %s%s (exit %s)\n' "$RED$BOLD" "$CURRENT_STAGE" "$NC" "$rc" >&2
  printf '  Command: %s%s%s\n' "$DIM" "$cmd" "$NC" >&2
  printf '  At:      %s%s:%s%s\n' "$DIM" "${src#./}" "$line" "$NC" >&2
  printf '  Inspect the stack:  %s./deploy.sh --ps%s\n' "$DIM" "$NC" >&2
  printf '  Read the logs:      %s./deploy.sh --logs%s\n' "$DIM" "$NC" >&2
  printf '  Stop and retry:     %s./deploy.sh --down && ./deploy.sh%s\n' "$DIM" "$NC" >&2
  exit "$rc"
}
trap 'on_error "$LINENO" "$BASH_COMMAND" "${BASH_SOURCE[0]}"' ERR

show_help() {
  cat <<EOF

  ${BOLD}Project Zomboid Server + Admin Panel (Docker)${NC}

  ${BOLD}Usage:${NC}
    ./deploy.sh                    First-time setup, or start / redeploy the stack
    ./deploy.sh --init             Force the setup wizard again
    ./deploy.sh --status           Show URLs and container status
    ./deploy.sh --ps               Container table only
    ./deploy.sh --logs [svc...]    Follow logs (all services, or the named ones)
    ./deploy.sh --restart [svc...] Restart all services, or the named ones
    ./deploy.sh --rebuild          Rebuild web + game-server images, then start
    ./deploy.sh --rebuild-game     Rebuild game-server only (upstream + our entrypoints)
    ./deploy.sh --down             Stop and remove all services
    ./deploy.sh --help             This help

  ${BOLD}Service names${NC} (for --logs / --restart):
    game-server  web-api  web-ui  web-db  db  redis  docker-socket-proxy  ${DIM}caddy (caddy mode only)${NC}

  ${BOLD}After deploy:${NC}
    Panel:   http://localhost:8100  (default WEB_UI_PORT; --status shows the real one)
    Game:    UDP 16261 + 16262 (forward these for remote players)
    Data:    ./data/zomboid  ./data/server  ./data/backups

  ${BOLD}Environment:${NC}
    PZ_STOP_TIMEOUT   per-container stop timeout, seconds (default 15)
    WEB_PROXY_MODE    local | caddy | npm — overrides the value in .env
    NO_COLOR          disable coloured output

  ${BOLD}Examples:${NC}
    ./deploy.sh --logs game-server        tail just the game server
    ./deploy.sh --restart web-api web-ui  restart the panel services
    PZ_STOP_TIMEOUT=5 ./deploy.sh --down  stop impatiently

EOF
}

# ── Preflight ─────────────────────────────────────────────────────────────────
require_docker() {
  command -v docker >/dev/null 2>&1 ||
    die "Docker is not installed or not on PATH. See https://docs.docker.com/engine/install/"

  docker compose version >/dev/null 2>&1 ||
    die "Docker Compose v2 is required (the 'docker compose' subcommand, not 'docker-compose')."

  local err detail
  if ! err="$(docker info --format '{{.ServerVersion}}' 2>&1)"; then
    # docker prints an empty line for the failed template before the real error,
    # so report the last non-blank line rather than the first.
    detail="$(printf '%s\n' "$err" | grep -v '^[[:space:]]*$' | tail -1 || true)"
    if grep -qi 'permission denied' <<<"$err"; then
      printf '%sERROR: cannot talk to the Docker daemon (permission denied).%s\n' "$RED" "$NC" >&2
      printf '  Add yourself to the docker group, then log out and back in:\n' >&2
      printf '    %ssudo usermod -aG docker "$USER"%s\n' "$DIM" "$NC" >&2
      exit 1
    fi
    printf '%sERROR: the Docker daemon is not reachable.%s\n' "$RED" "$NC" >&2
    printf '  Start it first — Docker Desktop, or: %ssudo systemctl start docker%s\n' "$DIM" "$NC" >&2
    printf '  Docker said: %s%s%s\n' "$DIM" "$detail" "$NC" >&2
    exit 1
  fi
}

require_compose_files() {
  local arch arch_file missing=() f
  arch="$(uname -m 2>/dev/null || echo x86_64)"
  case "$arch" in
    aarch64|arm64) arch_file="docker-compose.arm64.yml" ;;
    *)             arch_file="docker-compose.amd64.yml" ;;
  esac
  for f in docker-compose.yml "$arch_file" scripts/compose-env.sh scripts/setup.sh; do
    [[ -f "$f" ]] || missing+=("$f")
  done
  if (( ${#missing[@]} )); then
    die "incomplete checkout — missing: ${missing[*]}
  Run ./deploy.sh from the repository root (currently: $REPO_ROOT)."
  fi
}

# Steam downloads the whole B42 server; a thin VPS disk fills up mid-build.
check_disk_space() {
  local avail_kb
  avail_kb="$(df -Pk . 2>/dev/null | awk 'NR==2 {print $4}')" || return 0
  [[ "$avail_kb" =~ ^[0-9]+$ ]] || return 0
  if (( avail_kb < 10 * 1024 * 1024 )); then
    warn "only $(( avail_kb / 1024 / 1024 )) GiB free on $REPO_ROOT — the game server download plus images needs ~10 GiB."
  fi
}

# Files created under ./data inherit the invoking user; sudo makes them root-owned
# and the panel (running as the compose user) then cannot write backups or Lua.
warn_about_sudo() {
  if [[ -n "${SUDO_USER:-}" ]]; then
    warn "running under sudo — files in ./data will be owned by root."
    printf '  If Docker works without sudo, re-run as %s%s%s instead.\n' "$BOLD" "$SUDO_USER" "$NC" >&2
  fi
}

# scripts/setup.sh uses bash 4 string expansions; stock macOS bash is 3.2.
find_bash4() {
  local candidate
  for candidate in "${BASH:-bash}" /opt/homebrew/bin/bash /usr/local/bin/bash /usr/bin/bash /bin/bash; do
    command -v "$candidate" >/dev/null 2>&1 || continue
    if [[ "$("$candidate" -c 'echo "${BASH_VERSINFO[0]}"' 2>/dev/null || echo 0)" -ge 4 ]]; then
      command -v "$candidate"
      return 0
    fi
  done
  return 1
}

run_wizard() {
  local wizard_bash
  if [[ ! -t 0 ]]; then
    die "the setup wizard needs an interactive terminal.
  Run ./deploy.sh --init from a terminal, or copy .env.example to .env and
  app/.env.example to app/.env, fill in the secrets, then re-run ./deploy.sh."
  fi
  if ! wizard_bash="$(find_bash4)"; then
    die "the setup wizard needs bash 4 or newer (this shell is ${BASH_VERSION:-unknown}).
  macOS ships bash 3.2. Install a current bash, then re-run:
    brew install bash && ./deploy.sh --init"
  fi
  printf '%s\n' "Running first-time setup (wizard)..."
  printf '%s\n' "  Defaults: B42 Stable (public), local panel on :8000"
  printf '%s\n' "  Press Enter through prompts to accept defaults."
  echo ""
  "$wizard_bash" scripts/setup.sh
}

# ── Argument parsing ──────────────────────────────────────────────────────────
CMD=""
PASSTHRU=()

set_cmd() {
  [[ -z "$CMD" || "$CMD" == "$1" ]] ||
    die "only one command at a time (got '$CMD' and '$1'). See ./deploy.sh --help"
  CMD="$1"
}

while (( $# )); do
  case "$1" in
    -h|--help|help)               set_cmd help ;;
    --status|status)              set_cmd status ;;
    --ps|ps)                      set_cmd ps ;;
    --logs|logs)                  set_cmd logs ;;
    --restart|restart)            set_cmd restart ;;
    --rebuild|rebuild)            set_cmd rebuild ;;
    --rebuild-game|rebuild-game)  set_cmd rebuild-game ;;
    --down|down|--stop|stop)      set_cmd down ;;
    --init|init|--setup|setup)    set_cmd init ;;
    --up|up)                      set_cmd up ;;
    --)                           shift; PASSTHRU+=("$@"); break ;;
    -*)                           die "unknown option: $1
  Valid: --init --status --ps --logs --restart --rebuild --rebuild-game --down --help" ;;
    *)                            PASSTHRU+=("$1") ;;
  esac
  shift
done
CMD="${CMD:-up}"

case "$CMD" in
  logs|restart) ;;
  *)
    if (( ${#PASSTHRU[@]} )); then
      die "unexpected argument: ${PASSTHRU[*]}
  Only --logs and --restart accept service names. See ./deploy.sh --help"
    fi
    ;;
esac

if [[ "$CMD" == "help" ]]; then
  show_help
  exit 0
fi

# ── Load helpers (they need a reachable daemon for anything useful) ───────────
CURRENT_STAGE="preflight"
require_compose_files
require_docker
# shellcheck disable=SC1091
source scripts/compose-env.sh

CURRENT_STAGE="$CMD"
case "$CMD" in
  status)
    pz_info
    exit 0
    ;;
  ps)
    pz_compose ps
    exit 0
    ;;
  logs)
    step "Following logs (Ctrl-C to stop)…"
    # Ctrl-C out of `logs -f` is a normal exit, not a deploy failure.
    trap - ERR
    pz_compose logs -f --tail 200 ${PASSTHRU[@]+"${PASSTHRU[@]}"}
    exit 0
    ;;
  restart)
    step "Restarting ${PASSTHRU[*]:-all services}…"
    pz_compose restart ${PASSTHRU[@]+"${PASSTHRU[@]}"}
    pz_info
    exit 0
    ;;
  down)
    pz_down
    exit 0
    ;;
  rebuild-game)
    pz_rebuild_game
    exit 0
    ;;
  init)
    warn_about_sudo
    check_disk_space
    run_wizard
    exit 0
    ;;
esac

# ── Default: deploy ───────────────────────────────────────────────────────────
echo ""
echo "===================================================="
echo "  ${BOLD}Project Zomboid B42 — Full Stack Deploy${NC}"
echo "  Game server + web panel + RCON + backups"
echo "===================================================="
echo ""

warn_about_sudo
check_disk_space

if [[ ! -f .env || ! -f app/.env ]]; then
  CURRENT_STAGE="setup wizard"
  run_wizard
  exit 0
fi

STARTED_AT=$SECONDS
echo "Environment found — starting / redeploying stack..."
echo "${DIM}(Progress lines below come from the deploy helper; builds can take a few minutes.)${NC}"
echo ""

CURRENT_STAGE="stack build/start"
if [[ "$CMD" == "rebuild" ]]; then
  step "Rebuilding images from upstream bases (--pull)…"
  pz_compose build --pull web-api web-ui game-server
fi
pz_up

ELAPSED=$(( SECONDS - STARTED_AT ))
echo ""
ok "Deploy finished in $(( ELAPSED / 60 ))m $(( ELAPSED % 60 ))s."
pz_info
