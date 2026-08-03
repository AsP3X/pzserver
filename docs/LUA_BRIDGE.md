# Lua bridge operations

The game server and Laravel app share `data/zomboid/Lua` (bind-mounted as
`/home/steam/Zomboid/Lua` and `/lua-bridge`).

## Permissions model

- Directories: `0777` (**no sticky bit**)
- Files: `0666`
- Sticky `1777` breaks atomic rename when `www-data` and `steam`/`root` alternate ownership

Self-heal:

```bash
./scripts/fix-lua-perms.sh
# or
docker exec pz-app php artisan zomboid:heal-lua-bridge
```

Scheduled: `zomboid:heal-lua-bridge` every 5 minutes.

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

1. PHP writes `money_deposits` row (status `pending`) **and** `deposit_requests.json`
2. Lua processes request, writes `deposit_results.json` (with restore-on-write-fail)
3. PHP credits wallet, marks row `credited`, removes result from JSON

## Shared UID (optional hardening)

If both containers can run as the same numeric UID/GID, file ownership stays
consistent and world-writable is less critical. The stock renegademaster game
image often runs as root/steam; verify before forcing `user:` in compose.
