# Troubleshooting

## "Permission denied" on Docker commands

Make sure your user is in the docker group:
```bash
sudo usermod -aG docker $USER
```
Then **log out and back in**.

## Containers keep restarting

```bash
make logs    # or .\make.ps1 logs on Windows
# or:
docker logs -f pz-game-server
```

The game server takes a few minutes to download via SteamCMD on first launch. Be patient.

## Game server starts then exits: "Failed to connect to Steam servers"

With `USE_STEAM=true` (default for AMD64), the dedicated server **must** reach Steam after launch. If auth fails, PZ shuts down immediately (you may also see a harmless NPE on exit because the world never loaded).

Typical log sequence:

```text
Waiting for response from Steam servers
Failed to connect to Steam servers
Server exited
```

SteamCMD may also show: `Timed out waiting for update to start` during validate.

**Checks (run on the host):**

```bash
# Container can resolve and reach Steam?
docker exec pz-game-server getent hosts api.steampowered.com 2>/dev/null || true
docker exec pz-game-server sh -c 'wget -qO- --timeout=10 https://api.steampowered.com/ISteamWebAPIUtil/GetServerInfo/v1/ 2>&1 | head -c 200' || true

# Host outbound (firewall / cloud security group must allow outbound HTTPS + Steam)
curl -fsS --max-time 10 https://api.steampowered.com/ISteamWebAPIUtil/GetServerInfo/v1/ | head -c 200
```

**Mitigations:**

1. **Redeploy with public DNS** (compose sets `8.8.8.8` / `1.1.1.1` for the game container when using current `docker-compose.amd64.yml`):

   ```bash
   git pull && ./deploy.sh
   ```

2. **Cloud / host firewall:** allow **outbound** TCP 443 and Steam traffic (not only inbound game ports 16261–16262/udp).

3. **Retry:** Steam outages and rate limits happen; restart after a few minutes:

   ```bash
   docker restart pz-game-server
   docker logs -f pz-game-server
   ```

4. **Ignore noise** that is usually harmless:

   - `libjsig.so` / `LD_PRELOAD` cannot be preloaded  
   - `unknown option ""`  
   - `libPZXInitThreads64.so was not found` (OK for dedicated server)  
   - SteamCMD `validate` every boot (slow but expected on AMD64)

The long **Checking for available updates / Verifying installation** phase is SteamCMD on every container start (AMD64 image). The fatal line is **Failed to connect to Steam servers** after the Java server has already begun.

## Can't connect in-game

1. Check your public IP: `make info`
2. Make sure you ran: `make expose`
3. Check cloud firewall rules (see [Cloud Provider Notes](#cloud-provider-notes))
4. Verify the server is running: `make ps`
5. On Windows, ensure Windows Firewall rules are set (see [Windows guide](installation-windows.md))

## Admin panel not loading

1. Check local access: http://localhost:8000
2. For remote access, make sure you ran: `make admin-expose`
3. Check cloud firewall for ports 80/443
4. Check logs: `make logs`
5. If nothing is listening on the port at all, see [port never binds](#admin-panel-port-never-binds-docker-port-pz-app-is-empty) below

## Admin panel port never binds (`docker port pz-app` is empty)

Symptom: `pz-app` is up, but `http://localhost:8000` refuses the connection and the
container shows no ports:

```bash
docker port pz-app
```

If that prints nothing — and `docker ps` shows an empty PORTS column for `pz-app` —
the port was never published on the host. This is not a firewall issue; nothing is
listening.

**Cause.** `pzserver-internal` is declared `internal: true`. A container attached
*only* to an internal network has its published ports **silently dropped** — no
warning, no error, the `ports:` entry simply has no effect. Confirmed on Docker
29.6.2.

**Fix.** The service must also join a non-internal network. In `docker-compose.yml`
the `app` service joins both:

```yaml
    networks:
      - proxy-network      # non-internal: makes `ports:` actually bind
      - pzserver-internal  # private: db, redis, RCON
```

If you are on an older checkout where `app` lists only `pzserver-internal`, add
`proxy-network` above it, then recreate the container so it picks up the new
network (a restart is not enough — network membership is set at creation):

```bash
make down && make up
```

This affected `WEB_PROXY_MODE=local` (the default). `caddy` and `npm` modes were
unaffected in practice, because Caddy and the NPM alias both put a proxy on
`proxy-network` in front of the app.

**The same rule applies to any service you give a `ports:` entry.** Every published
port in this project is on a non-internal network: `app`, `game-server`, `caddy`
and `web-ui` join `proxy-network`; `web-db` in `docker-compose.web-dev.yml` joins
the `pzweb-dev` bridge. Services with no published ports (`queue`, `db`, `redis`,
`docker-socket-proxy`, `web-api`) stay internal-only on purpose.

To check quickly that a published port really bound:

```bash
docker compose ps --format 'table {{.Name}}\t{{.Ports}}'
```

## Want to start fresh

```bash
make nuke    # WARNING: deletes everything
make init
```

## Player map has no basemap / only a grid

1. By default the map uses **proxy tiles** (map.projectzomboid.com). If those fail (offline host, blocked CDN, CORS), the basemap may be empty.
2. Optional: generate **local** tiles from the panel (**Admin → Player map → Generate local tiles**) or:

```bash
docker exec -it pz-app php artisan zomboid:generate-map-tiles --force
# or: docker compose exec app php artisan zomboid:generate-map-tiles --force
```

3. Check logs: `app/storage/logs/map-tiles.log` and `app/storage/logs/pzmap2dzi.log`.
4. After a successful run you should have **one** file: `data/map-tiles/tiles.sqlite` (not millions of images). Full guide: [map-tiles.md](map-tiles.md).

## Millions of files under `data/map-tiles/` (slow backup / delete)

Older runs left a raw DZI pyramid (`html/map_data/base/layer0_files/`). Pack it into a single SQLite file and remove the loose tree:

```bash
docker exec -it pz-app php artisan zomboid:generate-map-tiles --pack-only
# or: docker compose exec app php artisan zomboid:generate-map-tiles --pack-only
```

Confirm `data/map-tiles/tiles.sqlite` exists and the `layer0_files` directory is gone. New generates pack automatically after render.

If `rm` of the old tree is still running, let it finish once; afterward you only manage one pack file. Details: [map-tiles.md](map-tiles.md).

## Map tile generation stuck or failed

1. Ensure the game server has finished SteamCMD install (`data/server/media` exists).
2. Generation needs Python3 + pzmap2dzi inside the **app** container (bundled in the image).
3. Prefer idle host time; render can take a long time and uses a lot of RAM/CPU.
4. Stale lock file after a crash: remove `app/storage/app/map-tiles.generating` if generation is not actually running, then retry.
5. Re-pack without re-render if the pyramid finished but packing failed: `--pack-only`.

## Cloud Provider Notes

If running on a cloud VM (Oracle Cloud, AWS, GCP, etc.), you also need to open these ports in your cloud provider's **security group / firewall rules**:

| Port | Protocol | Purpose |
|------|----------|---------|
| 16261 | UDP | Game traffic |
| 16262 | UDP | Direct connection |
| 443 | TCP | Admin panel HTTPS (only if using `admin-expose`) |
| 80 | TCP | HTTP redirect (only if using `admin-expose`) |

The host firewall commands (`make expose` / `make admin-expose`) only affect the OS-level firewall. Cloud firewalls are separate.

## Minimum Hardware

| Resource | Minimum | Recommended |
|----------|---------|-------------|
| CPU | 2 cores | 4 cores |
| RAM | 4 GB | 8 GB |
| Disk | 20 GB free | 30 GB+ |
| OS | Ubuntu 22.04+, Debian 12+, Fedora 38+ | Any modern Linux with Docker |

The PZ game server alone needs 2-4 GB of RAM. On Windows, this stack requires a Linux container backend. Windows Server 2022/2025 is not supported in Windows-container mode.
