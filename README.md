# Project Zomboid B42 — Server + Admin Panel

One-command Docker stack: **Build 42 dedicated server** plus a full **web control panel** (RCON console, config/sandbox editors, mods, players, map, backups, logs, and more).

Based on [Zomboid Manager](https://github.com/trongio/Zomboid_Server_Manager_Docker) (AGPL-3.0). Defaults target **B42 Stable** (`public` Steam branch).

---

## Requirements

| | Minimum | Recommended |
|---|---|---|
| **CPU** | 4 cores | 6+ cores |
| **RAM** | 8 GB host free | 16 GB+ (game uses 4–8 GB by default) |
| **Disk** | 20 GB | 40 GB+ (saves + Steam files) |
| **Software** | Docker Engine + Compose v2 | Docker Desktop (Windows: **Linux containers**) |

Ports used:

| Port | Protocol | Purpose |
|------|----------|---------|
| **16261–16262** | UDP | Game (forward these for remote players) |
| **8100** | TCP | Admin panel (localhost by default) |
| **80 / 443** | TCP | Optional public HTTPS via Caddy |

---

## One-command deploy

### On a new server (Linux recommended)

```bash
git clone <your-repo-url> pzserver
cd pzserver
chmod +x deploy.sh
./deploy.sh
```

### Windows (PowerShell / Docker Desktop)

```powershell
git clone <your-repo-url> pzserver
cd pzserver
.\deploy.ps1
```

The wizard will:

1. Generate secrets (DB, Redis, RCON, API, app key) into **local** `.env` files (never commit these)
2. Create admin credentials for the **web panel**
3. Configure the game server (name, players, RAM, Steam branch)
4. Build and start all containers
5. Print the panel URL and passwords

**Accept defaults** for B42 Stable with the panel at `http://localhost:8100`.

Non-interactive defaults (CI / scripted hosts):

```powershell
.\deploy.ps1 -Yes
# or
$env:PZ_SETUP_ASSUME_YES = "1"; .\make.ps1 init
```

### Re-deploy / restart later

```powershell
.\deploy.ps1                        # start if already configured
.\deploy.ps1 -Status                # URLs + container status
.\deploy.ps1 -Ps                    # container table only
.\deploy.ps1 -Logs game-server      # follow logs (all services, or the named ones)
.\deploy.ps1 -Restart web-api       # restart all services, or the named ones
.\deploy.ps1 -Rebuild               # rebuild images from upstream bases, then start
.\deploy.ps1 -RebuildGame           # rebuild game-server only
.\deploy.ps1 -Down                  # stop everything
.\deploy.ps1 -Init                  # re-run setup wizard
```

`./deploy.sh` takes the same commands on Linux and macOS as `--status`,
`--logs`, `--rebuild` and so on. Both print their full surface with `-Help` /
`--help`.

### Docker networks

| Network | Type | Services |
|---------|------|----------|
| **`proxy-network`** | external (public edge) | `game-server`, `web-ui`, `web-api` (+ `caddy` in caddy mode) |
| **`pzserver-internal`** | internal (private) | `web-api`, `web-db`, `docker-socket-proxy`, + `game-server` for RCON |

`proxy-network` is shared with your reverse-proxy stack when present. Deploy creates it if missing.

### Web panel exposure (`WEB_PROXY_MODE`)

| Mode | `.env` value | Host ports 80/443 | How to reach the panel |
|------|--------------|-------------------|------------------------|
| **Local** (default) | `local` | No | `http://127.0.0.1:8100` |
| **Caddy** | `caddy` | Yes (Caddy) | Your domain / IP on 80/443 |
| **Nginx Proxy Manager** | `npm` | No | NPM → `http://pz-web-ui:8080` on `proxy-network` |

If NPM (or anything else) already owns port 80, use **`WEB_PROXY_MODE=npm`**.

```env
WEB_PROXY_MODE=npm
```

NPM Proxy Host example:

- Forward hostname: `pz-web-ui`
- Forward port: `8080`
- Scheme: `http`
- Docker network: `proxy-network`

### Host-mapped data (`./data/`)

**All** persistent stack data is bind-mounted under `./data/` (no Docker named volumes):

| Host path | Contents |
|-----------|----------|
| `./data/zomboid/` | Saves, `Server/*.ini`, logs, Lua bridge |
| `./data/server/` | SteamCMD dedicated server install (~7 GB) |
| `./data/backups/` | Panel backups |
| `./data/map-tiles/` | Admin player map basemap — **one** `tiles.sqlite` file after generation (see [Map tiles](#map-tiles-admin-player-map)) |
| `./data/web-postgres/` | Panel PostgreSQL (`web-db`) |
| `./data/caddy-data/` | Caddy certs/storage (if `WEB_PROXY_MODE=caddy`) |
| `./data/caddy-config/` | Caddy config state |

Override any path in `.env` (e.g. put worlds on another disk).

### What must never be committed

These are generated on the host and are gitignored:

- `.env`
- `.firewall.conf`, `ACCESS.local.txt`
- `./data/**` (worlds, DB, binaries, backups)

---

## Map basemap (admin player map)

The admin **Player map** shows live/offline player markers on a basemap. Generate or refresh packs with `make map-tiles` / `make map-sprites`. See [docs/map-tiles.md](docs/map-tiles.md) and [docs/map-sprites.md](docs/map-sprites.md).

### Advanced: local isometric tiles

Optional photorealistic tiles via `pzmap2dzi`. **Opt-in** and heavy (CPU/RAM/disk).

**Important storage design:** raw DZI output is a pyramid of hundreds of thousands to **millions** of small image files. That makes deletes, host backups, and filesystem ops extremely slow. After render, this stack **packs all tiles into a single SQLite database** and deletes the loose pyramid:

| Path | Role |
|------|------|
| `./data/map-tiles/tiles.sqlite` | **Canonical** local basemap (one file — fast to copy/delete/back up) |
| `./data/map-tiles/html/map_data/base/map_info.json` | Small sidecar with map dimensions (optional; also stored inside the pack) |
| `./data/map-tiles/html/.../layer0_files/` | **Temporary only** during render; removed after packing |

The panel serves tiles from the pack at `/admin/map-tiles/{z}/{x}_{y}`.

### Commands

```bash
make map-tiles              # render + pack tiles.sqlite (hours)
make map-sprites            # sprite isometric catalogue
make map-sprites-live       # door/window overlay from the live save
```

```powershell
.\make.ps1 map-tiles
.\make.ps1 map-sprites
```

Full details: **[docs/map-tiles.md](docs/map-tiles.md)**, **[docs/map-sprites.md](docs/map-sprites.md)**.

---

## What you get

### Containers

| Service | Role |
|---------|------|
| `game-server` | PZ dedicated server (SteamCMD, B42 by default) |
| `web-api` | Rust control plane (RCON, Docker, Lua bridge) |
| `web-ui` | Vite/React admin + public site |
| `web-db` | PostgreSQL 16 (panel data) |
| `docker-socket-proxy` | Safe start/stop/logs for the game container |
| `caddy` | Optional HTTPS reverse proxy |

### Web panel features

- **Server control** — start / stop / restart / save / update / wipe  
- **RCON console** — browser terminal with command history  
- **Live logs**  
- **Config editors** — `server.ini` + sandbox (categorized UI)  
- **Mods** — Workshop IDs + load order  
- **Players** — kick, ban, teleport, access levels, XP, items  
- **Map** — live player markers (vector basemap by default; optional proxy or local isometric `tiles.sqlite`)  
- **Backups** — manual, scheduled, rollback  
- **Whitelist, Discord webhooks, auto-restart, status page**

---

## Customization

### Before / during first deploy

Edit answers in the wizard, or after init edit:

- **Root** `.env` — game ports, RAM, branch, max players, secrets  

Key game variables:

| Variable | Default | Meaning |
|----------|---------|---------|
| `PZ_STEAM_BRANCH` | `public` | `public` = B42 Stable, `unstable` = B42 Unstable, `legacy41` = B41 |
| `PZ_MAX_PLAYERS` | `16` | Player cap |
| `PZ_MAX_RAM` | `4096m` / `8192m` prod | JVM heap |
| `PZ_SERVER_PASSWORD` | empty | Join password |
| `PZ_MOD_IDS` / `PZ_WORKSHOP_IDS` | empty | Semicolon-separated mod lists |
| `PZ_PUBLIC_SERVER` | `true` | Public browser listing |

Then:

```powershell
.\make.ps1 down
.\make.ps1 up
```

### After first boot (recommended for deep settings)

Open the panel → **Configuration** / **Sandbox** / **Mods**.  
Changes to `.ini` / sandbox typically need a **server restart** from the panel.

Persistent data lives under `./data/` (`zomboid`, `server`, `web-postgres`, `backups`, …).

---

## Day-to-day commands

| Action | Windows | Linux |
|--------|---------|-------|
| Start | `.\make.ps1 up` | `make up` |
| Stop | `.\make.ps1 down` | `make down` |
| Logs | `.\make.ps1 logs [svc...]` | `make logs SVC="..."` |
| Status | `.\make.ps1 info` | `make info` |
| Restart | `.\make.ps1 restart [svc...]` | `make restart SVC="..."` |
| Rebuild images | `.\make.ps1 rebuild` | `make rebuild` |
| Rebuild game server | `.\make.ps1 rebuild-game` | `make rebuild-game` |
| Open game ports (host FW) | `.\make.ps1 expose` | `make expose` |
| **Destroy all data** | `.\make.ps1 nuke` | `make nuke` |

---

## Connect as a player

1. Launch **Project Zomboid** (same build as the server — B42 if you used `public`)
2. **Join** → **Favorites** → add your host IP and port **16261**
3. Use an account; promote yourself in-game or via panel RCON if needed

---

## Security notes

- Change all default passwords during setup (or let the wizard auto-generate)
- Panel binds to **localhost:8100** unless you enable public Caddy access
- RCON is **not** published to the host (only internal Docker network)
- Expose UDP game ports only when you want remote players
- License: **AGPL-3.0** (see `LICENSE`) — respect obligations if you redistribute or host as a service

---

## Architecture (short)

```
Players ──UDP 16261/16262──► game-server (PZ B42)
Admin  ──TCP 8100 / 443────► web-ui ──► web-api ──RCON──► game-server
                                           │
                                           ├── web-db (Postgres)
                                           └── docker-socket-proxy (lifecycle)
```

---

## Docs

- Upstream project (AGPL-3.0): [Zomboid Manager](https://github.com/trongio/Zomboid_Server_Manager_Docker)
- Install deep-dives: `docs/installation-windows.md`, `docs/installation-linux.md`
- Map vector basemap: `docs/map-vector.md`
- Map tiles (optional isometric + SQLite pack): `docs/map-tiles.md`
- Publishing Knox Relay mod updates to the Steam Workshop: `docs/workshop-updates.md`
- Command reference: `docs/commands.md`
- Troubleshooting: `docs/troubleshooting.md`

## Support

Issues with this stack: check `.\make.ps1 logs` and `docs/troubleshooting.md`.  
Game bugs belong on [The Indie Stone forums](https://theindiestone.com/forums/).
