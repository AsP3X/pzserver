# Project Zomboid Server — Implementation Plan

**Version:** 2.0 | **Updated:** 2026-02-25
**Source:** PZ_Server_Requirements_v1.0.md

---

## Tech Stack Decisions

| Layer | Choice | Justification |
|---|---|---|
| Framework | **Laravel 12 (PHP 8.3)** | Full-stack: API + web dashboard in one codebase. Built-in queues, scheduler, auth, ORM |
| Database | **PostgreSQL 16** | Required by spec. Used for audit logs, users, future payments |
| ORM / Migrations | **Eloquent + Laravel Migrations** | Built-in, zero config, incremental migration strategy |
| RCON Client | **Custom PHP Source RCON** | Source RCON is a simple TCP protocol — ~100 lines of PHP. No external dependency needed |
| Background Jobs | **Laravel Queue (Redis driver)** | Built-in queue system with retries, failed job tracking. Redis also used for rate limiting and cache |
| Task Scheduling | **Laravel Scheduler** | Built-in cron replacement. Backup schedules, subscription checks, cleanup tasks |
| Game Server Image | **Renegade-Master/zomboid-dedicated-server** | Well-maintained, env var config, beta branch support, active community |
| Web Server | **Nginx + PHP-FPM** (in container) or **FrankenPHP** | Standard Laravel deployment. Caddy as reverse proxy in front |
| Reverse Proxy | **Caddy** | Auto TLS, zero-config HTTPS |
| Frontend | **React 19 + Inertia.js v2 + TypeScript** | Client-side SPA with server-side routing via Inertia. No separate API for frontend |
| UI Components | **shadcn/ui + Tailwind CSS v4** | Accessible, composable components. Dark mode, responsive out of the box |
| Route Generation | **Wayfinder** | TypeScript route generation from Laravel routes. Type-safe frontend routing |
| Web Auth | **Fortify** | Session-based auth with 2FA support. Login, register, password reset, email verification |
| API Auth | **Sanctum** | API token auth for external API consumers |
| Testing | **Pest PHP** | Modern, expressive testing. Built on PHPUnit. Laravel integration out of the box |
| Containerization | **Docker Compose v2** | Single-file orchestration as required |
| Docker Control | **Docker Engine API via HTTP** | Call Docker socket (`/var/run/docker.sock`) directly with Laravel HTTP client. No SDK needed |

### Project Structure

```
Zomboid/
├── docker-compose.yml
├── .env.example
├── .env                              # gitignored
├── app/
│   ├── Dockerfile
│   ├── composer.json
│   ├── artisan
│   ├── bootstrap/
│   │   └── app.php                   # Laravel bootstrap
│   ├── config/
│   │   ├── app.php
│   │   ├── database.php
│   │   ├── queue.php
│   │   ├── zomboid.php               # PZ-specific config (paths, RCON, server name)
│   │   └── ...
│   ├── routes/
│   │   ├── api.php                   # REST API routes
│   │   ├── web.php                   # Web dashboard routes (Inertia)
│   │   └── settings.php              # Settings routes
│   ├── app/
│   │   ├── Models/
│   │   │   └── AuditLog.php
│   │   ├── Http/
│   │   │   ├── Controllers/
│   │   │   │   ├── Api/
│   │   │   │   │   ├── ServerController.php
│   │   │   │   │   ├── ConfigController.php
│   │   │   │   │   ├── PlayerController.php
│   │   │   │   │   └── ModController.php
│   │   │   │   └── Settings/         # Settings controllers (Inertia)
│   │   │   ├── Middleware/
│   │   │   │   └── ApiKeyAuth.php
│   │   │   └── Requests/             # Form Request validation
│   │   │       ├── ServerRestartRequest.php
│   │   │       ├── ConfigUpdateRequest.php
│   │   │       └── ModAddRequest.php
│   │   ├── Services/
│   │   │   ├── RconClient.php        # Source RCON TCP client
│   │   │   ├── DockerManager.php     # Docker Engine API via HTTP
│   │   │   ├── ServerIniParser.php   # PZ server.ini read/write
│   │   │   ├── SandboxLuaParser.php  # SandboxVars.lua read/write
│   │   │   ├── ModManager.php        # Mod add/remove/reorder
│   │   │   └── AuditLogger.php       # Audit log service
│   │   ├── Jobs/                     # Queue jobs (Stage 2+)
│   │   ├── Console/
│   │   │   └── Commands/             # Artisan commands
│   │   └── Providers/
│   │       └── AppServiceProvider.php
│   ├── database/
│   │   ├── migrations/
│   │   │   └── 2026_02_25_000001_create_audit_logs_table.php
│   │   ├── factories/
│   │   └── seeders/
│   ├── tests/
│   │   ├── Pest.php
│   │   ├── Unit/
│   │   │   ├── RconClientTest.php
│   │   │   ├── ServerIniParserTest.php
│   │   │   └── SandboxLuaParserTest.php
│   │   └── Feature/
│   │       ├── ServerControlTest.php
│   │       ├── ConfigManagementTest.php
│   │       └── PlayerManagementTest.php
│   ├── resources/
│   │   ├── js/
│   │   │   ├── pages/                # React page components (Inertia)
│   │   │   ├── components/           # Reusable React components
│   │   │   │   └── ui/              # shadcn/ui components
│   │   │   ├── layouts/              # App and auth layouts
│   │   │   ├── hooks/                # Custom React hooks
│   │   │   ├── lib/                  # Utilities
│   │   │   └── types/                # TypeScript types
│   │   └── views/
│   │       └── app.blade.php         # Inertia root template
├── game-server/                      # PZ server config overrides
│   └── .gitkeep
└── backups/                          # Backup storage (Stage 2)
    └── .gitkeep
```

---

## Phase 1 — Docker Infrastructure & Game Server

**Goal:** PZ server running in Docker, connectable by players, auto-restarts on crash.

### Tasks

| # | Task | Details | Verify |
|---|---|---|---|
| 1.1 | Create `.env.example` and `.env` | All config: server name, ports, RCON password, admin password, max players, RAM, Steam branch, mod IDs, API key, DB creds, Redis URL | `.env.example` exists, no secrets in it |
| 1.2 | Write `docker-compose.yml` — game server service | PZ container with volumes, ports, env vars, `restart: unless-stopped`, health check | `docker compose up game-server` starts without errors |
| 1.3 | Write `docker-compose.yml` — app service | Laravel container (Nginx+PHP-FPM or FrankenPHP), depends_on game-server, Docker socket mount, shared volumes for PZ data, internal network for RCON | `docker compose up app` starts without errors |
| 1.4 | Write `docker-compose.yml` — PostgreSQL service | Postgres container with persistent volume, health check | `docker compose up db` starts, psql connects |
| 1.5 | Write `docker-compose.yml` — Redis service | Redis container for queue, cache, rate limiting | `docker compose up redis` starts |
| 1.6 | Configure Docker networking | Internal network for RCON (not exposed), game ports exposed to host, app port exposed to host | RCON port unreachable from host, game ports reachable |
| 1.7 | Test full stack startup | `docker compose up -d`, PZ server initializes, generates config files, is joinable | Connect to server from PZ game client |

### Acceptance Criteria

- [ ] `docker compose up -d` brings up all 4 services (game-server, app, db, redis)
- [ ] PZ game server is reachable on ports 16261-16262/udp
- [ ] RCON port (27015) is only accessible within Docker network
- [ ] Game server auto-restarts if the process crashes
- [ ] Server generates config files on first boot (server.ini, SandboxVars.lua)
- [ ] PostgreSQL and Redis are accessible from the app container

---

## Phase 2 — Laravel Foundation & RCON Client

**Goal:** Laravel boots, connects to RCON, can execute commands against the live PZ server.

### Tasks

| # | Task | Details | Verify |
|---|---|---|---|
| 2.1 | Initialize Laravel 12 project | `composer create-project laravel/laravel`, configure for API: install Sanctum, Scribe. Remove unused frontend scaffolding. | `php artisan serve` works |
| 2.2 | Create `config/zomboid.php` | Config file loading from env: RCON host/port/password, Docker socket path, PZ data paths, server container name, game server name | Config loads correctly from `.env` |
| 2.3 | Create `Services/RconClient.php` | Source RCON implementation: connect via TCP socket, authenticate, send command, read response, handle timeouts, reconnect on failure. Registered as singleton in service container. | Unit test: mock socket, verify protocol bytes |
| 2.4 | Create `Services/DockerManager.php` | HTTP client to Docker Engine API via Unix socket (`/var/run/docker.sock`). Methods: `startContainer()`, `stopContainer()`, `restartContainer()`, `getContainerStatus()`, `getContainerLogs()`. Registered as singleton. | Unit test: mock HTTP responses |
| 2.5 | Create `Http/Middleware/ApiKeyAuth.php` | Check `X-API-Key` header against `config('zomboid.api_key')`. Return 401 JSON on failure. Exclude public routes. Register in `bootstrap/app.php`. | Test: request without key → 401, with key → passes |
| 2.6 | Configure rate limiting | Use Laravel's built-in `RateLimiter` facade in `AppServiceProvider`. Define `api` limiter (60/min auth, 15/min public). | Test: exceed limit → 429 |
| 2.7 | Health check endpoint | `GET /api/health` — returns `{"status": "ok", "rcon": "connected|disconnected", "db": "connected|disconnected"}` | curl returns health JSON |
| 2.8 | Write `app/Dockerfile` | PHP 8.3 + extensions (pdo_pgsql, redis, sockets, pcntl), Composer install, Nginx or FrankenPHP, expose port 8000 | Docker build succeeds, container starts |
| 2.9 | Integration test: RCON against live server | Boot full stack, send `players` command via RCON, verify response | Command returns player list (or empty) |

### Acceptance Criteria

- [ ] Laravel app boots inside Docker container
- [ ] `GET /api/health` returns status JSON
- [ ] RCON client connects to game server and executes `players` command
- [ ] RCON client handles game server being offline gracefully (returns error, doesn't crash)
- [ ] API key auth blocks unauthorized requests with 401
- [ ] Rate limiter returns 429 when threshold exceeded

---

## Phase 3 — Database & Audit Logging

**Goal:** PostgreSQL connected, migrations running, all admin API actions logged to audit_logs.

### Tasks

| # | Task | Details | Verify |
|---|---|---|---|
| 3.1 | Configure PostgreSQL connection | `.env` DB_CONNECTION=pgsql, verify Eloquent connects | `php artisan migrate` runs |
| 3.2 | Create `AuditLog` model + migration | Fields: id (UUID), actor (string), action (string), target (string nullable), details (jsonb nullable), ip_address (string nullable), created_at. Indexes on (action, created_at). | `php artisan migrate` creates table |
| 3.3 | Create `Services/AuditLogger.php` | `log(actor, action, target, details, ip)` — creates AuditLog record. Registered as singleton. Static helper `AuditLogger::record()` for convenience. | Unit test: creates record in DB |
| 3.4 | Create audit middleware | `AuditApiActions` middleware: after response, log admin endpoint calls (method, path, actor from API key, IP, request body summary). Applied to admin route group. | Every admin API call produces an audit_log row |
| 3.5 | `GET /api/audit` endpoint | Paginated audit log. Query params: `action`, `actor`, `from`, `to`, `per_page`. Admin only. Returns via API Resource. | Returns paginated audit entries |

### Acceptance Criteria

- [x] `php artisan migrate` runs without errors on fresh DB
- [x] `php artisan migrate:rollback` rolls back cleanly
- [x] Audit log records created for every admin API call
- [x] Audit log stores: who did what, to what target, with what details, from what IP, when
- [x] `GET /api/audit` returns paginated audit log entries (admin only)

---

## Phase 4 — Server Control Endpoints

**Goal:** Full server lifecycle management via API — start, stop, restart, save, broadcast, status, logs.

### Tasks

| # | Task | Details | Verify |
|---|---|---|---|
| 4.1 | `GET /api/server/status` | DockerManager for container state + RconClient `players` for count + parse server.ini for version/map. Returns: `{online, player_count, players, uptime, version, map, max_players}`. **Public endpoint** (no auth, no audit). | curl returns correct JSON when server is up AND when server is down |
| 4.2 | `POST /api/server/start` | DockerManager `startContainer()`. Return error if already running. Audit log. | Start stopped container, verify it starts |
| 4.3 | `POST /api/server/stop` | RCON `save` → wait 5s → RCON `quit` → DockerManager `stopContainer(timeout: 30)`. Audit log. | Server saves world and shuts down cleanly |
| 4.4 | `POST /api/server/restart` | Accept optional `{countdown, message}` via FormRequest. If countdown: broadcast warning, dispatch delayed restart job. Otherwise immediate save+restart. Audit log. | Restart with countdown, verify server comes back online |
| 4.5 | `POST /api/server/save` | RCON `save`. Return success/failure. Audit log. | Save triggers, world files updated on disk |
| 4.6 | `POST /api/server/broadcast` | Accept `{message}` via FormRequest. RCON `servermsg`. Audit log. | Message appears in-game for connected players |
| 4.7 | `GET /api/server/logs` | DockerManager `getContainerLogs(tail, since)`. Query params: `tail` (int), `since` (timestamp). Return as array of log lines. | Returns last N lines of server output |

### Acceptance Criteria

- [x] All 7 endpoints return correct JSON responses
- [x] `/api/server/status` works without auth and returns accurate data
- [x] `/api/server/status` returns `{"online": false, ...}` when server is down (no 500 error)
- [x] Stop performs graceful save before shutdown
- [x] Restart with countdown broadcasts warning message then restarts
- [x] Every admin endpoint creates an audit_log entry
- [x] All endpoints handle "server offline" case without crashing

---

## Phase 5 — Configuration Management Endpoints

**Goal:** Read and modify server.ini and SandboxVars.lua via API without SSH access.

### Tasks

| # | Task | Details | Verify |
|---|---|---|---|
| 5.1 | Create `Services/ServerIniParser.php` | Read PZ `server.ini` → associative array. Write array → `server.ini`. Handle PZ-specific format (semicolon-separated lists for Mods/WorkshopItems/Map, `=` key-value). Preserve comments and ordering. | Round-trip test: read → write → read produces identical output |
| 5.2 | Create `Services/SandboxLuaParser.php` | Read `SandboxVars.lua` → nested array. Write nested array → valid Lua. Handle nested `SandboxVars = { ... }` structure with typed values (int, float, bool, string). Handle sub-tables like `ZombieLore`. | Round-trip test: read → write → read produces identical output |
| 5.3 | `GET /api/config/server` | Parse server.ini, return as JSON | Returns all server.ini fields as key-value pairs |
| 5.4 | `PATCH /api/config/server` | Accept partial JSON via FormRequest with validation. Update only specified fields. Return `{updated_fields, restart_required: true}`. Audit log with before/after values. | Update MaxPlayers, verify file changed on disk |
| 5.5 | `GET /api/config/sandbox` | Parse SandboxVars.lua, return as nested JSON | Returns all sandbox variables |
| 5.6 | `PATCH /api/config/sandbox` | Accept partial nested JSON via FormRequest. Update sandbox vars. Return `{updated_fields, restart_required: true}`. Audit log with before/after values. | Update ZombieLore.Speed, verify file changed on disk |

### Acceptance Criteria

- [x] INI parser handles PZ's semicolon-separated list format (Mods=, WorkshopItems=, Map=)
- [x] Lua parser handles nested SandboxVars structure including ZombieLore sub-table
- [x] Config reads return valid JSON matching actual file contents
- [x] Config patches update only specified fields, leave others untouched
- [x] All config changes are audit-logged with before/after values
- [x] Response indicates `restart_required: true` when server needs restart

---

## Phase 6 — Player Management Endpoints

**Goal:** Full player admin via API — list, kick, ban, set access levels, teleport, give items.

### Tasks

| # | Task | Details | Verify |
|---|---|---|---|
| 6.1 | `GET /api/players` | RCON `players` → parse into structured array: `[{name, steam_id, access_level}]`. Handle empty server. | Returns player list, empty array when nobody online |
| 6.2 | `GET /api/players/{name}` | RCON commands to get player details. Return 404 if not found. | Returns player details for connected player |
| 6.3 | `POST /api/players/{name}/kick` | Accept `{reason?}`. RCON `kickuser`. Audit log. | Player disconnected |
| 6.4 | `POST /api/players/{name}/ban` | Accept `{reason?, ip_ban?}`. RCON `banuser` (+ `banid` if IP). Audit log. | Player banned |
| 6.5 | `DELETE /api/players/{name}/ban` | RCON `unbanuser`. Audit log. | Player unbanned |
| 6.6 | `POST /api/players/{name}/setaccess` | Accept `{level}` via FormRequest with enum validation. RCON `setaccesslevel`. Audit log. | Access level changed |
| 6.7 | `POST /api/players/{name}/teleport` | Accept `{x, y, z?}` OR `{target_player}`. RCON `teleport` or `teleportto`. Audit log. | Player teleported |
| 6.8 | `POST /api/players/{name}/additem` | Accept `{item_id, count?}`. RCON `additem`. Audit log. | Item in player inventory |
| 6.9 | `POST /api/players/{name}/addxp` | Accept `{skill, amount}`. RCON `addxp`. Audit log. | XP increased |
| 6.10 | `POST /api/players/{name}/godmode` | RCON `godmod` (toggles). Audit log. | Godmode toggled |

### Acceptance Criteria

- [x] Player list returns accurate data matching connected players
- [x] All RCON player commands execute and return confirmation
- [x] Kick/ban include reason in server-side logs
- [x] All player actions are audit-logged
- [x] Endpoints return appropriate errors when player is not online
- [x] `additem` with valid PZ item IDs works (tested with `Base.Axe`)

---

## Phase 7 — Mod Management Endpoints

**Goal:** Add, remove, and list Steam Workshop mods via API.

### Tasks

| # | Task | Details | Verify |
|---|---|---|---|
| 7.1 | Create `Services/ModManager.php` | Parse `Mods=` and `WorkshopItems=` from server.ini (semicolon-separated). Maintain paired list: each mod has (workshop_id, mod_id). Add/remove/reorder. Handle `Map=` for map mods. Uses `ServerIniParser` under the hood. | Unit test: add, remove, reorder operations |
| 7.2 | `GET /api/config/mods` | Return `[{workshop_id, mod_id, position}]` parsed from server.ini | Returns accurate mod list |
| 7.3 | `POST /api/config/mods` | Accept `{workshop_id, mod_id, map_folder?}` via FormRequest. Add to both ini lines. Return `{added, restart_required}`. Audit log. | Mod added, fields in sync |
| 7.4 | `DELETE /api/config/mods/{workshop_id}` | Remove from both lines + `Map=` if present. Return `{removed, restart_required}`. Audit log. | Mod removed, both fields updated |
| 7.5 | `PUT /api/config/mods/order` | Accept full ordered list. Replace both lines. Audit log. | Order matches submitted list |

### Acceptance Criteria

- [x] Mods added appear in both `WorkshopItems=` and `Mods=` with semicolons
- [x] Mods removed are cleaned from both lines
- [x] Mod order can be rearranged for dependency management
- [x] Map mods update the `Map=` field correctly
- [x] After mod changes + restart, mods are downloaded/loaded
- [x] All mod changes are audit-logged

---

## Phase 8 — API Documentation, Testing & MVP Delivery

**Goal:** Complete MVP — tests pass, API docs complete, deployment ready.

### Tasks

| # | Task | Details | Verify |
|---|---|---|---|
| 8.1 | Write unit tests (Pest) | ServerIniParser (round-trip), SandboxLuaParser (round-trip), ModManager (add/remove/reorder), RconClient (mocked), AuditLogger | `php artisan test --filter=Unit` — all pass |
| 8.2 | Write feature tests (Pest) | Full API tests against test database: server, config, player, mod endpoints. Auth checks (401 without key, 200 with). Rate limit check. | `php artisan test --filter=Feature` — all pass |
| 8.3 | Finalize `.env.example` | Document every env var with comments | File covers all config |
| 8.4 | Write `README.md` | Prerequisites, .env config, `docker compose up`, API key setup, connecting to server, API usage examples | Follow README from scratch → running server |
| 8.5 | Generate API docs with Scribe | Install Scribe, annotate controllers, `php artisan scribe:generate`. Verify all endpoints documented with request/response examples. | `/docs` serves complete API documentation |
| 8.6 | End-to-end smoke test | Fresh `docker compose up`, connect PZ client, use every API endpoint, verify audit log | All features work on clean deployment |

### Acceptance Criteria (MVP Complete)

- [x] **Players can connect and play on the server**
- [x] **Admin can fully manage the server without SSH — only via API**
- [x] **Mods can be added/removed and server restarted via API**
- [x] **Server auto-restarts on crash**
- [x] All unit tests pass
- [x] All feature tests pass
- [ ] Scribe API docs are complete and accurate
- [ ] README allows fresh deployment from zero
- [x] Audit log captures every admin action

---

## Phase 9 — Backup System (Stage 2 Start)

**Goal:** Automated and manual backups with retention policies.

### Tasks

| # | Task | Details | Verify |
|---|---|---|---|
| 9.1 | Add queue worker to docker-compose | Laravel queue worker container (same image, `php artisan queue:work`). Redis already available from Phase 1. | Queue worker starts, processes test job |
| 9.2 | Create `Backup` model + migration | Fields: id (UUID), filename, path, size_bytes, type (enum: manual/scheduled/daily/pre_rollback/pre_update), notes (nullable), created_at | `php artisan migrate` creates table |
| 9.3 | Create `Services/BackupManager.php` | `createBackup(type, notes?)`: RCON save → wait 5s → tar.gz save dir + ini + sandbox + db files → store → record in DB → cleanup per retention. `deleteBackup(id)`: remove file + record. `cleanupRetention(type, keep)`. | Unit test: mocked filesystem, verify logic |
| 9.4 | Create `Jobs/CreateBackupJob.php` | Dispatchable job wrapping `BackupManager::createBackup()`. Used by scheduler and manual trigger. | Job processes successfully |
| 9.5 | `POST /api/backups` | Dispatch `CreateBackupJob` synchronously (manual). Return backup metadata. Audit log. | Creates backup, returns JSON |
| 9.6 | `GET /api/backups` | List all backups. Query params: `type`, `per_page`. Sort by created_at desc. Paginated via API Resource. | Returns paginated list |
| 9.7 | `DELETE /api/backups/{id}` | Delete file + record. Audit log. | File and record removed |
| 9.8 | `GET /api/backups/schedule` | Return current schedule config from `config/zomboid.php` or DB settings. | Returns schedule JSON |
| 9.9 | `PUT /api/backups/schedule` | Update schedule in DB/config. Audit log. | Schedule updated |
| 9.10 | Register scheduled tasks | In `routes/console.php`: hourly `CreateBackupJob` dispatch, daily snapshot dispatch. Both use retention from config. | `php artisan schedule:list` shows backup tasks |

### Acceptance Criteria

- [x] Manual backup creates valid tar.gz of save directory + config files
- [x] Backup metadata recorded in PostgreSQL
- [x] Scheduled backups run automatically (hourly and daily)
- [x] Retention policy enforced: old backups auto-deleted
- [x] Backups can be listed, inspected, and deleted via API

---

## Phase 10 — Rollback System

**Goal:** Restore server to any previous backup state with safety backup.

### Tasks

| # | Task | Details | Verify |
|---|---|---|---|
| 10.1 | `POST /api/backups/{id}/rollback` | Accept `{confirm: true}` via FormRequest. Steps: create pre-rollback backup → stop server → extract backup over save dir → start server → audit log. Return result. | Rollback to backup, server comes back with old save |
| 10.2 | Pre-rollback safety backup | `BackupManager::createBackup('pre_rollback')` before any rollback. Retention: keep last 5. | Backup exists after every rollback |
| 10.3 | Rollback validation | Verify backup record exists, file exists on disk, file is valid tar.gz. Return 404/422 on failure. | Invalid/corrupted backup → clear error |

### Acceptance Criteria

- [x] Rollback stops server, replaces save, restarts server
- [x] Pre-rollback backup always created before rollback
- [x] Server comes back online with the rolled-back world state
- [x] Rollback to non-existent or corrupted backup returns clear error
- [x] Entire rollback process is audit-logged

---

## Phase 11 — PostgreSQL Schema Expansion & Whitelist

**Goal:** Users table, whitelist sync table, whitelist CRUD against PZ's SQLite db.

### Tasks

| # | Task | Details | Verify |
|---|---|---|---|
| 11.1 | Create `User` model + migration | Fields: id (UUID), steam_id (unique nullable), username (unique), email (unique nullable), password (nullable), role (enum: super_admin/admin/moderator/player), timestamps. Designed for future Sanctum JWT auth. | Migration runs |
| 11.2 | Create `WhitelistEntry` model + migration | Fields: id (UUID), user_id (FK nullable), pz_username, pz_password_hash, synced_at (nullable), active (bool default true), timestamps. | Migration runs |
| 11.3 | Create `Services/WhitelistManager.php` | Read/write PZ's `serverPZ.db` SQLite database (separate SQLite connection in `config/database.php`). Methods: `list()`, `add(username, password)`, `remove(username)`, `exists(username)`, `syncWithPostgres()`. | Unit test: CRUD on test SQLite DB |
| 11.4 | `GET /api/whitelist` | List all whitelisted users from PZ SQLite DB. | Returns entries |
| 11.5 | `POST /api/whitelist` | Accept `{username, password}` via FormRequest. Add to SQLite + record in PostgreSQL. Audit log. | User added, can auth in PZ |
| 11.6 | `DELETE /api/whitelist/{username}` | Remove from SQLite. Mark inactive in PG. Audit log. | User removed |
| 11.7 | `GET /api/whitelist/{username}/status` | Check SQLite. Return `{whitelisted: bool}`. | Correct status |
| 11.8 | `POST /api/whitelist/sync` | Sync PG whitelist_entries with SQLite state. Report discrepancies. Audit log. | Sync completes, mismatches reported |

### Acceptance Criteria

- [x] Users table supports future JWT/subscription needs
- [x] Whitelist CRUD operates on PZ's actual SQLite database
- [x] Adding user → can join when `Open=false`
- [x] Removing user → denied entry
- [x] Whitelist sync detects PG/SQLite mismatches
- [x] All operations are audit-logged

---

## Phase 12 — Stage 2 Testing & Delivery

**Goal:** Complete Stage 2 — backups, rollbacks, whitelist all tested and documented.

### Tasks

| # | Task | Details | Verify |
|---|---|---|---|
| 12.1 | Unit tests for backup system | Backup creation (mocked filesystem), retention cleanup, schedule config | Tests pass |
| 12.2 | Unit tests for whitelist | SQLite CRUD, sync logic | Tests pass |
| 12.3 | Feature tests | Full backup→rollback cycle via API, whitelist add→check→remove cycle | Tests pass |
| 12.4 | Update README | Backup schedule config, whitelist management, new env vars | Docs match features |
| 12.5 | Update Scribe API docs | All new endpoints documented with examples | `php artisan scribe:generate` completes |
| 12.6 | End-to-end test | Backup → play → rollback → verify old state. Whitelist: add → set Open=false → verify access control. | All features verified |

### Acceptance Criteria (Stage 2 Complete)

- [x] **Backups run on schedule without manual intervention**
- [x] **Admin can list, create, rollback, delete backups via API**
- [x] **Pre-rollback safety backup is always created automatically**
- [x] **Whitelist API works — can add/remove users**
- [x] All new tests pass
- [ ] Documentation updated

---

## Phase 13 — Public Pages & Dashboard Overview (Stage 3 Start)

**Goal:** Landing page for players, public server status page, and admin dashboard overview with real data.

### Architecture

Inertia web controllers consume existing services directly (RconClient, DockerManager, etc.) — not HTTP calls to API routes. The API endpoints remain for external consumers. Admin pages use Fortify session auth (already scaffolded). Live data uses Inertia v2 polling.

### Tasks

| # | Task | Details | Verify |
|---|---|---|---|
| 13.1 | Create `StatusController` | `GET /status` — public (no auth). Uses DockerManager + RconClient + ServerIniParser to return: online, player_count, players, map, max_players, uptime, mods. Inertia response. | Page renders with server data |
| 13.2 | Create `DashboardController` | `GET /dashboard` — auth required. Returns: server status, recent audit logs (last 10), backup stats (count, last backup, total size), player count. Inertia response. | Dashboard shows real data |
| 13.3 | Build public status page (`pages/status.tsx`) | Server status card (online/offline indicator, player count, map, uptime), player list, mod list. Inertia polling (5s interval) for live updates. No auth required, no sidebar layout. | Status page updates live |
| 13.4 | Redesign welcome/landing page (`pages/welcome.tsx`) | Hero section with server name + status badge, features grid (RCON management, mod support, backups, whitelist), mini server status widget, CTA to join/login. Gaming-themed design. | Landing page looks polished |
| 13.5 | Build dashboard overview (`pages/dashboard.tsx`) | Replace placeholder with: server status card (start/stop/restart buttons), player count card, backup summary card, recent audit activity table. | Dashboard shows all data |
| 13.6 | Update sidebar navigation | Add nav items: Dashboard, Players, Config, Mods, Backups, Whitelist, Audit Log, RCON Console, Logs. Use Lucide icons. | All nav items visible |
| 13.7 | Create TypeScript types | Types for all Inertia page props: ServerStatus, Player, AuditEntry, BackupSummary, ModEntry, etc. | Types compile without errors |
| 13.8 | Update app branding | Sidebar logo/name → "Zomboid Manager". Update app name in config. | Branding visible in sidebar and title |
| 13.9 | Tests | Feature tests for StatusController and DashboardController (mocked services). | Tests pass |

### Acceptance Criteria

- [ ] Public status page shows live server data at `/status` (no auth)
- [ ] Landing page at `/` has hero, features, and server status widget
- [ ] Dashboard at `/dashboard` shows real server data (auth required)
- [ ] Inertia polling updates status page every 5 seconds
- [ ] Sidebar has all admin nav items
- [ ] Branding is "Zomboid Manager" throughout

---

## Phase 14 — Admin Management Pages

**Goal:** Full admin UI for players, config, mods, backups, whitelist, and audit logs.

### Tasks

| # | Task | Details | Verify |
|---|---|---|---|
| 14.1 | Create `Admin\PlayerController` | Inertia responses for player list + actions (kick, ban, setaccess, teleport, additem, addxp, godmode). Uses RconClient. | Player page loads with data |
| 14.2 | Build player management page | Online player table with action dropdowns (kick, ban, set access level). Action modals with confirmation. Real-time via polling. | Can kick/ban from UI |
| 14.3 | Create `Admin\ConfigController` | Inertia responses for server.ini and sandbox config. GET to show, PATCH to update. Uses ServerIniParser + SandboxLuaParser. | Config page loads |
| 14.4 | Build server config editor | Tabbed layout: Server Settings (server.ini) + Sandbox Settings (SandboxVars.lua). Form inputs for each setting with save button. Shows restart_required banner. | Can edit and save config |
| 14.5 | Create `Admin\ModController` | Inertia responses for mod list. Add/remove/reorder. Uses ModManager. | Mod page loads |
| 14.6 | Build mod manager page | Mod list with drag-to-reorder, add mod form (workshop ID + mod ID), remove button with confirmation. | Can add/remove/reorder mods |
| 14.7 | Create `Admin\BackupController` | Inertia responses for backup list, create, delete, rollback. Uses BackupManager. | Backup page loads |
| 14.8 | Build backup management page | Backup table (filename, size, type, date), create backup button, rollback button with confirmation modal, delete button. Schedule display. | Can create/rollback/delete backups |
| 14.9 | Create `Admin\WhitelistController` | Inertia responses for whitelist CRUD + sync. Uses WhitelistManager. | Whitelist page loads |
| 14.10 | Build whitelist management page | Whitelist table, add user form (username + password), remove button, sync button with status report. | Can manage whitelist |
| 14.11 | Create `Admin\AuditController` | Inertia responses for paginated audit log with filters (action, actor, date range). | Audit page loads |
| 14.12 | Build audit log viewer | Audit log table with pagination, filter dropdowns (action type, actor), date range picker. Expandable rows for details JSON. | Audit log browsable |
| 14.13 | Tests | Feature tests for all admin controllers (mocked services). | Tests pass |

### Acceptance Criteria

- [ ] Admin can manage players from web UI (kick, ban, set access)
- [ ] Admin can edit server.ini and sandbox settings via forms
- [ ] Admin can add/remove/reorder mods via web UI
- [ ] Admin can create/delete/rollback backups via web UI
- [ ] Admin can manage whitelist entries via web UI
- [ ] Audit log is browsable with filters and pagination
- [ ] All admin actions through the UI are audit-logged
- [ ] All pages are responsive (usable on mobile)

---

## Phase 15 — RCON Console, Live Logs & Polish

**Goal:** RCON console in browser, live server logs, final polish.

### Tasks

| # | Task | Details | Verify |
|---|---|---|---|
| 15.1 | Create `Admin\RconController` | POST endpoint for executing RCON commands (Inertia or JSON). Uses RconClient. Audit-logged. | RCON command executes |
| 15.2 | Build RCON console page | Terminal-style UI: command input, scrollable output history, command history (up arrow). Dark terminal aesthetic. | Can send commands and see responses |
| 15.3 | Create `Admin\LogController` | GET endpoint for server container logs. Uses DockerManager::getContainerLogs(). Polling for live updates. | Logs page loads |
| 15.4 | Build live log viewer | Log output with auto-scroll, tail count selector, auto-refresh toggle. Monospace font, syntax-highlighted timestamps. | Logs stream live |
| 15.5 | Server control actions on dashboard | Start/stop/restart buttons on dashboard with confirmation modals. Status indicator updates via polling. | Can control server from dashboard |
| 15.6 | Error handling & loading states | Skeleton loaders for all pages, error boundaries, toast notifications for actions (success/failure). | No blank screens during loading |
| 15.7 | Responsive polish | Test all pages on mobile viewport. Fix any layout issues. Ensure sidebar collapses properly. | All pages usable on mobile |
| 15.8 | Tests | Feature tests for RCON and log controllers. | Tests pass |

### Acceptance Criteria

- [ ] RCON console works in browser — send command, see response
- [ ] Server logs stream in real-time with auto-scroll
- [ ] Server can be started/stopped/restarted from dashboard
- [ ] All pages have proper loading states and error handling
- [ ] Toast notifications for all admin actions
- [ ] All pages responsive on mobile
- [ ] All new tests pass

---

## Future Phases (Outlined, Not Detailed)

### Phase 16: Player Registration & PZ Account Sync (Stage 4)

Bidirectional account sync — same username + password works on both web and game server.

**Registration flow (Web → PZ):**
- Registration form: username (required, unique) + password (required) + email (optional)
- Username validated for uniqueness against both `users` table and `serverPZ.db`
- On register: create web User + auto-create PZ account in `serverPZ.db` via `WhitelistManager::add()`
- Link `WhitelistEntry` to `User` via `user_id`
- Web login uses username + password (not email)
- If email provided → send verification email (Fortify email verification flow)

**Auto-sync (PZ → Web):**
- Scheduled job (`SyncPzAccounts`) runs periodically, reads `serverPZ.db`
- New SQLite entries without a matching User → auto-create web User with same username + password (plain text from PZ)
- Email left null — auto-synced users can add email later in profile
- Link `WhitelistEntry` to auto-created `User`
- Skip any username that already exists in `users` table (no duplicates)

**Email verification:**
- Email is optional at registration and for auto-synced accounts
- When a user adds/changes email → verification email sent
- Verified badge shown in profile; unverified email gets periodic reminder
- Admin pages still require `verified` middleware (admins must have verified email)
- Player-facing pages accessible without verified email

**Player portal:**
- React/Inertia page: PZ account status, change password (syncs to both PostgreSQL + `serverPZ.db`)
- Add/update email with verification
- Show whitelist status, online/offline (if available via RCON)

**Key constraints:**
- Username is the primary login field (not email)
- Usernames unique across both databases
- Password changes on web update `serverPZ.db` plain text too (PZ limitation)
- Password changes in-game picked up by next sync run

**Tests:**
- Web registration creates PZ account in SQLite
- In-game account auto-synced to web User
- Username uniqueness enforced in both directions
- Password change syncs to both databases
- Email verification flow (optional email, send verification, verify link)
- Login with username + password (not email)

### Phase 17: Config Page UX Overhaul (Stage 4)

Replace flat text inputs with smart, grouped, collapsible config sections.

- **Config metadata system:** Define each setting's type (boolean, number, string, enum), description, default value, and group
- **Server.ini groups:** General, Network, Players, Security, World, Advanced — each as a collapsible `<Collapsible>` section
- **SandboxVars groups:** Zombie Lore, Time & Seasons, World, Loot, Vehicle, Meta — collapsible sections
- **Smart input types:**
  - Boolean settings → `<Switch>` toggles (e.g., `PauseEmpty`, `SteamVAC`, `Open`)
  - Enum settings → `<Select>` dropdowns (e.g., zombie speed, difficulty presets)
  - Numeric settings → `<Input type="number">` with min/max validation (e.g., `MaxPlayers`, `SaveWorldEveryMinutes`)
  - String settings → `<Input type="text">` (e.g., `Password`, `ServerName`)
  - Semicolon lists → read-only display (Mods/WorkshopItems managed on Mods page)
- **Descriptions:** Help text under each input explaining what the setting does
- **Search/filter:** Quick filter to find settings by name
- **Sensitive fields:** Hide `RCONPassword`, `AdminPassword` behind reveal toggles
- **shadcn/ui components:** Collapsible, Switch, Select, Tooltip, Input, Badge
- **Tests:** Config renders with correct input types, save still works, grouping correct

### Phase 18: PZ Lua Bridge Mod (Stage 4)

Custom server-side Lua mod that bridges game data to the Laravel app via shared Docker volume.

**Mod structure (`game-server/mods/ZomboidManager/`):**
- `mod.info` — mod metadata (name, id, description)
- `media/lua/server/ZM_Main.lua` — entry point, event hooks
- `media/lua/server/ZM_InventoryExporter.lua` — inventory snapshot logic
- `media/lua/server/ZM_DeliveryQueue.lua` — give/remove item queue consumer
- `media/lua/server/ZM_PlayerTracker.lua` — position tracking

**Inventory snapshots:**
- On `OnCreatePlayer` + `EveryTenMinutes`, serialize each online player's inventory to JSON via `getFileWriter()`
- For each item: `fullType` (e.g. `Base.Axe`), `name`, `category`, `count`, `condition`
- Write to `/pz-data/Lua/inventory/<username>.json`

**Delivery queue consumer:**
- On `OnCreatePlayer` + `EveryOneMinuteTick`, read `/pz-data/Lua/delivery_queue.json`
- Process pending give/remove actions for online players
- Give: `player:getInventory():AddItem(itemType)`
- Remove: `player:getInventory():removeItemOnServer(item)`
- Mark entries as delivered, write results back to `/pz-data/Lua/delivery_results.json`

**Player position snapshots:**
- On `EveryTenMinutes`, write all online player positions (x, y, z, isDead) to `/pz-data/Lua/players_live.json`

**Docker integration:**
- Mod files mounted into game server container via Docker volume or baked into image
- JSON files written to shared `zomboid-data` volume, readable by Laravel app at `/pz-data/Lua/`

**Tests:**
- Delivery queue JSON format validation (write/read round-trip)
- Inventory snapshot JSON schema tests
- Laravel services that read/write the queue files

### Phase 19: Admin Player Map (Stage 4)

Leaflet.js interactive map showing all player positions.

**Second SQLite connection (`pz_players`):**
- Add `pz_players` DB connection in `config/database.php` pointing to `Saves/Multiplayer/<ServerName>/players.db`
- Read `networkPlayers` table: username, name, x, y, z, isDead
- Used for all player positions + alive/dead status (online and offline)

**Admin Player Map page (`/admin/players/map`):**
- Leaflet.js interactive map with PZ map tiles (from map.projectzomboid.com or self-hosted)
- Player markers plotted at (x, y) coordinates — online from `players_live.json`, offline from `players.db`
- Marker popups: player name, alive/dead, coordinates, online status
- Color-coded markers: green = online, grey = offline, red = dead
- Auto-refresh via Inertia polling
- Click marker → link to player detail page

**Player portal map:**
- Players can see their own last known position on a smaller map widget in their profile

**Tests:**
- Player map controller returns correct coordinate data
- Markers render with correct color coding
- Offline fallback to players.db works

### Phase 20: Admin Inventory Management (Stage 4)

View and manage player inventories with item icons via the Lua bridge.

**Item icon pipeline:**
- Download PZ item icons (PNGs) from PZwiki or extract from game files
- Store in `public/images/items/`
- Mapping: `Base.Axe` → `Item_Axe.png`, `Base.Pistol` → `Item_Pistol.png`
- Fallback placeholder icon for unknown/modded items

**Admin Inventory page (`/admin/players/{username}/inventory`):**
- Read inventory from `/pz-data/Lua/inventory/<username>.json` (written by Lua bridge)
- Display items in a grid with item icons
- Item details: name, type, category, condition bar, count
- **Give item:** Searchable item selector with icons + autocomplete → writes to `delivery_queue.json` → delivered on next player login or periodic tick
- **Remove item:** Click item in inventory → confirm → writes remove action to `delivery_queue.json`
- **Delivery status:** Show pending/delivered/failed status for queued actions
- Works for offline players: actions queue up, delivered when player next logs in
- All actions audit-logged

**Laravel services:**
- `InventoryReader` — reads inventory snapshot JSON files
- `DeliveryQueueManager` — writes give/remove actions to `delivery_queue.json`, reads results from `delivery_results.json`
- `ItemIconResolver` — maps item type to icon path with fallback

**Tests:**
- Inventory display parses snapshot JSON correctly
- Give/remove actions create correct queue entries
- Delivery status read from results file
- Icon mapping resolves correct filenames
- Audit logging for all inventory actions

### Phase 21: Dashboard & UX Polish (Stage 4)

- Improved responsive layout for mobile/tablet
- Toast notifications for all admin actions (save, restart, kick, etc.)
- Loading skeletons for deferred props
- Quick-action cards on dashboard (restart, save, player count, mod count)
- Error boundary pages (404, 500, maintenance)
- **In-game time & weather widget** — display current PZ game time and weather conditions (temperature, rain, fog) on the dashboard via Lua bridge export (`getGameTime()`, `getClimateManager()`)
- **Player leaderboards / top charts** — time survived, zombie kills, deaths, hours played sourced from `players.db` → `networkPlayers` table (no mod needed, direct SQLite read)
- **Player stats cards** — individual player stats displayed on the players page (kills, hours, profession, skills)
- **Log Extender integration** — optional companion mod ([Workshop #1844524972](https://steamcommunity.com/sharedfiles/filedetails/?id=1844524972)) for event-driven stats. Laravel scheduler job parses `_player.txt`, `_pvp.txt`, `_craft.txt` logs into DB tables. Powers kill feed, recent deaths, crafting activity, PvP history. Auto-registered in `configure-server.sh` alongside ZomboidManager.

### Phase 22+: Subscriptions (Stage 5 — Monetization)

- Laravel Cashier (Stripe) for subscription management
- Subscription lifecycle (Cashier handles most of this)
- Auto whitelist sync via Cashier webhook events
- Admin subscription management page
- Scheduled command for periodic sub status checks

### Phase 23+: Item Shop (Stage 6 — Monetization)

- Shop item CRUD (Eloquent models + admin React/Inertia UI)
- Player shop page with categories (React + Inertia)
- Stripe payment intents for one-time purchases
- `DeliverItemJob` → writes to `delivery_queue.json` (reuses Lua bridge from Phase 18)
- Transaction history
- Admin transaction/delivery management
- Optional PayPal integration

---

## Technical Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| **PZ RCON protocol quirks** | Commands may fail silently or return unexpected formats | Build RCON response parser with extensive tests; log raw responses; test every command against live server |
| **PZ server.ini format breaks on parse** | Config parser corrupts file | Round-trip tests (read→write→read = identical); backup ini before any write |
| **SandboxVars.lua nested Lua parsing** | Complex nested structure, non-standard format | Regex-based parser for PZ's specific Lua style (not full Lua AST); round-trip tests |
| **Docker socket security** | App container has root-level Docker access | API key auth, rate limiting, audit logging; never expose Docker socket externally |
| **PZ SQLite DB locking** | Concurrent access from PZ server + API | WAL mode, short transactions, retry on lock; read-only when server is running where possible |
| **Game server OOM / crash loops** | Restart policy causes infinite loop | Docker restart with max-retries; health check with cooldown; API monitors restart count |
| **Backup disk space** | Backups fill disk | Retention policies enforced automatically; disk usage in status endpoint |
| **PZ Lua mod compatibility** | Build updates may break Lua API | Pin to stable PZ build; test mod after each PZ update; use only documented API methods |
| **File-based queue race conditions** | Laravel + PZ Lua reading/writing same JSON files | Atomic file writes (write to temp, rename); PZ Lua mod owns delivery_queue reads, Laravel owns writes |
| **players.db concurrent access** | PZ server + Laravel reading same SQLite | Read-only from Laravel; WAL mode; busy_timeout; short transactions |
| **Item icon coverage** | Modded items lack icons | Fallback placeholder icon; admin can upload custom icons for mod items |

---

## Testing Strategy

| Level | What | Tool | When |
|---|---|---|---|
| **Unit** | Config parsers, mod manager, RCON client (mocked), audit service, backup retention | Pest (Unit) | Every commit |
| **Feature** | API endpoints against test DB, auth middleware, rate limiting | Pest (Feature) with RefreshDatabase | Every commit |
| **RCON Integration** | Real RCON commands against live server | Pest (marked `@group rcon`, manual trigger) | Before phase delivery |
| **End-to-End** | Full docker-compose stack, connect game client, use all API endpoints | Manual + scripted curl | Before stage delivery |

### Test Database

- `phpunit.xml` configured with SQLite `:memory:` for fast unit/feature tests
- Separate PostgreSQL database for integration tests if needed
- Each test uses `RefreshDatabase` or `DatabaseTransactions` trait

---

## Deployment

### Initial Setup (Single VPS)

```bash
# 1. Clone repo
git clone <repo> && cd Zomboid

# 2. Configure
cp .env.example .env
# Edit .env with actual values

# 3. Launch
docker compose up -d

# 4. Run migrations
docker compose exec app php artisan migrate

# 5. Verify
curl http://localhost:8000/api/server/status
```

### Updates

```bash
git pull
docker compose build app
docker compose up -d app
docker compose exec app php artisan migrate
```

### Useful Artisan Commands

```bash
# Queue worker (runs in separate container, but for debugging)
php artisan queue:work --tries=3

# Run scheduler manually
php artisan schedule:run

# Clear caches
php artisan config:clear && php artisan cache:clear

# Generate API docs
php artisan scribe:generate
```

### CI/CD (GitHub Actions)

- **On push to main:** Run `php artisan test` (unit + feature)
- **On tag:** Build Docker image, push to registry (optional)
- No auto-deploy to production — manual `docker compose up -d` on VPS

---

## Current Status

| Phase | Status | Notes |
|---|---|---|
| Phase 1 — Docker Infrastructure | DONE | docker-compose.yml, .env.example, networking verified |
| Phase 2 — Laravel + RCON | DONE | React/Inertia starter kit, RconClient, DockerManager, ApiKeyAuth, health endpoint |
| Phase 3 — Database + Audit | DONE | AuditLog model+migration, AuditLogger service, AuditApiActions middleware, GET /api/audit endpoint, 13 tests |
| Phase 4 — Server Control | DONE | 7 endpoints, RestartGameServer job, graceful stop, countdown restart, 22 tests |
| Phase 5 — Config Management | DONE | ServerIniParser, SandboxLuaParser, 4 config endpoints, round-trip tests, 27 tests |
| Phase 6 — Player Management | DONE | 10 endpoints, kick/ban/unban/setaccess/teleport/additem/addxp/godmode, 22 tests |
| Phase 7 — Mod Management | DONE | ModManager service, add/remove/reorder endpoints, paired list sync, 11 tests |
| Phase 8 — MVP Testing & Docs | DONE | 145 tests passing, .env.example finalized. Scribe + README + E2E pending Docker env |
| Phase 9 — Backup System | DONE | Backup model, BackupManager service, CreateBackupJob, 5 API endpoints, scheduler, queue worker, 28 tests |
| Phase 10 — Rollback System | DONE | Rollback endpoint with pre-rollback safety backup, file validation, 10 tests |
| Phase 11 — Whitelist + Schema | DONE | User role+steam_id, WhitelistEntry model, WhitelistManager (SQLite CRUD + sync), 5 API endpoints, 15 tests |
| Phase 12 — Stage 2 Delivery | DONE | 203 tests passing (740 assertions), integration cycle tests. Scribe + README pending Docker env |
| Phase 13 — Public Pages + Dashboard | DONE | Landing page, /status page with polling, dashboard overview, branding, 8 new tests |
| Phase 14 — Admin Management Pages | DONE | 6 admin pages (players, config, mods, backups, whitelist, audit), 19 new tests |
| Phase 15 — RCON Console + Live Logs | DONE | RCON console, live log viewer, server start/stop/restart/save controls, 11 new tests |
| Phase 16 — Player Registration + PZ Sync | DONE | Web registration → auto PZ account, password sync, player portal, email verification, 35 tests |
| Phase 17 — Config Page UX Overhaul | DONE | Smart inputs (Switch/Select/number), grouped collapsible sections, search filter, sensitive field toggles, config metadata system, 6 new tests |
| Phase 18 — PZ Lua Bridge Mod | DONE | Server-side Lua mod: inventory snapshots, delivery queue, position tracking via shared volume |
| Phase 19 — Admin Player Map | DONE | Leaflet.js map with PZ tile rendering, player markers (online/offline/dead), action dialogs (kick/ban/access), usePoll 5s live updates, players.db SQLite connection |
| Phase 20 — Admin Inventory Management | DONE | Inventory grid with item icons, give/remove dialogs, delivery queue integration, audit logged, 17 tests |
| Phase 21 — Dashboard & UX Polish | DONE | Toast notifications (Sonner), error handling, deferred props with skeletons, game time/weather widget (Lua export), player stats/leaderboards (Lua export), Log Extender event ingestion, activity feed, mobile responsive polish, 23 new tests |
| Phase 22+ — Subscriptions | TODO | Cashier/Stripe (deferred — monetization) |
| Phase 23+ — Item Shop | TODO | Shop CRUD, payments, reuses Lua bridge delivery queue (deferred — monetization) |
