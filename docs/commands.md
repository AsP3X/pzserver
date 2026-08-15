# Command Reference

All commands are available via `make` (Linux) or `.\make.ps1` (Windows PowerShell).

## Setup

| Linux | Windows | Description |
|-------|---------|-------------|
| `make init` | `.\make.ps1 init` | Interactive first-run setup wizard |
| `make setup` | `.\make.ps1 setup` | Alias for `init` |
| `-` | `.\easy-init.ps1` | Convenience wrapper for `.\make.ps1 init` |
| `-` | `.\easy-deploy.ps1` | Convenience wrapper for `.\make.ps1 deploy` |

## Services

| Linux | Windows | Description |
|-------|---------|-------------|
| `-` | `.\make.ps1 deploy` | Start services, or run setup first if env is missing |
| `make up` | `.\make.ps1 up` | Start all services |
| `make down` | `.\make.ps1 down` | Stop all services |
| `make build` | `.\make.ps1 build` | Build Docker images |
| `make restart` | `.\make.ps1 restart` | Restart all services |
| `make stop` | `.\make.ps1 stop` | Stop without removing containers |
| `make logs` | `.\make.ps1 logs` | Follow service logs |
| `make ps` | `.\make.ps1 ps` | List running containers |
| `make pull` | `.\make.ps1 pull` | Pull latest images |

## Firewall

| Linux | Windows | Description |
|-------|---------|-------------|
| `make expose` | `.\make.ps1 expose` | Open game ports (UDP 16261-16262) |
| `make hide` | `.\make.ps1 hide` | Close game ports |
| `make admin-expose` | `.\make.ps1 admin-expose` | Open admin HTTPS ports |
| `make admin-hide` | `.\make.ps1 admin-hide` | Close admin HTTPS ports |

Linux auto-detects the firewall backend (firewalld, ufw, or manual). Windows uses Windows Firewall via `netsh`.

## Database

| Linux | Windows | Description |
|-------|---------|-------------|
| `make db-check` | `.\make.ps1 db-check` | Check/create DB volume |
| `make db-init` | `.\make.ps1 db-init` | Create empty DB volume |
| `make db-reset` | `.\make.ps1 db-reset` | Reset DB volume (**danger**) |
| `make db-backup` | `.\make.ps1 db-backup` | Backup database to `db-backups/` |
| `make db-restore` | `.\make.ps1 db-restore` | Restore latest backup |

## App

| Linux | Windows | Description |
|-------|---------|-------------|
| `make migrate` | `.\make.ps1 migrate` | Run database migrations |
| `make test` | `.\make.ps1 test` | Run the test suite |
| `make exec CMD="..."` | `.\make.ps1 exec php artisan ...` | Run command in app container |

### Common exec examples

```bash
# Code formatting
make exec CMD="vendor/bin/pint --dirty --format agent"

# Generate routes
make exec CMD="php artisan wayfinder:generate"

# Frontend build
make exec CMD="npm run build"

# Clear cache
make exec CMD="php artisan config:clear"
```

### Server wipe (world reset, keep sandbox/spawns)

Admin → Dashboard → **Wipe** (or `POST /admin/server/wipe`).

**Deletes (game):** `Saves/Multiplayer/*` (map, players, vehicles, zombie pop), `db/{ServerName}.db`, PZ `backups/startup` + `backups/version` (auto-restore archives), Lua bridge live JSON/inventory state.

**Deletes (website):** every website account (players and staff), plus wallets, vaults, shop purchases/deliveries, money deposits, reward claims, whitelist entries, player reports, player_stats, game_events, pvp_violations, vehicle_key_holders, their sessions/tokens, and audit logs. The first administrator is recreated from `ADMIN_USERNAME` / `ADMIN_PASSWORD`.

**Keeps:** `Server/{name}.ini`, `{name}_SandboxVars.lua` (zombies/environment/loot), `{name}_spawnpoints.lua`, `{name}_spawnregions.lua`, mod state files; shop catalog, site settings, translations, news, backup records.

Requires the **queue worker** (`pz-queue`) to be running. A pre-wipe backup is attempted first.

### Map basemap (admin player map)

The Player map has a **Map view** toggle (persisted in the browser):

| Mode | Behaviour | Docs |
|------|-----------|------|
| **Vector (2D)** | Default schematic basemap from `worldmap.xml` | [map-vector.md](map-vector.md) |
| **3D isometric** | Game-like tiles — **live CDN first**, optional local pack | [map-tiles.md](map-tiles.md) |

#### Vector pack (default)

Rebuild after a game map update **or when Map= / map mods change**:

```bash
# Show Map= folders resolved from server.ini + Workshop
docker exec -it pz-app php artisan zomboid:build-worldmap-vector --list-only

# Merge vanilla + map mods into public/map-vector/vanilla/map.json
docker exec -it pz-app php artisan zomboid:build-worldmap-vector

# Include workshop worldmaps not listed on Map=
docker exec -it pz-app php artisan zomboid:build-worldmap-vector --scan-workshop

# Single worldmap only (skip Map= discovery)
docker exec -it pz-app php artisan zomboid:build-worldmap-vector \
  --xml="/pz-server/media/maps/Muldraugh, KY/worldmap.xml"

# Compose service name / Make
docker compose exec app php artisan zomboid:build-worldmap-vector
make exec CMD="php artisan zomboid:build-worldmap-vector"
```

**Admin UI (no SSH):** Admin → Player map → **Vector basemap** → **Rebuild vector basemap** (`POST /admin/players/map/bake-vector`).

#### 3D isometric (live CDN + optional local)

- **Live immediately:** 3D mode uses `map.projectzomboid.com` when no local pack is ready (no server disk load).
- **Optional local:** generate with **lite** (default, low resource) or **full** profile; result packs into `data/map-tiles/tiles.sqlite`.
- Generation never blanks the map — CDN stays visible until local tiles are ready.

```bash
# Clear previous tiles (cleanup before a clean test)
docker exec -it pz-app php artisan zomboid:generate-map-tiles --clear

# Lite generate (recommended on a live server — ground layer, fewer zooms, 1 worker)
docker exec -it pz-app php artisan zomboid:generate-map-tiles --force --profile=lite

# Full detail (heavier — prefer when the game server is idle)
docker exec -it pz-app php artisan zomboid:generate-map-tiles --force --profile=full

# Stop a running job (keeps partial loose tiles)
docker exec -it pz-app php artisan zomboid:generate-map-tiles --stop

# Resume after stop / interrupt
docker exec -it pz-app php artisan zomboid:generate-map-tiles --resume

# Pack an existing multi-file pyramid without re-rendering
docker exec -it pz-app php artisan zomboid:generate-map-tiles --pack-only
```

**Admin UI:** Map view → **3D isometric**; Advanced **Isometric tiles** → Lite/Full → Generate.  
API: `POST /admin/players/map/generate-tiles` with `{ "profile": "lite"|"full", "force"?: bool, "resume"?: bool }`.

Server-wide defaults: `PZ_MAP_BASEMAP=auto|vector|local|proxy` (auto prefers vector; 3D UI still available).

After generation, tiles are **packed into a single SQLite file** (`data/map-tiles/tiles.sqlite`) so the host does not retain millions of loose DZI image files. See [map-tiles.md](map-tiles.md) for full details.

Make / Windows wrappers:

```bash
make exec CMD="php artisan zomboid:generate-map-tiles --force"
```

```powershell
.\make.ps1 exec php artisan zomboid:generate-map-tiles --force
.\make.ps1 exec php artisan zomboid:generate-map-tiles --pack-only
```

| Flag | Description |
|------|-------------|
| `--force` | Clear existing tiles and re-render |
| `--pack-only` | Convert loose DZI files → `tiles.sqlite` only |
| `--keep-loose` | Keep multi-file pyramid after packing (not recommended) |
| `--workers=N` | Render worker count |
| `--map=` | Specific map name |

Also available from the panel: **Admin → Player map → Generate local tiles**.

## Other

| Linux | Windows | Description |
|-------|---------|-------------|
| `make info` | `.\make.ps1 info` | Show URLs, public IP, and firewall status |
| `make arch` | `.\make.ps1 arch` | Show detected CPU architecture |
| `make update-version` | `.\make.ps1 update-version` | Update `game-version.conf` after a PZ game update |
| `make nuke` | `.\make.ps1 nuke` | Destroy ALL data and stop services (**danger**) |
| `make help` | `.\make.ps1 help` | Show all available commands |
