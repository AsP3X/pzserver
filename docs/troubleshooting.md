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
```

The game server takes a few minutes to download via SteamCMD on first launch. Be patient.

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
