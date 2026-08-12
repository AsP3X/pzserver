# Second web stack — Rust API + Vite UI

The replacement for the Laravel + Inertia stack in `app/`. Both run side by
side during the port; nothing here modifies the PHP stack or its database.

The **KnoxRelay game mod is unchanged**. This stack reads the same JSON exports
the mod already writes into the shared `Lua/` directory.

```
web/
├── api/     Rust workspace — axum + sqlx, owns its own Postgres schema
└── ui/      Vite + React 19 + TypeScript + Tailwind v4
```

## What exists today

| Area | State |
| --- | --- |
| API foundation | Config, error envelope, tracing, CORS, graceful shutdown, migrations on boot |
| Public endpoints | `/api/health`, `/api/health/detailed`, `/api/v1/{site,server/status,server/history,stats/summary,stats/leaderboard}` |
| Localisation | English and German, in the UI strings and in the admin-editable site copy (`GET /api/v1/site?locale=de`) |
| Auth | `/api/v1/auth/{register,login,logout,me,password}` — Argon2id, server-side sessions, per-username login throttling |
| Game server integration | Source RCON client, Lua bridge readers, `server.ini` parser, Docker status via the socket proxy |
| Background tasks | Player-stats sync from the mod export, population sampling, expired-session cleanup |
| UI | Design system, i18n (en/de), landing page, sign in / register / account |

Not built yet: any admin surface, the player portal, and the shop. The old
stack still owns all of that.

## Authentication

Sessions are server-side. Logging in issues 256 bits of OS randomness as an
opaque token; the cookie carries the token, the `sessions` table stores only its
SHA-256 digest, so a database dump hands nobody a working login. Sessions can
therefore be revoked one at a time — changing a password drops every session
except the one making the request.

The cookie is `HttpOnly`, `SameSite=Lax`, `Secure`, and expires with the row it
points at. `SameSite=Lax` is the CSRF defence: the browser will not attach it to
a cross-site POST, and every state-changing endpoint is a POST.

Passwords are Argon2id with per-password salts. A login for an unknown username
still pays for a hash verification, so response time does not reveal which
accounts exist, and both failure modes return the same message.

Failed logins are throttled per username (8 per 15 minutes by default). The
counter is per username rather than per address because the API only ever sees
nginx's address; add per-address limiting at the edge alongside it.

The first administrator is created on boot from `ADMIN_USERNAME` /
`ADMIN_EMAIL` / `ADMIN_PASSWORD` — the same variables the PHP stack's entrypoint
reads — and only when the table has no administrator, so it cannot be used to
reset a forgotten password.

## Architecture notes

**Its own database.** `web-db` is a separate Postgres container with a schema
owned by sqlx migrations in `api/migrations/`. It is not a copy of the Laravel
schema, and no data has been migrated across — the new tables fill from the mod
export as it arrives. A one-off port of the historical Laravel data is a
separate job.

**Runtime-checked SQL.** Queries use `sqlx::query_as` rather than the `query!`
macros. The macros need a reachable database at *compile* time, which would mean
standing up Postgres inside the Docker build for no real benefit here.

**Offline is a status, not an error.** A stopped game server, an unreachable
Docker proxy and a wrong RCON password all resolve to a 200 with
`"state": "offline"`. The public site has to render either way.

**Status is cached.** Each resolve is reused for `STATUS_CACHE_TTL` (5s), so a
hundred visitors polling every 15 seconds still cost one RCON round-trip per
TTL.

**Freshness comes from mtimes.** The `timestamp` inside the mod's exports is
in-game time — it reads 1993 and stops whenever the world is paused. Staleness
is judged by the file's mtime, never by its contents.

## Running it

### In Docker (the real thing)

```bash
make web-up
```

Starts `web-db`, `web-api` and `web-ui`. The UI is published on
`127.0.0.1:8100` (override with `WEB_UI_PORT`); nginx inside `web-ui` proxies
`/api` to the Rust service, so the browser only ever sees one origin. The API
and database are not published at all.

```bash
make web-logs     # follow API + UI logs
make web-ps       # container status
make web-down     # stop
```

### On the host (fast iteration)

Three terminals:

```bash
make web-dev-db
```

```bash
cd web/api && cp .env.example .env && cargo run
```

```bash
cd web/ui && npm install && npm run dev
```

The UI is then on <http://localhost:5174> and proxies `/api` to
`127.0.0.1:8080`, mirroring what nginx does in production.

Two things behave differently in host mode, both expected: the Docker socket
proxy is only reachable from inside the compose network, and the game server's
RCON port is deliberately never published. The server therefore reads as
offline. Use `make web-up` to exercise those paths.

### Development data

With the game server down, every table is empty and the site renders zeroes:

```bash
make web-seed
```

Twelve survivors, three weeks of deaths, and 24 hours of population samples.
It truncates the tables it fills, so it is for development databases only.

## Checks

```bash
make web-test     # cargo test --workspace
make web-check    # clippy -D warnings + rustfmt + tsc + oxlint
```

## Configuration

The API reads its configuration from the environment and reuses the variable
names the existing stack already defines (`PZ_RCON_*`, `DOCKER_PROXY_URL`,
`PZ_DATA_PATH`, `GAME_SERVER_CONTAINER_NAME`), so one root `.env` feeds both
stacks. See `api/.env.example` for the full list and defaults.

Variables specific to this stack, all optional with defaults:

| Variable | Default | Purpose |
| --- | --- | --- |
| `WEB_DB_DATABASE` / `WEB_DB_USERNAME` / `WEB_DB_PASSWORD` | `knox` | Second Postgres credentials |
| `WEB_UI_PORT` | `8100` | Host port for the UI |
| `WEB_DB_PORT` | `55433` | Host port for Postgres in dev mode only |
| `PZ_CONNECT_HOST` | unset | Address shown on the landing page. Unset hides the connect panel |
| `STATUS_CACHE_TTL` | `5` | Seconds a resolved status is reused |
| `STATUS_SAMPLE_INTERVAL` | `300` | Seconds between population samples |
| `STATS_SYNC_INTERVAL` | `30` | Seconds between mod-export checks |

## UI conventions

- **No hardcoded user-facing strings.** Everything goes through
  `useTranslation()`; English keys in `src/i18n/en.json` define the key type, and
  `de.json` is type-checked against it, so a missing German string fails the
  build. Adding a locale means one JSON file plus an entry in
  `src/i18n/locales.ts`.
- **Don't case-transform translated text in code.** `toLowerCase()` on a label
  is safe in English and wrong in German, where nouns are capitalised. Add a
  second key instead.
- **No `Intl` compact notation.** Some browsers ship no compact patterns for
  German and `Intl` degrades silently rather than throwing, so English rendered
  "17.1k" beside a German "17.062". `formatNumber` groups instead.
- **Design tokens live in `src/styles/theme.css`** as Tailwind v4 `@theme`
  variables. Dark only, square corners, two accents: hazard amber for actions,
  moss green for anything alive.
- **Fonts are self-hosted** via `@fontsource-variable` — Oswald for display,
  Inter for text, JetBrains Mono for data. A locale outside Latin would need its
  own face added to the stacks.

### Known gaps

- **API error messages are English only.** The envelope carries a `code`, but the
  messages the UI displays come from the server, so a German page can show an
  English validation error. The fix is a specific `code` per failure that the UI
  maps to a translation key, falling back to the server's text.
- Professions on the leaderboard are the game's own English strings, straight
  from the mod export, so they stay English in German. Translating them needs a
  mapping from PZ's profession ids.
- Query-parameter validation failures return axum's plain-text rejection rather
  than the JSON error envelope. Correct status codes, inconsistent shape.
- No password reset. It needs outbound mail, which this stack has no
  configuration for yet.
