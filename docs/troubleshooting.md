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

### What a 2026-08-20 investigation established

The failure is **intermittent and self-resolving**, not a broken configuration. Across
`data/zomboid/Logs/logs_*`, roughly one boot in four is affected. Failures arrive in
streaks — the worst was eleven consecutive on 2026-08-14, about an hour — and then
recover on their own with no intervention. Failed boots leave only a `DebugLog`
(~9KB); healthy ones also write `admin`/`chat`/`connections` logs and reach 300KB+.

The startup sequence is identical whether it succeeds or fails, including a ~90 second
gap between `SteamUtils initialised successfully` and the login attempt. Then:

```text
06:19:30.832  Waiting for response from Steam servers.
06:19:50.160  Failed to connect to Steam servers.      <- fixed ~19.3s timeout
```

**Ruled out, so nobody re-investigates:**

| Suspected | Evidence against |
|---|---|
| Ports or DNS blocked | Steam CM servers reachable over TCP *from inside the container*, tested during a live failure |
| Configuration | Identical between success and failure; `server.ini` exposes no Steam port settings |
| Bind IP / interface ordering | One container instance produced both outcomes with the same `ip.txt` |
| A stale Steam session from the previous run | Two successes one minute apart (08-14 20:14, 20:15); a failure six hours after the last success (08-15) |
| Container networking | The same probe from the host behaves identically |

SteamCMD's own *client* login succeeds about 90 seconds before the game server's
*game-server* login fails, in the same boot — so general Steam reachability is fine.
What remains is transient unavailability of Steam's game-server login, which cannot be
observed from this side. Restarting is the remedy, and waiting works equally well.

### Two known hazards found during that investigation (not fixed)

**1. `BIND_IP` can land on the network with no outbound route.** The base image picks
the first address `hostname -I` reports:

```bash
BIND_IP=($(hostname -I)); BIND_IP="${BIND_IP[0]}"
```

The game container joins both `proxy-network` and `pzserver-internal`, and the latter is
declared `internal: true`. Binding to it cannot reach Steam at all:

```text
bound 172.19.0.2  -> Steam CM  OK          (proxy-network)
bound 172.18.0.5  -> Steam CM  FAIL        (pzserver-internal, no egress)
```

Docker does not guarantee interface ordering for a container on several networks, so
each **recreate** is effectively a coin flip. If a server can never reach Steam across
many restarts, check which address it chose:

```bash
cat data/zomboid/ip.txt
```

A `172.18.x.x` value there means every Steam attempt will fail until the container is
recreated onto the routable interface. Restarting alone will not change it.

**2. Each failed attempt costs about six minutes.** The entrypoint writes
`app_update 380870 validate`, so every boot re-verifies all 7.2GB before the game
starts. That is what turns a brief Steam blip into an hour of downtime. The boot-time
manifest check (`game-server/steam-update-check.sh`) now detects a bad install directly,
so validating on every routine boot buys less than it used to.

## Can't connect in-game

1. Check your public IP: `make info`
2. Make sure you ran: `make expose`
3. Check cloud firewall rules (see [Cloud Provider Notes](#cloud-provider-notes))
4. Verify the server is running: `make ps`
5. On Windows, ensure Windows Firewall rules are set (see [Windows guide](installation-windows.md))

## Admin panel not loading

1. Check local access: http://localhost:8100
2. For remote access, make sure you ran: `make admin-expose`
3. Check cloud firewall for ports 80/443
4. Check logs: `make logs`
5. If nothing is listening on the port at all, see [port never binds](#admin-panel-port-never-binds-docker-port-pz-web-ui-is-empty) below

## Panel returns 502 after recreating `web-api` on its own

Symptom: every `/api` call returns nginx's `502 Bad Gateway`, while `docker ps`
shows `pz-web-api` up and healthy and its own log says `listening addr=0.0.0.0:8080`.

Cause: `web-ui`'s nginx resolves `web-api` once, at startup, and caches the
address. Recreating `web-api` alone (`up -d --force-recreate web-api`, or a
rebuild of just that image) gives the container a new IP, and nginx keeps
proxying to the old one.

Fix:

```bash
docker restart pz-web-ui
```

Recreating both together avoids it in the first place.

## Admin panel port never binds (`docker port pz-web-ui` is empty)

Symptom: `pz-web-ui` is up, but `http://localhost:8100` refuses the connection and the
container shows no ports:

```bash
docker port pz-web-ui
```

If that prints nothing — and `docker ps` shows an empty PORTS column for `pz-web-ui` —
the port was never published on the host. This is not a firewall issue; nothing is
listening.

**Cause.** `pzserver-internal` is declared `internal: true`. A container attached
*only* to an internal network has its published ports **silently dropped** — no
warning, no error, the `ports:` entry simply has no effect. Confirmed on Docker
29.6.2.

**Fix.** The service must also join a non-internal network. `web-ui` already
does this in `docker-compose.web.yml`:

```yaml
    networks:
      - proxy-network      # non-internal: makes `ports:` actually bind
      - pzserver-internal  # private: nginx → web-api, RCON
```

If you are on an older checkout where `web-ui` lists only `pzserver-internal`,
add `proxy-network` above it, then recreate the container so it picks up the
new network (a restart is not enough — network membership is set at creation):

```bash
make down && make up
```

This affected `WEB_PROXY_MODE=local` (the default). `caddy` and `npm` modes were
unaffected in practice, because Caddy and the NPM alias both put a proxy on
`proxy-network` in front of `web-ui`.

**The same rule applies to any service you give a `ports:` entry.** Every published
port in this project is on a non-internal network: `web-ui`, `game-server`, and
`caddy` join `proxy-network`; `web-db` in `docker-compose.web-dev.yml` joins
the `pzweb-dev` bridge. Services with no published ports (`web-api`,
`docker-socket-proxy`) stay internal-only on purpose.

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

The schematic **vector** pack ships with the UI (`/map/vanilla.json`) and needs
no generate step. Switch to **Vector (2D)** on the map if isometric is empty.

For **3D isometric**, this stack has no CDN fallback. You need a local pack:

```bash
make map-tiles              # hours; needs PZ client texture packs first
make map-tiles-import       # if you already copied tiles.sqlite into data/map-tiles/
```

After a successful run the live pack is one file on the `pz-map-tiles-sqlite`
volume (scratch HTML stays under `data/map-tiles/`). Full guide: [map-tiles.md](map-tiles.md).

**Sprite isometric** is a separate pack: `make map-sprites`. See [map-sprites.md](map-sprites.md).

## Millions of files under `data/map-tiles/` (slow backup / delete)

Older runs left a raw DZI pyramid (`html/map_data/base/layer0_files/`). New
generates pack into `tiles.sqlite` and delete the loose tree. If a leftover
pyramid is still on disk, run `make map-tiles` (it packs at the end) or copy a
finished `tiles.sqlite` in and `make map-tiles-import`.

If `rm` of the old tree is still running, let it finish once; afterward you only manage one pack file. Details: [map-tiles.md](map-tiles.md).

## Map tile generation stuck or failed

1. Ensure the game server has finished SteamCMD install (`data/server/media` exists).
2. Texture packs must exist at `data/server/media/texturepacks` (or `PZ_TEXTUREPACKS_HOST`). The dedicated server does not ship them — copy from a PZ client.
3. Prefer idle host time; a full county render takes hours and uses a lot of RAM/CPU.
4. Watch the job log from the panel (**Configuration → Update map…**) or `make map-tiles` stdout. Regional jobs also write `job.log` next to the pack.
5. Do not insert rows into `map_tile_jobs` by hand. `status='running'` is a dry-run animation.

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
