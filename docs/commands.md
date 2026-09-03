# Command Reference

All commands are available via `make` (Linux) or `.\make.ps1` (Windows PowerShell).

## Setup

| Linux | Windows | Description |
|-------|---------|-------------|
| `make init` | `.\make.ps1 init` | Interactive first-run setup wizard |
| `make setup` | `.\make.ps1 setup` | Alias for `init` |
| `./deploy.sh` | `.\deploy.ps1` | One command: runs the wizard on a fresh checkout, otherwise starts the stack |

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

## Database (panel Postgres — `web-db` / `./data/web-postgres`)

| Linux | Windows | Description |
|-------|---------|-------------|
| `make db-check` | `.\make.ps1 db-check` | Ensure `./data/web-postgres` exists |
| `make db-init` | `.\make.ps1 db-init` | Same as `db-check` |
| `make db-reset` | `.\make.ps1 db-reset` | Wipe the panel DB (**danger**) |
| `make db-backup` | `.\make.ps1 db-backup` | Dump `web-db` to `db-backups/` |
| `make db-restore` | `.\make.ps1 db-restore` | Restore the latest dump into `web-db` |

sqlx migrations run when `web-api` starts. Re-apply with `make restart SVC=web-api`.

## Panel / tests

| Linux | Windows | Description |
|-------|---------|-------------|
| `make web-test` | `.\make.ps1 web-test` | Rust API tests (`cargo test --workspace`) |
| `make web-check` | `.\make.ps1 web-check` | clippy + rustfmt + `tsc` + eslint |
| `make test-game-server` | `.\make.ps1 test-game-server` | Host-side shell + Knox Relay Lua suites |

`make migrate`, `make test` and `make exec` are leftovers of the old PHP container. They refuse to run and print the replacements above. Exec into a live service with `docker compose exec web-api <cmd>` (or `game-server`).

### Server wipe (world reset, keep sandbox/spawns)

Admin → Dashboard → **Wipe** (or `POST /admin/server/wipe`).

**Deletes (game):** `Saves/Multiplayer/*` (map, players, vehicles, zombie pop), `db/{ServerName}.db`, PZ `backups/startup` + `backups/version` (auto-restore archives), Lua bridge live JSON/inventory state.

**Deletes (website):** every website account (players and staff), plus wallets, vaults, shop purchases/deliveries, money deposits, reward claims, whitelist entries, player reports, player_stats, game_events, pvp_violations, vehicle_key_holders, their sessions/tokens, and audit logs. The first administrator is recreated from `ADMIN_USERNAME` / `ADMIN_PASSWORD`.

**Keeps:** `Server/{name}.ini`, `{name}_SandboxVars.lua` (zombies/environment/loot), `{name}_spawnpoints.lua`, `{name}_spawnregions.lua`, mod state files; shop catalog, site settings, translations, news, backup records.

A pre-wipe backup is attempted first. `web-api` performs the wipe itself.

### Map basemap (admin player map)

The Player map has a **Map view** toggle (persisted in the browser):

| Mode | Behaviour | Docs |
|------|-----------|------|
| **Vector (2D)** | Schematic pack shipped with the UI (`/map/vanilla.json`) | [map-vector.md](map-vector.md) |
| **3D isometric** | JPEG DZI pack in `tiles.sqlite` | [map-tiles.md](map-tiles.md) |
| **Sprite isometric** | Live sprites from `sprites.sqlite` | [map-sprites.md](map-sprites.md) |

There is no PHP/`artisan` bake. There is no CDN fallback.

```bash
make map-tiles              # full isometric JPEG pack (hours)
make map-tiles-region CELLS="41,38"
make map-sprites            # sprite catalogue
make map-sprites-live       # door/window overlay from the live save
```

```powershell
.\make.ps1 map-tiles
.\make.ps1 map-sprites
```

Regional redraw from the panel: **Configuration → Update map…** (`POST /api/v1/admin/map-tiles/rerender`). A full county rebuild stays on the host as `make map-tiles`.

## Other

| Linux | Windows | Description |
|-------|---------|-------------|
| `make info` | `.\make.ps1 info` | Show URLs, public IP, and firewall status |
| `make arch` | `.\make.ps1 arch` | Show detected CPU architecture |
| `make update-version` | `.\make.ps1 update-version` | Update `game-version.conf` after a PZ game update |
| `make nuke` | `.\make.ps1 nuke` | Destroy ALL data and stop services (**danger**) |
| `make help` | `.\make.ps1 help` | Show all available commands |
