# Windows install

The PowerShell wrappers (`make.ps1`, `deploy.ps1`) talk to **Linux containers**.
Windows-container mode is not supported.

- Windows 10/11: Docker Desktop with Linux containers.
- Windows Server: use a Linux VM (or WSL2) and follow [installation-linux.md](installation-linux.md).

## Docker Desktop (10/11)

Install [Docker Desktop](https://docs.docker.com/desktop/setup/install/windows-install/)
and [Git for Windows](https://git-scm.com/downloads/win). In Docker Desktop,
leave **Use the WSL 2 based engine** on.

```powershell
git clone https://github.com/AsP3X/pzserver.git
cd pzserver
.\make.ps1 init
```

`.\deploy.ps1` runs the wizard on a fresh checkout, otherwise starts the stack.

```powershell
.\make.ps1 expose          # UDP 16261/16262 in Windows Firewall
```

Panel: http://127.0.0.1:8100  
Public Caddy: `.\make.ps1 admin-expose`

| Command | What it does |
|---------|----------------|
| `.\make.ps1 up` / `down` / `restart` | stack |
| `.\make.ps1 logs` / `ps` / `info` | status |
| `.\make.ps1 web-test` / `web-check` | panel tests |
| `.\make.ps1 test-game-server` | Knox Relay Lua + shell tests |
| `.\make.ps1 expose` / `hide` | game UDP |
| `.\make.ps1 admin-expose` / `admin-hide` | Caddy TCP |
| `.\make.ps1 db-backup` / `db-restore` | `web-db` |
| `.\make.ps1 nuke` | destroy `./data` (**danger**) |

`.\deploy.ps1 -Help` lists the same surface.

Map packs: [map-tiles.md](map-tiles.md), [map-sprites.md](map-sprites.md).

## Linux VM on Windows Server

Install Docker Engine inside an Ubuntu VM, clone this repo there, then follow
the Linux guide. Open host firewall / NAT for UDP 16261–16262.

## WSL2 (Linux commands on Windows)

```powershell
wsl --install -d Ubuntu-24.04
```

Inside Ubuntu, install Docker Engine (`curl -fsSL https://get.docker.com | sh`),
then follow [installation-linux.md](installation-linux.md).
