MAKEFLAGS += --no-print-directory

# macOS reports arm64; Linux ARM reports aarch64. Both need the ARM64 game image.
ARCH := $(shell uname -m)
ifeq ($(filter $(ARCH),aarch64 arm64),$(ARCH))
	ARCH_FILE := docker-compose.arm64.yml
else
	ARCH_FILE := docker-compose.amd64.yml
endif

# WEB_PROXY_MODE from .env: local | caddy | npm (default local)
WEB_PROXY_MODE := $(shell sed -n 's/^WEB_PROXY_MODE=//p' .env 2>/dev/null | tail -1 | tr -d '\r' | tr A-Z a-z)
ifeq ($(WEB_PROXY_MODE),)
	WEB_PROXY_MODE := local
endif
ifeq ($(WEB_PROXY_MODE),ports)
	WEB_PROXY_MODE := caddy
endif
ifeq ($(filter $(WEB_PROXY_MODE),external proxy traefik),$(WEB_PROXY_MODE))
	WEB_PROXY_MODE := npm
endif

COMPOSE_BASE := docker compose -f docker-compose.yml -f $(ARCH_FILE) -f docker-compose.web.yml
ifeq ($(WEB_PROXY_MODE),caddy)
	COMPOSE := $(COMPOSE_BASE) -f docker-compose.web-caddy.yml --profile caddy
else ifeq ($(WEB_PROXY_MODE),npm)
	COMPOSE := $(COMPOSE_BASE) -f docker-compose.web-npm.yml
else
	COMPOSE := $(COMPOSE_BASE)
endif

PZ_GAME_PORT ?= 16261
PZ_DIRECT_PORT ?= 16262
WEB_UI_PORT ?= 8100
CADDY_HTTP_PORT ?= 80
CADDY_HTTPS_PORT ?= 443

FW_DISPATCH := bash scripts/firewall/dispatch.sh

.PHONY: up down build rebuild rebuild-game map-tiles map-tiles-region map-tiles-detail map-tiles-recompress map-tiles-import map-tiles-maybe-import restart logs ps stop pull migrate test test-game-server exec arch init setup db-check db-init db-reset db-backup db-restore nuke workshop-package update-version update \
	admin-expose admin-hide expose hide info \
	web-up web-down web-build web-logs web-ps web-dev-db web-seed web-test web-check

# ── First-run setup ──────────────────────────────────────────────────
# Interactive wizard: configures env, creates DB volume, starts services,
# and provisions the admin account. Safe to re-run (prompts before overwrite).
init:
	@bash scripts/setup.sh

setup: init

db-check: ensure-data-dirs

db-init: ensure-data-dirs
	@echo "Postgres data dir: ./data/postgres (bind mount). Run 'make up' to start."

db-reset:
	@echo "WARNING: This will PERMANENTLY delete ./data/postgres."
	@echo "Type RESET_DB and press Enter to continue:"
	@read confirm; \
	if [ "$$confirm" != "RESET_DB" ]; then \
		echo "Cancelled."; \
		exit 1; \
	fi
	@$(COMPOSE) down
	@rm -rf data/postgres
	@mkdir -p data/postgres
	@echo "Postgres data dir recreated. Run 'make up' to start with an empty DB."

# ── Informational output ────────────────────────────────────────────
# Delegates to pz_info in scripts/compose-env.sh, which ./deploy.sh --status also
# calls. Keeping two hand-written copies is how `make info` ended up correct
# about the panel port while its PowerShell twin still advertised the parked
# Laravel one. make.ps1 keeps a separate copy only because it cannot source bash.
info:
	@bash -c '. scripts/compose-env.sh && pz_info'

# ── Firewall helpers ────────────────────────────────────────────────
# These targets dispatch to OS-specific scripts via .firewall.conf.
# Nothing here is permanent — all rules are runtime only.

# ── Core commands ────────────────────────────────────────────────────
# Default startup keeps the admin UI local-only and does not change firewall rules.

# Host bind-mount dirs (all persistent data lives under ./data/)
ensure-data-dirs:
	@mkdir -p data/zomboid/Lua data/server/media/texturepacks data/backups \
		data/map-tiles/html/map_data/base \
		data/postgres data/redis \
		data/caddy-data data/caddy-config data/web-postgres
	@if [ ! -f data/map-tiles/html/map_data/base/map_info.json ] && [ -f web/tools/map-tiles/map_info.vanilla.json ]; then \
		cp web/tools/map-tiles/map_info.vanilla.json data/map-tiles/html/map_data/base/map_info.json; \
	fi

# Public edge network is external; create if the host does not already have it
ensure-networks:
	@docker network inspect proxy-network >/dev/null 2>&1 || docker network create proxy-network >/dev/null

# Drop data/map-tiles/tiles.sqlite on the host and this copies it into the
# named volume when that volume is still empty. `make up` never renders the
# county (~hours, ~24 GB); generate with `make map-tiles` or upload the file.
map-tiles-maybe-import:
	@bash scripts/prepare-map-tiles.sh

up: ensure-data-dirs ensure-networks map-tiles-maybe-import
	$(COMPOSE) up -d --build --remove-orphans

down:
	$(COMPOSE) down

nuke:
	@echo "WARNING: This will destroy ALL data under ./data/ plus env/config."
	@echo "Type NUKE_ALL and press Enter to continue:"
	@read confirm; \
	if [ "$$confirm" != "NUKE_ALL" ]; then \
		echo "Cancelled."; \
		exit 1; \
	fi
	$(COMPOSE) down --remove-orphans
	@REMAINING=$$(docker volume ls -q --filter name=pz- 2>/dev/null | grep -v map-tiles || true); \
	if [ -n "$$REMAINING" ]; then \
		echo "Removing leftover legacy volumes: $$REMAINING"; \
		echo "$$REMAINING" | xargs docker volume rm 2>/dev/null || true; \
	fi
	@echo "Keeping data/map-tiles and pz-map-tiles-sqlite (website map). Delete those by hand."
	@if [ -d data ]; then \
		find data -mindepth 1 -maxdepth 1 ! -name map-tiles -exec rm -rf {} +; \
	fi
	@mkdir -p data/zomboid/Lua data/server data/backups data/map-tiles \
		data/postgres data/redis \
		data/caddy-data data/caddy-config
	@rm -f .env .firewall.conf
	@rm -f caddy/Caddyfile caddy/certs/cert.pem caddy/certs/key.pem
	@echo "Nuke complete. ./data and config removed."

build:
	$(COMPOSE) build

# Rebuild the local fixed images on top of their upstream bases, then start.
# Mirrors ./deploy.sh --rebuild and .\make.ps1 rebuild.
rebuild: ensure-data-dirs ensure-networks
	$(COMPOSE) build --pull web-api web-ui game-server
	$(MAKE) up

# Rebuild only the game-server overlay (upstream base + our entrypoints).
rebuild-game:
	$(COMPOSE) build --pull game-server
	$(COMPOSE) up -d game-server

# Scratch (html tree, texture cache) stays in data/map-tiles. The packed
# tiles.sqlite lives in the pz-map-tiles-sqlite volume so tile reads are not
# taxed by a Windows Docker bind. Takes hours and about 15 GB. Safe to interrupt.
map-tiles:
	@# Docker cannot create a mountpoint inside a read-only bind mount, and /pz
	@# is one. Without this the run dies on "read-only file system" before it
	@# reaches the texture check.
	@mkdir -p data/server/media/texturepacks
	$(COMPOSE) --profile tools build map-tiles
	$(COMPOSE) --profile tools run --rm -e PZ_MAP_CELLS="$(CELLS)" -e PZ_MAP_SQUARES="$(SQUARES)" map-tiles

# Redraw part of the map instead of all of it, for when the world has changed:
#   make map-tiles-region SQUARES="8704,7680,256,256"  x, y, width, height in world squares
#   make map-tiles-region CELLS="34,30,4,4"            x, y, width, height in cells
#   make map-tiles-region CELLS="34,30"                one cell
#   make map-tiles-region CELLS="34,30;40,12"          several
# Minutes rather than hours, and it updates the existing pack in place.
map-tiles-region:
	@test -n "$(CELLS)$(SQUARES)" || { echo "set CELLS= or SQUARES=, e.g. make map-tiles-region SQUARES=\"8704,7680,256,256\""; exit 1; }
	@mkdir -p data/server/media/texturepacks
	$(COMPOSE) --profile tools build map-tiles
	$(COMPOSE) --profile tools run --rm --use-aliases -e PZ_MAP_CELLS="$(CELLS)" -e PZ_MAP_SQUARES="$(SQUARES)" -e PZ_MAP_SAVE=1 map-tiles

# Paint z21 for a region without redrawing z20…0. Minutes per cell, not hours.
# Missing z21 tiles 404 and the client upscales from z20 until this lands.
map-tiles-detail:
	@test -n "$(CELLS)$(SQUARES)" || { echo "set CELLS= or SQUARES=, e.g. make map-tiles-detail CELLS=\"34,30\""; exit 1; }
	@mkdir -p data/server/media/texturepacks
	$(COMPOSE) --profile tools build map-tiles
	$(COMPOSE) --profile tools run --rm -e PZ_MAP_CELLS="$(CELLS)" -e PZ_MAP_SQUARES="$(SQUARES)" -e PZ_MAP_DETAIL_ONLY=1 -e PZ_MAP_DETAIL=21 map-tiles

# Re-encode packed JPEGs at quality 70 in place (WAL). Does not VACUUM.
map-tiles-recompress:
	$(COMPOSE) --profile tools build map-tiles
	$(COMPOSE) --profile tools run --rm --entrypoint python map-tiles /tools/recompress.py /pack/tiles.sqlite

# Copy an existing host pack into the named volume. Run with web-api down, or
# against an empty volume — overwriting a live open sqlite is the Windows
# filename-reservation trap again. Prints an in-place progress line while it
# copies. -t is only passed when stdout is a real tty: that is what makes
# isatty(2) true inside Alpine so the script can use CR instead of newlines.
# $(shell [ -t 1 ]) is the wrong test — make captures $(shell) stdout, so
# that is never a tty.
map-tiles-import:
	@test -f data/map-tiles/tiles.sqlite || { echo "no data/map-tiles/tiles.sqlite to import"; exit 1; }
	@docker volume create pz-map-tiles-sqlite >/dev/null
	@tty=; \
	if [ -t 1 ]; then tty=-t; fi; \
	cols=$${COLUMNS:-$$(tput cols 2>/dev/null || echo 80)}; \
	docker run --rm $$tty \
		-e TERM \
		-e NO_COLOR \
		-e COLUMNS="$$cols" \
		-v pz-map-tiles-sqlite:/pack \
		-v "$(CURDIR)/data/map-tiles:/src:ro" \
		-v "$(CURDIR)/web/tools/map-tiles/import.sh:/import.sh:ro" \
		alpine:3.20 sh /import.sh

# SVC limits these to named services, e.g. make logs SVC="game-server web-api"
restart:
	$(COMPOSE) restart $(SVC)

stop:
	$(COMPOSE) stop

logs:
	$(COMPOSE) logs -f --tail 200 $(SVC)

ps:
	$(COMPOSE) ps

pull:
	$(COMPOSE) pull

# ── Game firewall exposure ──────────────────────────────────────────
# Separate from up/down on purpose. Game ports only (UDP).
expose:
	@PZ_GAME_PORT=$(PZ_GAME_PORT) PZ_DIRECT_PORT=$(PZ_DIRECT_PORT) $(FW_DISPATCH) game-open
	@$(MAKE) info

hide:
	@PZ_GAME_PORT=$(PZ_GAME_PORT) PZ_DIRECT_PORT=$(PZ_DIRECT_PORT) $(FW_DISPATCH) game-close

# ── Admin UI exposure ───────────────────────────────────────────────
# Opens Caddy web ports in the firewall for public HTTPS access.
# Ports are read from .firewall.conf (set during 'make init').
# web-ui stays bound to 127.0.0.1:$(WEB_UI_PORT) — never exposed directly.
# Requires Caddy to be configured (run 'make init' first).
admin-expose:
	@if [ ! -f .firewall.conf ]; then echo "Error: run 'make init' first."; exit 1; fi
	@. ./.firewall.conf; \
	HTTP="$${ADMIN_HTTP_PORT:-80}"; \
	HTTPS="$${ADMIN_HTTPS_PORT:-443}"; \
	CADDY_HTTP_PORT=$$HTTP CADDY_HTTPS_PORT=$$HTTPS $(FW_DISPATCH) admin-open; \
	echo "Admin panel exposed via Caddy on ports $$HTTP/$$HTTPS"; \
	echo "Local:  http://localhost:$(WEB_UI_PORT)"; \
	HOST="$${ADMIN_PUBLIC_HOST:-}"; \
	if [ -n "$$HOST" ] && [ "$$HOST" != "localhost" ]; then \
		if [ "$$HTTPS" = "443" ]; then \
			echo "Public: https://$$HOST"; \
		else \
			echo "Public: https://$$HOST:$$HTTPS"; \
		fi; \
	fi

admin-hide:
	@if [ ! -f .firewall.conf ]; then echo "Error: run 'make init' first."; exit 1; fi
	@. ./.firewall.conf; \
	HTTP="$${ADMIN_HTTP_PORT:-80}"; \
	HTTPS="$${ADMIN_HTTPS_PORT:-443}"; \
	CADDY_HTTP_PORT=$$HTTP CADDY_HTTPS_PORT=$$HTTPS $(FW_DISPATCH) admin-close; \
	echo "Admin panel restricted to local access."; \
	echo "Local:  http://localhost:$(WEB_UI_PORT)"

# ── App commands ─────────────────────────────────────────────────────
# migrate, test and exec drove the Laravel app container, parked in c318e99.
# They fail loudly rather than silently targeting a service that is not there.
migrate:
	@echo "There is no migrate step any more."
	@echo "  web-api runs its sqlx migrations itself at start-up, so bringing the"
	@echo "  container up is what applies them:  make restart SVC=web-api"
	@exit 1

test:
	@echo "The Laravel suite went away with the app container in c318e99."
	@echo "  make web-test          Rust API tests (cargo test --workspace)"
	@echo "  make web-check         clippy + fmt + tsc + eslint"
	@echo "  make test-game-server  host-side shell and Lua suites"
	@exit 1

# Runs on the host (no containers needed) — exercises configure-server.sh
# against a throwaway config tree to verify env-var precedence.
test-game-server:
	@bash game-server/tests/configure-server.test.sh
	@bash game-server/tests/steam-update-check.test.sh
	@if command -v luajit >/dev/null 2>&1; then \
		luajit game-server/tests/kr-vitals.test.lua && \
		luajit game-server/tests/kr-enrol.test.lua && \
		luajit game-server/tests/kr-report.test.lua && \
		luajit game-server/tests/kr-console.test.lua && \
		luajit game-server/tests/kr-desk.test.lua; \
	else \
		echo "SKIP: Lua suites need luajit (PZ runs Lua 5.1) — brew install luajit"; \
	fi

exec:
	@echo "There is no app container to exec into — it was parked in c318e99."
	@echo "  To run something in a service that does exist, name it:"
	@echo "    docker compose exec web-api <cmd>"
	@echo "    docker compose exec game-server <cmd>"
	@exit 1

arch:
	@echo "Detected: $(ARCH) -> $(ARCH_FILE)"

# ── Database ─────────────────────────────────────────────────────────
db-backup:
	@mkdir -p db-backups
	@echo "Backing up database..."
	@docker exec pz-db pg_dump -U zomboid -d zomboid --no-owner \
		> db-backups/backup-$$(date +%Y%m%d-%H%M%S).sql 2>/dev/null \
		&& echo "Backup saved to db-backups/" \
		|| echo "No database to backup (first run?)"

db-restore:
	@LATEST=$$(ls -t db-backups/*.sql 2>/dev/null | head -1); \
	if [ -z "$$LATEST" ]; then \
		echo "No backups found in db-backups/"; \
	else \
		echo "Restoring from $$LATEST ..."; \
		docker exec -i pz-db psql -U zomboid -d zomboid < "$$LATEST"; \
		echo "Restored."; \
	fi

# ── Workshop ────────────────────────────────────────────────────────
workshop-package:
	bash scripts/workshop-package.sh

# ── Update from git ─────────────────────────────────────────────────
# Pulls the latest code, rebuilds, runs migrations, rebuilds frontend
# assets, and restarts game-server so it picks up entrypoint script
# changes. Refuses to run if the working tree is dirty.
update:
	@echo ""
	@echo "════════ Zomboid Manager — Update ════════"
	@echo ""
	@if ! git diff --quiet || ! git diff --cached --quiet; then \
		echo "Working tree has uncommitted changes to tracked files:"; \
		git status --short | grep -v '^??' || true; \
		echo ""; \
		echo "Commit or stash them, then run 'make update' again."; \
		exit 1; \
	fi
	@BRANCH=$$(git rev-parse --abbrev-ref HEAD); \
	if [ "$$BRANCH" = "HEAD" ]; then \
		echo "Cannot run 'make update' from a detached HEAD checkout."; \
		echo "Check out a branch first, then run 'make update' again."; \
		exit 1; \
	fi; \
	echo "→ Pulling latest from origin/$$BRANCH ..."; \
	git fetch --tags origin "$$BRANCH" || { echo "git fetch failed."; exit 1; }; \
	BEFORE=$$(git rev-parse HEAD); \
	git pull --ff-only origin "$$BRANCH" || { \
		echo ""; \
		echo "Cannot fast-forward (local has diverged). Resolve manually with:"; \
		echo "  git status"; \
		echo "  git log HEAD..origin/$$BRANCH --oneline"; \
		exit 1; \
	}; \
	AFTER=$$(git rev-parse HEAD); \
	if [ "$$BEFORE" = "$$AFTER" ]; then \
		echo "  Already up to date."; \
	else \
		echo "  $$BEFORE → $$AFTER"; \
		echo ""; \
		echo "  New commits:"; \
		git log --oneline "$$BEFORE..$$AFTER" | sed 's/^/    /'; \
	fi
	@echo ""
	@echo "→ Rebuilding containers ..."
	$(COMPOSE) up -d --build
	@echo ""
	@echo "→ Waiting for web-api ..."
	@for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do \
		if $(COMPOSE) exec -T web-api true >/dev/null 2>&1; then break; fi; \
		sleep 2; \
	done; \
	if ! $(COMPOSE) exec -T web-api true >/dev/null 2>&1; then \
		echo "Error: web-api container did not become ready within 30s."; \
		echo "Check 'make logs' for details."; \
		exit 1; \
	fi
	@echo ""
	@echo "→ Restarting game-server (picks up entrypoint script changes) ..."
	$(COMPOSE) restart game-server
	@echo ""
	@echo "════════ Update complete ════════"
	@echo ""
	@echo "Tail logs:           make logs"
	@echo "Game-server only:    $(COMPOSE) logs -f game-server"
	@echo ""

# ── Game version ────────────────────────────────────────────────────
# Updates game-version.conf with the current PZ version.
# This file is used by tests — it does NOT control which version SteamCMD downloads.
update-version:
	@echo "Current version:"
	@if [ -f game-version.conf ]; then \
		. ./game-version.conf; \
		echo "  $$PZ_VERSION"; \
		echo "  $$PZ_VERSION_FULL"; \
	else \
		echo "  (not set)"; \
	fi
	@echo ""
	@echo "Paste the full version string from the game"
	@echo "(e.g. 42.16.1 679520210a22497d1cb91ca6105ed544637604c6 2026-04-02 14:57:34 (ZB))"
	@echo ""
	@echo -n "> "; read FULL; \
	if [ -z "$$FULL" ]; then echo "Cancelled."; exit 1; fi; \
	VER=$$(echo "$$FULL" | grep -oE '^[0-9]+\.[0-9]+(\.[0-9]+)*'); \
	if [ -z "$$VER" ]; then echo "Error: could not parse version number."; exit 1; fi; \
	sed -i "s|^PZ_VERSION=.*|PZ_VERSION=$$VER|" game-version.conf; \
	sed -i "s|^PZ_VERSION_FULL=.*|PZ_VERSION_FULL=$$FULL|" game-version.conf; \
	echo ""; \
	echo "Updated game-version.conf:"; \
	echo "  PZ_VERSION=$$VER"; \
	echo "  PZ_VERSION_FULL=$$FULL"

# ── Web stack extras (Rust API + Vite UI + own Postgres) ─────────────
# docker-compose.web.yml is already in COMPOSE_BASE so `make up` starts it.
COMPOSE_WEB := $(COMPOSE_BASE)
COMPOSE_WEB_DEV := $(COMPOSE_WEB) -f docker-compose.web-dev.yml

WEB_DB_PORT ?= 55433
WEB_DB_USER ?= $(shell sed -n 's/^WEB_DB_USERNAME=//p' .env 2>/dev/null | tail -1 | tr -d '\r')
WEB_DB_NAME ?= $(shell sed -n 's/^WEB_DB_DATABASE=//p' .env 2>/dev/null | tail -1 | tr -d '\r')
ifeq ($(WEB_DB_USER),)
	WEB_DB_USER := knox
endif
ifeq ($(WEB_DB_NAME),)
	WEB_DB_NAME := knox
endif

ensure-web-data-dirs:
	@mkdir -p data/web-postgres data/backups

web-up: ensure-web-data-dirs ensure-networks
	$(COMPOSE_WEB) up -d --build web-db web-api web-ui

web-down:
	$(COMPOSE_WEB) down

web-build:
	$(COMPOSE_WEB) build web-api web-ui

web-logs:
	$(COMPOSE_WEB) logs -f web-api web-ui

web-ps:
	$(COMPOSE_WEB) ps

# Database only, published on 127.0.0.1:$(WEB_DB_PORT) for host development
# (cargo run + npm run dev). See web/README.md.
web-dev-db: ensure-web-data-dirs
	$(COMPOSE_WEB_DEV) up -d web-db
	@echo "web-db ready on 127.0.0.1:$(WEB_DB_PORT)"

# Development data for the public site. Truncates the tables it fills.
web-seed:
	@echo "WARNING: this replaces player_stats, game_events and status samples in $(WEB_DB_NAME)."
	@echo "Type SEED and press Enter to continue:"
	@read confirm; \
	if [ "$$confirm" != "SEED" ]; then \
		echo "Cancelled."; \
		exit 1; \
	fi; \
	docker exec -i pz-web-db psql -U $(WEB_DB_USER) -d $(WEB_DB_NAME) -q < web/api/seeds/dev_seed.sql
	@echo "Seeded."

# Host-side checks. No containers needed.
web-test:
	cd web/api && cargo test --workspace

web-check:
	cd web/api && cargo clippy --all-targets --all-features -- -D warnings && cargo fmt --check
	cd web/ui && npx tsc -b && npm run lint

help:
	@echo "Available targets:"
	@echo ""
	@echo "  Setup:"
	@echo "    init           - Interactive first-run setup wizard (detects OS & firewall)"
	@echo "    setup          - Alias for 'init'"
	@echo ""
	@echo "  Services:"
	@echo "    up             - Start services (new UI local-only at localhost:8100)"
	@echo "    down           - Stop services"
	@echo "    build          - Build Docker images"
	@echo "    restart        - Restart services"
	@echo "    stop           - Stop services without removing containers"
	@echo "    logs           - Follow service logs"
	@echo "    ps             - List running containers"
	@echo "    pull           - Pull latest images"
	@echo ""
	@echo "  Firewall (auto-detects backend from .firewall.conf):"
	@echo "    expose         - Open game ports (UDP) in host firewall"
	@echo "    hide           - Close game ports (UDP) in host firewall"
	@echo "    admin-expose   - Open Caddy web ports for public admin HTTPS"
	@echo "    admin-hide     - Close Caddy web ports"
	@echo "                     (ports read from .firewall.conf, set during 'make init')"
	@echo ""
	@echo "  Database:"
	@echo "    db-check       - Check if DB volume exists, create if not"
	@echo "    db-init        - Create DB volume (empty) if it doesn't exist"
	@echo "    db-reset       - Reset DB volume (DANGER: deletes data)"
	@echo "    db-backup      - Backup database to db-backups/"
	@echo "    db-restore     - Restore latest backup from db-backups/"
	@echo ""
	@echo "  App:"
	@echo "    migrate        - Run database migrations"
	@echo "    test           - Run tests in the app container"
	@echo "    rebuild        - Rebuild images from upstream bases, then start"
	@echo "    rebuild-game   - Rebuild game-server only"
	@echo "    map-tiles      - Render the isometric basemap locally (hours, ~15 GB)"
	@echo "    map-tiles-region CELLS=\"x,y,w,h\" or SQUARES=\"x,y,w,h\" - Redraw that region (minutes)"
	@echo "    map-tiles-detail CELLS=\"x,y,w,h\" - Paint z21 for those cells (minutes)"
	@echo "    map-tiles-recompress - Re-encode packed JPEGs at quality 70"
	@echo "    map-tiles-import - Copy data/map-tiles/tiles.sqlite into the named volume (prints progress)"
	@echo "    logs SVC=...   - Follow logs for the named services (all if unset)"
	@echo "    restart SVC=.. - Restart the named services (all if unset)"
	@echo ""
	@echo "  Web stack extras (Rust API + Vite UI — already started by 'up'):"
	@echo "    web-up         - Build and start only web-db, web-api and web-ui"
	@echo "    web-down       - Stop the web stack (and other compose services)"
	@echo "    web-logs       - Follow web-api and web-ui logs"
	@echo "    web-ps         - Show second-stack containers"
	@echo "    web-dev-db     - Start only its Postgres, published for host dev"
	@echo "    web-seed       - Load development data (DANGER: truncates tables)"
	@echo "    web-test       - Run the Rust test suite on the host"
	@echo "    web-check      - clippy + rustfmt + tsc + eslint on the host"
	@echo ""
	@echo "  Other:"
	@echo "    info             - Show URLs, public IP, and firewall status"
	@echo "    arch             - Show detected CPU architecture"
	@echo "    update           - Pull latest code, rebuild, migrate, rebuild assets,"
	@echo "                       and restart game-server (refuses if working tree dirty)"
	@echo "    update-version   - Update game-version.conf after a PZ game update"
	@echo "    nuke             - Destroy ALL data and stop services (DANGER)"
	@echo ""
	@echo "  Supported firewall backends: firewalld (Fedora/RHEL), ufw (Ubuntu/Debian), manual"
	@echo "  See docs/firewall-*.md for per-OS documentation."
