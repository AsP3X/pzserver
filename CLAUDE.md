# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Project Zomboid managed dedicated server for the Georgian gaming community. Dockerized PZ game server with a Rust REST API (`web/api`) for remote management (RCON bridge, config editing, mod management, player admin). Web dashboard is Vite + React in `web/ui`. Knox Relay is the in-game Lua bridge. There is no Laravel/`app` container on this branch.

## Tech Stack

- **API:** Rust (axum + sqlx) in `web/api`
- **Frontend:** React 19 + TypeScript + Tailwind CSS v4 in `web/ui`
- **Database:** PostgreSQL 16 (`web-db` / `./data/web-postgres`)
- **RCON:** Custom Rust Source RCON client (`web/api/crates/pz-rcon`)
- **Docker Control:** Docker Engine API via HTTP to the socket proxy
- **Auth:** Server-side sessions (Argon2id) on the Rust API
- **Testing:** `cargo test` for the API, luajit for Knox Relay, `npx tsc` / eslint for the UI
- **Containers:** Docker Compose v2 with multi-arch support (ARM64 + AMD64)
- **Game mod:** Knox Relay (`game-server/mods/KnoxRelay`)

## Commands

```bash
# Full stack (auto-detects ARM64/AMD64)
make up
make down
make logs
make ps

# Panel / API
make web-test
make web-check
make restart SVC=web-api

# Knox Relay (host, Lua 5.1)
make test-game-server
luajit game-server/tests/kr-desk.test.lua

# Check detected architecture
make arch

# Update game version after a PZ update (edits game-version.conf)
make update-version
```

There is no `make exec` / `php artisan` path. `web-api` applies sqlx migrations on start.

## Architecture

### Docker Compose — Multi-Arch Setup

The stack uses compose overrides for automatic architecture detection:
- `docker-compose.yml` — game-server skeleton, docker-socket-proxy, optional Caddy
- `docker-compose.web.yml` — web-api, web-ui, web-db
- `docker-compose.arm64.yml` — ARM64 game server (`ghcr.io/joyfui/project-zomboid-server-docker-arm64`) with custom entrypoint + `configure-server.sh`
- `docker-compose.amd64.yml` — AMD64 game server (`renegademaster/zomboid-dedicated-server`) with native env var mapping
- `Makefile` — detects `uname -m` and selects the correct override automatically

### Services

1. **game-server** — PZ dedicated server (SteamCMD). Ports 16261-16262/udp exposed to host. RCON on 27015/tcp internal only. Image varies by architecture.
2. **web-api** — Rust control plane. Talks to the game server via RCON, Docker, and the Lua bridge files.
3. **web-ui** — Nginx serving the Vite build. Local panel on `127.0.0.1:8100`.
4. **web-db** — PostgreSQL for the panel (shop, vault, users, site copy). Internal only.

### Integration Points

- **RCON** (`web/api/crates/pz-rcon`) — Source RCON TCP protocol. Player commands, broadcasts, saves.
- **Docker Engine API** — HTTP to the socket proxy. Start/stop/restart game-server.
- **File I/O** (`web/api/crates/pz-bridge`) — `server.ini`, sandbox, Knox Relay JSON under `data/zomboid/Lua`.
- **Map** — Admin map: vector pack and/or local isometric `tiles.sqlite` / live sprites. Docs: `docs/map-tiles.md`, `docs/map-sprites.md`, `docs/map-vector.md`.

## The UI panel is the single point of truth

The admin panel is the authority for mods, server settings, and site config. `.env`, SteamCMD, and a stock `server.ini` only seed a first boot. After the panel has written `.mod_state`, `.config_state`, or Postgres rows, those win. Do not overwrite them from env defaults, and do not delete them on a world wipe. Canonical copy: `AGENTS.md`.

## Knox Relay — server and client always get the latest Lua

When the user updates Knox Relay, the **local dedicated server and the PZ client** must both be running that same Lua before you stop. A “no” to Workshop does **not** skip this.

**Do not bump** `modversion=` or `KR_Bridge.VERSION` unless the user answered **yes** to the Workshop-release question. After any Knox Relay change: deploy server + client first, then ask with the question dialog: “Prepare the next Knox Relay Workshop release?” Yes → bump, changenote, package, Contents-only sync, deploy again. No → leave the version alone; server and client already have the Lua.

Knox Relay Version is never blank: `modversion=` in `42/`, `common/`, and root `mod.info` must match `KR_Bridge.VERSION`. Other mods with no `modversion=` stay blank — never fill Version from a Steam date. Canonical copy: `AGENTS.md`.

Same-turn server deploy: rebuild and recreate `game-server` (`docker compose -f docker-compose.yml -f docker-compose.amd64.yml up -d --build --force-recreate game-server`). Confirm `Initializing server-side bridge mod vX.Y` and `data/zomboid/Lua/game_state.json` `"mod_version":"X.Y"`.

Same-turn client deploy: copy the source tree into `%ProgramFiles(x86)%\Steam\steamapps\workshop\content\108600\3777446787\mods\KnoxRelay`. The user must fully quit and relaunch PZ.

Canonical copy: `AGENTS.md`. Publish flow: `docs/workshop-updates.md`.

## Key Design Constraints

- API must never crash when the game server is offline — return status, not 500s
- RCON port never exposed publicly, only on internal Docker network
- PZ uses **semicolons** (not commas) as list separators in server.ini (`Mods=`, `WorkshopItems=`, `Map=`)
- Config parsers must pass round-trip tests: read → write → read = identical output
- Every admin API action writes to the `audit_logs` table via `AuditLogger` service
- Mod management must keep `WorkshopItems=` and `Mods=` lines in sync (paired entries, semicolon-separated)
- PZ whitelist lives in a SQLite file (`serverPZ.db`), not PostgreSQL — API reads/writes it directly via separate DB connection
- Auth: session cookies on the Rust API for the web dashboard. Public `/api/health` stays unauthenticated.
- **Atomic shop operations (deliver-then-debit):**
  - **Deposits:** Items removed from inventory → verified removed → wallet credited (items-first)
  - **Purchases:** RCON gives items to online player → wallet debited on confirmation. Lua queue as fallback for offline players.
  - RCON `additem` is the only reliable way to give items in PZ multiplayer (items appear and are fully usable). Lua `inventory:AddItem()` doesn't sync to clients.
  - `wallet_transaction_id` on `shop_purchases` is nullable — starts NULL, set when debit completes
  - Available wallet balance subtracts pending purchase holds to prevent double-spending
  - If debit fails after delivery (rare race), items are rolled back via `removeItem` queue

## Security Conventions

- **Rate limiting:** Sensitive admin actions (kick/ban/password/RCON/server control/wipe) are throttled in the Rust API. Do not add unbounded destructive endpoints.
- **Health endpoint:** `/api/health` is public (returns `status` only). Detailed health is authenticated.
- **RCON** is never published on the host, only on `pzserver-internal`.
- Do not log passwords, session tokens, or RCON secrets.

## Rust: never silence unused code

`#[allow(dead_code)]` is forbidden. The workspace `deny`s `dead_code`; `make web-check` greps for the attribute. Unused items are deleted or wired into a real path — never allowed, expected, or dummy-read. Canonical copy: `AGENTS.md`.

### Internationalization (i18n)
- **Never hardcode user-facing strings** in React components — always use `t()` from `useTranslation()` (`web/ui/src/i18n/use-translation.ts`)
- This applies to ALL pages: public, admin, auth, and shared components
- English defaults live in `web/ui/src/i18n/en.json`, German in `de.json`
- DB overrides (via Translations admin page) take priority over JSON file defaults
- When adding a new page or component, add all its translation keys to both locale files
- Use `:placeholder` syntax for dynamic values: `t('admin.players.count', { count: players.length })`

### General
- Follow existing code conventions — check sibling files for structure and naming
- Check for existing components to reuse before writing new ones
- Stick to existing directory structure; don't create new base folders without approval
- Do not change dependencies without approval
