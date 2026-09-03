# Linux install

You need a Linux host (x86_64 or ARM64) with Docker Engine and Compose v2.
4 GB RAM is a floor; 8 GB is more realistic with the dedicated server running.

| Tool | Notes |
|------|--------|
| Git | clone the repo |
| Docker Engine | not Docker Desktop, unless you want it |
| Compose v2 | `docker compose version` |
| Make | `apt install make` / `dnf install make` |
| OpenSSL, curl | usually already there |

Ubuntu/Debian Docker:

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
# log out and back in
```

## 1. Clone

```bash
git clone https://github.com/AsP3X/pzserver.git
cd pzserver
```

## 2. Wizard

```bash
make init
```

That writes `.env`, creates `./data/*`, builds images, and starts
`game-server`, `web-api`, `web-ui`, and `web-db`. Passwords are generated if
you press Enter. sqlx migrations run when `web-api` starts.

`./deploy.sh` does the same on a fresh checkout, or just starts the stack if
`.env` already exists.

## 3. Game ports

Closed by default. For remote players:

```bash
make expose    # UDP 16261 and 16262
make hide      # close them again
```

Forward those UDP ports on the router for internet players.

## 4. Panel

Always on the host loopback:

```
http://127.0.0.1:8100
```

Public HTTPS (Caddy):

```bash
make admin-expose
```

Log in with the admin user from `make init`.

Isometric map packs are optional: [map-tiles.md](map-tiles.md),
[map-sprites.md](map-sprites.md). The vector schematic works with no generate
step.

## 5. Join in-game

Project Zomboid → Join → your public IP, port `16261`. Server password if you
set one. `make info` prints the public IP when it can.

Day-to-day commands: [commands.md](commands.md).
