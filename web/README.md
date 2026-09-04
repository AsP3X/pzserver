# Second web stack — Rust API + Vite UI

The live web stack. It replaced the Laravel + Inertia tree that used to live
in `app/`. That PHP stack is gone; this is the only panel.

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
| Auth | `/api/v1/auth/{register,login,logout,me,password}` — Argon2id, server-side sessions, per-account login throttling |
| Player portal | `/api/v1/me/{character,inventory}` — the signed-in account's own character, vitals heartbeat and inventory snapshot |
| Game server integration | Source RCON client, Lua bridge readers, `server.ini` parser, Docker status via the socket proxy |
| Background tasks | Player-stats sync from the mod export, population sampling, expired-session cleanup |
| UI | Design system, i18n (en/de), three navigation surfaces, and the pages listed below |

## Information architecture

Three surfaces, each with its own shell and guard, defined in
`ui/src/lib/navigation.ts`:

| Surface | Path | Who | Shell |
| --- | --- | --- | --- |
| Public site | `/` | anyone | Top nav, collapses to a panel below `md` |
| Player | `/me/*` | signed in | Sidebar, off-canvas drawer below `lg` |
| Admin | `/admin/*` | staff | Sidebar, seven groups |

The old UI had one sidebar filtered by role, which left a player looking at a
"Menu" group wedged under four admin groups and an admin scrolling twenty-six
flat entries. Splitting them lets each surface pick its own density, and a
player never sees the shape of the admin panel.

Player routes sit under `/me` to match the API's `/api/v1/me/*`, rather than the
old split between `/portal/*` and `/shop/my/*`. Shop administration was six
sibling sidebar entries and is now one group.

Adding a page is one entry in one array plus one route under the matching layout
— it inherits the shell and the guard. Sections that are not built yet are
listed and marked `soon` rather than hidden, so the shape of what is coming is
visible without shipping dead links.

The UI covers the public site, player area, shop/vault/wallet, and the admin
panel. Three admin nav entries are still marked planned (vehicles, shop
promotions, Discord). Stripe subscriptions from the original plan were never
built.

## The inventory

`KR_Snapshot` writes `Lua/inventory/<username>.json` while a player is online: a
flat item list plus a container tree, where a bag is addressed by the id of the
item holding it rather than by its name — a player carrying two wallets would
otherwise have both sets of contents reported as one.

The page stacks entries by type (twelve nails are one line, and the worst
condition in a stack wins because that is the one that will break first) and
groups them by container id, indenting nested bags.

**Refreshing** writes the player's name into `export_requests.json`, which the
mod drains every tick. It only works while they are online — the mod matches
requests against its roster and drops the rest — so the endpoint refuses when
they are not, rather than leaving a button that quietly does nothing.

**Accounts are created when a player joins.** There is no public sign-up form:
appearing on the dedicated server — the whitelist or the live roster — is the
proof the character exists. `/account register` is how they later set an email
and a website password, or recover a login. An account with no character behind
it is not a state this schema can represent — `users.username` is `NOT NULL`.

## Authentication

Sessions are server-side. Logging in issues 256 bits of OS randomness as an
opaque token; the cookie carries the token, the `sessions` table stores only its
SHA-256 digest, so a database dump hands nobody a working login. Sessions can
therefore be revoked one at a time — changing a password drops every session
except the one making the request.

The cookie is `HttpOnly`, `SameSite=Lax`, `Secure`, and expires with the row it
points at. `SameSite=Lax` is the CSRF defence: the browser will not attach it to
a cross-site POST, and every state-changing endpoint is a POST.

Signing in uses the PZ name, not the email address. Registration still collects
an address — it is the only way to reach an account holder — but typing one at a
login box is slower than typing the name you already know, and since sign-up
became in-game-only every account has a name from the moment it exists.

One account is one character. Somebody who plays two survivors holds two
accounts and signs into whichever they mean by naming it, which is the same
question the email form asked less directly.

The lookup matches `lower(username)`, the same expression as
`users_username_lower_key`, so it uses that index and capitalising differently
than the game does still gets you in.

Passwords are Argon2id with per-password salts. A login for an unknown name
still pays for a hash verification, so response time does not reveal which
accounts exist, and both failure modes return the same message.

Failed logins are throttled per name (8 per 15 minutes by default), lower-cased
so that varying the capitalisation is not a way to buy another eight attempts
against one account. The counter is per account rather than per network address
because the API only ever sees nginx's; add per-address limiting at the edge
alongside it.

The first administrator is created on boot from `ADMIN_USERNAME` /
`ADMIN_EMAIL` / `ADMIN_PASSWORD` — the same variables the PHP stack's entrypoint
reads — and only when the table has no administrator, so it cannot be used to
reset a forgotten password. It is the one account that gets its username without
an in-game claim, on the grounds that the operator can assert their own name.

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

## Registering

1. The player joins the server. A website account is created automatically
   under that character's name. They can sign in with the password they use
   to join, or with Steam once the whitelist has recorded their Steam id.
2. To set an email and a separate website password — or to recover a login —
   they run `/account register` in game.
3. The mod reports who ran it; this stack opens a registration and answers
   within five seconds with a six-character code, which the mod shows them.
4. On the website they enter that code with an email and a password.

A code rather than an email address typed in game: whatever goes into the chat
channel also goes into the server log, where other players and every log reader
can see it. Codes use an alphabet with no `I`, `L`, `O`, `0` or `1`, so nothing
is lost reading one off a second monitor.

Only a completed registration consumes a code, and a code is single-use. Running
the command again replaces an outstanding code rather than adding a second, so a
character never has two live codes.

### The file contract

Both halves are built. The mod side is `KR_Enrol` plus the chat hook in
`KR_Console`, added in KnoxRelay 1.10. Joining no longer depends on that
command: website accounts are opened from the whitelist and the live roster
even on an older Knox Relay. `/account register` is still how a player sets
an email and a website password.

The channel mirrors the mod's own request/result idiom with the direction
reversed — the mod writes the requests, this stack answers.

**The mod writes `Lua/account_links.json`** when a player runs the command:

```json
{
  "version": 1,
  "updated_at": "1993-07-14T10:00:00",
  "requests": [
    {
      "id": "unique-per-run",
      "username": "pike",
      "steam_id": "76561198000000001",
      "requested_at": "1993-07-14T10:00:00"
    }
  ]
}
```

No code in the request — the player has nothing to type yet. `id` is what makes
this safe to read twice: any id that already has a result is skipped, exactly as
`KR_Orders` skips delivered ids. `steam_id` and `requested_at` are optional.

**This stack writes `Lua/account_link_results.json`:**

```json
{
  "version": 1,
  "updated_at": "2026-08-12T07:49:17Z",
  "results": [
    {
      "id": "unique-per-run",
      "username": "pike",
      "status": "issued",
      "code": "3ACQ2R",
      "expires_at": "2026-08-12T08:19:17Z",
      "at": "2026-08-12T07:49:17Z"
    }
  ]
}
```

| `status` | What the mod tells the player |
| --- | --- |
| `issued` | Shows them `code`, and that it lasts until `expires_at` |
| `already_registered` | This character already has an account — sign in instead |

`code` and `expires_at` are present only on `issued`.

A request that fails on this side is deliberately left unanswered so the next
pass retries it. `KR_Enrol` gives up after twelve heartbeats — about thirty
seconds against a five-second answer target — and tells the player to try
again rather than leaving them watching an empty screen. That timeout is
mod-side only; it never appears in the ledger.

Two rules the mod honours:

- **The mod owns the request file.** This stack only reads it, and never
  deletes from it. `KR_Enrol.prune` takes out entries that already have a
  result, or the file would grow for the life of the server.
- **The code is shown privately.** It is worth an account to whoever reads it,
  so it goes to one client as a server command and is drawn on that player's
  screen — never into a chat channel, which is echoed into the server log.

Running the command again replaces the character's outstanding request rather
than adding a second, on both sides: the mod drops the earlier entry from the
file, and `registration::open` replaces the outstanding code.

The ledger is capped at 200 entries and written to a temporary file that is then
renamed, so the mod never reads a half-written one. `web-api` therefore mounts
the bridge directory read-write, unlike the rest of the game data.

## The character page

`/character` shows the signed-in player their own survivor. Two sources feed it:

- **`player_stats`**, folded in from the mod's ten-minute export and kept in
  Postgres. Kills, hours, profession, skills, traits and a health summary. This
  is what persists when nobody is online.
- **The vitals heartbeat**, `Lua/vitals/<username>.json`, written per player
  while they are connected. Everything the mod collects: per-part health and
  wounds, core and per-part skin temperature, needs, equipped weapon, clothing
  with its bite and scratch defence, carried weight, skills with XP progress,
  and learned recipes.

The heartbeat file outlives the session, so the panels are labelled with the
file's mtime — "last known", not "now". Only parts that are hurt are listed:
nobody needs to read seventeen rows of 100%.

**The body map** is a pair of paper-dolls, condition and warmth, side by side
rather than behind a toggle: a cold hand and a bitten hand want different
responses, and reading them one after the other loses the comparison. The
silhouette is the game's own, arriving as one alpha mask per part in
`src/lib/body-sprites.ts` and tinted through a CSS mask — the shape is theirs,
every colour is ours. That file is generated data copied from the PHP stack;
regenerating it needs `scripts/extract-body-sprites.py` and a client install.

Every part carries its number as well as its colour, and the ink is chosen per
band so it reads on the fill behind it. That is not polish: the palettes run
green to red, colour alone fails the commonest form of colour blindness, and the
number is what such a reader is left with.

Temperature bands approximate where PZ shows its own moodles; the game exposes
no thresholds, so they are read off normal body temperature rather than taken
from the source.

Skills prefer the heartbeat, which carries XP progress toward the next level,
and fall back to the levels Postgres kept when no heartbeat exists.

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
  from the mod export, so they stay English in German. Body parts and wound
  kinds get the same treatment on the character page and *are* translated, via a
  lookup with a fallback — professions want the same and do not have it yet.
- Query-parameter validation failures return axum's plain-text rejection rather
  than the JSON error envelope. Correct status codes, inconsistent shape.
- No password reset. It needs outbound mail, which this stack has no
  configuration for yet.
