# Lua bridge operations

The game server and `web-api` share `data/zomboid/Lua` (bind-mounted as
`/home/steam/Zomboid/Lua` in the game container and the Lua path in `web-api`).

## Permissions model

- Directories: `0777` (**no sticky bit**)
- Files: `0666`
- Sticky `1777` breaks atomic rename when `web-api` and `steam`/`root` alternate ownership

Self-heal:

```bash
./scripts/fix-lua-perms.sh
```

The `zomboid:heal-lua-bridge` command and its 5-minute schedule went away with
the `app` container in `c318e99`. The `data-init` service now makes the
directory writable once at start-up, and `web-api` fails its `/api/health` probe
if it is not — see `5fdba44`.

## Admin UI

**Admin → Lua Bridge** (`/admin/bridge`):

- Health + write probe
- One-click repair
- Deposit audit / cancel / force-credit
- Dry-run deposit simulate
- Exchange rates (Money / MoneyBundle)
- Deploy checklist + Docker resource sample
- Recent `[KnoxRelay]` log errors
- Workshop mod sample timestamps

## Hybrid deposit outbox

1. `web-api` writes a `money_deposits` row (status `pending`) **and** `deposit_requests.json`
2. Knox Relay Lua processes the request, writes `deposit_results.json` (with restore-on-write-fail)
3. `web-api` credits the wallet, marks the row `credited`, removes the result from JSON

## Shared UID (optional hardening)

If both containers can run as the same numeric UID/GID, file ownership stays
consistent and world-writable is less critical. The stock renegademaster game
image often runs as root/steam; verify before forcing `user:` in compose.
