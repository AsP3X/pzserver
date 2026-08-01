# Phase 21: Dashboard & UX Polish

## Context
**Branch**: main (direct commits)
**Created**: 2026-02-27
**Scope**: Toast notifications, error handling, loading states, game time/weather widget, player stats & leaderboards, Log Extender integration, mobile polish

## Technical Discovery

**Current state:**
- 11 admin pages (~3,000 lines of React), all functional but no user feedback on actions
- `Skeleton` component exists (shadcn/ui) but unused across all pages
- No toast library installed — admin actions (kick, ban, save, restart, give/remove items) give zero feedback
- No custom error pages — Laravel defaults for 404/500/503
- No React error boundary — JS crashes white-screen the page
- No deferred props — all data loaded synchronously
- Dashboard shows: server status, 4 stat cards, online players, recent audit — no game state
- Lua mod exports: inventory, delivery queue, live positions, item catalog — no game time/weather/stats
- `players.db` only has username, name, x, y, z, isDead — no kill/death/skill stats
- `player:getZombieKills()`, `player:getHoursSurvived()`, `player:getPerkLevel()` available in PZ Lua API
- Log Extender mod (Workshop #1844524972) writes structured text logs for deaths, PvP, crafting, connections
- All admin pages use manual `fetch()` + `router.reload()` — no Inertia flash message pattern
- Mobile responsive via Tailwind breakpoints + Sheet sidebar, but not fully tested on all pages

**Key files:**
- Dashboard: `app/Http/Controllers/DashboardController.php`, `resources/js/pages/dashboard.tsx`
- Layout: `components/app-sidebar.tsx`, `components/app-header.tsx`, `layouts/app-layout.tsx`
- Lua mod: `game-server/mods/ZomboidManager/media/lua/server/ZM_*.lua`
- Players DB: `app/Services/PlayersDbReader.php`
- Package: `app/package.json`

## Decisions

**Locked:**
- [L1] Use `sonner` for toast notifications (shadcn/ui standard) → Phase 21.1
- [L2] Retrofit ALL existing admin actions with toast feedback → Phase 21.1
- [L3] Custom error pages (404, 500, 503) + React error boundary → Phase 21.2
- [L4] Extend ZomboidManager Lua mod for game time/weather/stats export → Phase 21.4, 21.5
- [L5] Player stats stored in PostgreSQL (not JSON) — Lua → JSON → Laravel scheduler → DB → Phase 21.5
- [L6] Log Extender as companion mod for event history (deaths, PvP, crafting) → Phase 21.6
- [L7] Log Extender events parsed into PostgreSQL tables → Phase 21.6

**Deferred:**
- [D1] Player-facing map (portal) — separate feature, not Phase 21
- [D2] Push notifications / WebSocket real-time — polling is sufficient for now

**Discretion:**
- [X1] Skeleton shape/layout per page — match existing card/table patterns
- [X2] Leaderboard categories and display format
- [X3] Which deferred props to use vs eager load per page

---

## Phase 21.1: Toast Notifications

### Requirements
Add sonner toast library and retrofit all admin actions with success/error feedback. Convert manual fetch calls to use Inertia flash messages where possible.

### Action Points
- [ ] Install `sonner` package
- [ ] Add `<Toaster>` to app layout (app.blade.php or app-layout.tsx)
- [ ] Create `useFlashToast` hook — reads Inertia shared flash data (`success`, `error`) and fires toasts automatically
- [ ] Add flash message support to `HandleInertiaRequests` middleware (share `flash.success`, `flash.error`)
- [ ] Retrofit `dashboard.tsx` server controls (save, restart, stop, start) — convert fetch to Inertia router + flash toasts
- [ ] Retrofit `players.tsx` actions (kick, ban, set access) with toasts
- [ ] Retrofit `player-map.tsx` actions (kick, ban, set access) with toasts
- [ ] Retrofit `player-inventory.tsx` actions (give, remove items) with toasts
- [ ] Retrofit `config.tsx` save action with toast
- [ ] Retrofit `mods.tsx` add/remove/reorder actions with toasts
- [ ] Retrofit `backups.tsx` create/restore/delete actions with toasts
- [ ] Retrofit `whitelist.tsx` add/remove actions with toasts
- [ ] Retrofit `rcon.tsx` command execution with error toasts (success is the response itself)
- [ ] Update admin controllers to return `redirect()->back()->with('success', '...')` for Inertia requests

### Must-Haves
**Truths:**
- [ ] Every admin action shows a toast on success AND on error
- [ ] Toasts auto-dismiss after ~4 seconds
- [ ] Flash messages work across Inertia page visits (not just same-page)

**Artifacts:**
- [ ] `app/resources/js/hooks/use-flash-toast.ts`
- [ ] Sonner in `package.json`
- [ ] `<Toaster>` in layout

**Links:**
- [ ] `useFlashToast` hook called in app layout (fires on every page)
- [ ] Admin controllers return flash data via `->with()`

### Acceptance Criteria
- [ ] Kick a player → green toast "Player kicked"
- [ ] Save config → green toast "Configuration saved"
- [ ] Action fails (server offline) → red toast with error message
- [ ] Tests pass for controller flash messages

### Test Cases
- Feature test: admin action returns flash data in redirect
- Feature test: error responses include flash error message

---

## Phase 21.2: Error Handling

### Requirements
Custom branded error pages for HTTP errors and a React error boundary to catch JS crashes gracefully.

### Action Points
- [ ] Create Inertia error page component `resources/js/pages/error.tsx` — handles 404, 403, 500, 503 with appropriate messaging
- [ ] Configure Laravel to render errors via Inertia (override exception handler render for Inertia requests)
- [ ] Create `ErrorBoundary` component wrapping each page — shows fallback UI with retry button on JS crashes
- [ ] Wrap page content in `app-layout.tsx` with ErrorBoundary
- [ ] Style error pages to match app branding (Zomboid Manager theme)

### Must-Haves
**Truths:**
- [ ] Visiting `/nonexistent-route` shows branded 404 page, not Laravel default
- [ ] JS error in a page component shows error boundary fallback, not white screen
- [ ] 503 (maintenance mode) shows appropriate page

**Artifacts:**
- [ ] `resources/js/pages/error.tsx`
- [ ] `resources/js/components/error-boundary.tsx`

**Links:**
- [ ] Error page registered in Laravel exception handler for Inertia requests
- [ ] ErrorBoundary wraps page content in app layout

### Acceptance Criteria
- [ ] 404 page renders with app branding and navigation back
- [ ] 500 page renders with "something went wrong" message
- [ ] JS crash in any admin page shows error boundary, not white screen
- [ ] Error boundary offers "Try again" button that reloads the page

### Test Cases
- Feature test: GET unknown route returns 404 with Inertia error page
- Feature test: 500 error renders error page (not JSON)

---

## Phase 21.3: Loading Skeletons & Deferred Props

### Requirements
Convert heavy dashboard data to Inertia v2 deferred props with skeleton loading states. Apply to pages where data loading is noticeable.

### Action Points
- [ ] Dashboard: defer `recent_audit` and `backup_summary` — show skeleton cards while loading
- [ ] Dashboard: add skeleton states for stat cards, online players list, recent activity table
- [ ] Players page: defer `registeredUsers` — show skeleton table
- [ ] Audit page: defer `logs` — show skeleton table
- [ ] Backups page: defer `backups` — show skeleton table
- [ ] Create reusable skeleton patterns: `SkeletonCard`, `SkeletonTable`, `SkeletonList`
- [ ] Update controllers to use `Inertia::defer()` for heavy props

### Must-Haves
**Truths:**
- [ ] Dashboard loads instantly with skeletons, then fills in data
- [ ] No layout shift when deferred data arrives
- [ ] Pages remain functional during loading (skeleton → real data transition is smooth)

**Artifacts:**
- [ ] Skeleton pattern components in `resources/js/components/`
- [ ] Controllers updated with `Inertia::defer()`

**Links:**
- [ ] Deferred props in controllers match skeleton placeholders in pages
- [ ] Skeleton components use existing `ui/skeleton.tsx` base

### Acceptance Criteria
- [ ] Dashboard shows skeleton cards that animate, then populate with real data
- [ ] Players page shows skeleton table rows before data loads
- [ ] No visual flicker or layout jump on data load

### Test Cases
- Feature test: dashboard returns deferred props correctly
- Visual verification of skeleton → data transition

---

## Phase 21.4: Game Time & Weather Widget

### Requirements
Extend Lua mod to export PZ game state (in-game time, weather, season, temperature). Add a dashboard widget showing current game conditions.

### Action Points
- [ ] Create `ZM_GameState.lua` — new Lua module exporting game state
  - `getGameTime()` → in-game date, time, day/night
  - `getClimateManager()` → temperature, rain, fog, wind
  - `getSeason()` → current season
  - Write to `Lua/game_state.json` every 1 minute (EveryOneMinute hook)
- [ ] Register `ZM_GameState` in `ZM_Main.lua` event hooks
- [ ] Create `GameStateReader` service in Laravel — reads `game_state.json` from shared volume
- [ ] Add game state data to `DashboardController` response
- [ ] Create `GameStateWidget` React component — displays time, weather icon, temperature, season
- [ ] Add widget to dashboard page (top area near server status)
- [ ] Handle missing data gracefully (server offline → "No game data available")

### Must-Haves
**Truths:**
- [ ] Widget shows current in-game time (day X, HH:MM)
- [ ] Widget shows weather conditions with appropriate icon
- [ ] Widget shows "unavailable" when server is offline or file missing

**Artifacts:**
- [ ] `game-server/mods/ZomboidManager/media/lua/server/ZM_GameState.lua`
- [ ] `app/Services/GameStateReader.php`
- [ ] `resources/js/components/game-state-widget.tsx`
- [ ] `Lua/game_state.json` format documented

**Links:**
- [ ] `ZM_Main.lua` registers `ZM_GameState` hooks
- [ ] `DashboardController` calls `GameStateReader`
- [ ] Dashboard page renders `GameStateWidget`

### Acceptance Criteria
- [ ] When server is running, dashboard shows in-game day, time, temperature, weather
- [ ] When server is offline, widget shows graceful "unavailable" state
- [ ] Data refreshes via existing 5s dashboard poll
- [ ] Lua module doesn't crash if climate data unavailable (early game startup)

### Test Cases
- Unit test: GameStateReader parses valid JSON
- Unit test: GameStateReader handles missing/malformed file
- Feature test: dashboard includes game_state in response when file exists

---

## Phase 21.5: Player Stats & Leaderboards

### Requirements
Extend Lua mod to export player stats (zombie kills, hours survived, skills). Sync to PostgreSQL via scheduler. Display on players page and dashboard leaderboard.

### Action Points
- [ ] Extend `ZM_PlayerTracker.lua` to export stats per player:
  - `player:getZombieKills()` — zombie kill count
  - `player:getHoursSurvived()` — hours survived
  - `player:getPerkLevel(Perks.*)` — all skill levels
  - `player:getDescriptor():getProfession()` — profession
  - Write to `Lua/player_stats.json` (all online players, EveryTenMinutes)
- [ ] Migration: `player_stats` table (username PK, zombie_kills, hours_survived, profession, skills JSON, updated_at)
- [ ] Create `PlayerStatsService` — reads `player_stats.json`, upserts into PostgreSQL
- [ ] Create `SyncPlayerStats` artisan command — calls PlayerStatsService
- [ ] Register command in scheduler (every 10 minutes)
- [ ] Add stats to `PlayerController` index response (join player_stats to player list)
- [ ] Create `PlayerStatsCard` component — shows individual player stats on admin players page
- [ ] Create `Leaderboard` component — top 10 players by zombie kills, hours survived
- [ ] Add leaderboard to dashboard page
- [ ] Handle players with no stats (new/never-synced) gracefully

### Must-Haves
**Truths:**
- [ ] Player stats sync from Lua JSON → PostgreSQL every 10 minutes
- [ ] Dashboard leaderboard shows top players by kills and survival time
- [ ] Players page shows stats per player (kills, hours, profession)

**Artifacts:**
- [ ] Updated `ZM_PlayerTracker.lua` with stats export
- [ ] Migration: `create_player_stats_table`
- [ ] `app/Models/PlayerStat.php`
- [ ] `app/Services/PlayerStatsService.php`
- [ ] `app/Console/Commands/SyncPlayerStats.php`
- [ ] `resources/js/components/leaderboard.tsx`

**Links:**
- [ ] Scheduler registers `SyncPlayerStats` command
- [ ] `DashboardController` queries `player_stats` for leaderboard
- [ ] `PlayerController` joins `player_stats` for player list
- [ ] Lua export writes to shared volume path read by Laravel

### Acceptance Criteria
- [ ] `php artisan zomboid:sync-player-stats` reads JSON and populates DB
- [ ] Dashboard shows top 10 leaderboard (kills, hours survived)
- [ ] Players page shows zombie kills, hours survived, profession per player
- [ ] Missing stats show "No data" gracefully
- [ ] Scheduler runs sync every 10 minutes

### Test Cases
- Unit test: PlayerStatsService parses valid stats JSON
- Unit test: PlayerStatsService handles missing/empty file
- Feature test: SyncPlayerStats command creates/updates records
- Feature test: dashboard includes leaderboard data
- Feature test: players index includes stats

---

## Phase 21.6: Log Extender Integration

### Requirements
Add Log Extender as companion mod. Parse its text logs into PostgreSQL for event-driven activity feeds (deaths, PvP, crafting, connections).

### Action Points
- [ ] Add Log Extender (Workshop #1844524972) to `configure-server.sh` mod registration
- [ ] Migration: `game_events` table (id, event_type, player, target, details JSON, game_time, created_at)
  - Event types: `death`, `pvp_kill`, `craft`, `connect`, `disconnect`
- [ ] Create `GameEvent` model
- [ ] Create `LogExtenderParser` service — parses `_player.txt`, `_pvp.txt`, `_craft.txt` log files
  - Track file position (offset) to avoid re-parsing old entries
  - Store last-read offset in cache/DB
- [ ] Create `ParseGameEvents` artisan command — calls LogExtenderParser
- [ ] Register in scheduler (every 5 minutes)
- [ ] Create `ActivityFeed` React component — shows recent events with icons (skull for death, sword for PvP, hammer for craft)
- [ ] Replace or enhance dashboard "Recent Activity" section with game events feed
- [ ] Add event filters (by type, by player)
- [ ] Handle missing Log Extender gracefully (mod not installed → show "Log Extender not detected")

### Must-Haves
**Truths:**
- [ ] Log Extender logs are parsed into PostgreSQL periodically
- [ ] Dashboard shows recent game events (deaths, kills, crafting)
- [ ] Parser is incremental (doesn't re-process old log lines)
- [ ] Works without Log Extender installed (graceful degradation)

**Artifacts:**
- [ ] Updated `configure-server.sh` with Log Extender registration
- [ ] Migration: `create_game_events_table`
- [ ] `app/Models/GameEvent.php`
- [ ] `app/Services/LogExtenderParser.php`
- [ ] `app/Console/Commands/ParseGameEvents.php`
- [ ] `resources/js/components/activity-feed.tsx`

**Links:**
- [ ] Scheduler registers `ParseGameEvents` command
- [ ] `DashboardController` queries `game_events` for activity feed
- [ ] `configure-server.sh` adds Log Extender to `Mods=` and `WorkshopItems=`

### Acceptance Criteria
- [ ] `php artisan zomboid:parse-game-events` reads log files and populates DB
- [ ] Dashboard activity feed shows deaths, PvP kills, crafting with player names and timestamps
- [ ] Parser resumes from last position (no duplicate events)
- [ ] If Log Extender not installed, dashboard shows message instead of empty feed
- [ ] Scheduler runs parsing every 5 minutes

### Test Cases
- Unit test: LogExtenderParser parses sample `_player.txt` entries
- Unit test: LogExtenderParser parses sample `_pvp.txt` entries
- Unit test: LogExtenderParser tracks file offset correctly
- Feature test: ParseGameEvents command creates event records
- Feature test: dashboard includes game events in response

---

## Phase 21.7: Mobile & Responsive Polish

### Requirements
Audit and fix responsive layout across all admin pages. Ensure usable experience on mobile and tablet.

### Action Points
- [ ] Audit all 11 admin pages at mobile (375px), tablet (768px), desktop (1280px) viewports
- [ ] Fix dashboard stat cards stacking on mobile
- [ ] Fix player inventory grid layout on small screens (currently 691 lines of complex layout)
- [ ] Fix config page collapsible sections on mobile
- [ ] Fix player map height on mobile (currently hardcoded `h-[500px] lg:h-[600px]`)
- [ ] Ensure all dialog modals are scrollable on small screens
- [ ] Fix table horizontal scroll on narrow viewports (players, audit, backups)
- [ ] Test sidebar Sheet (mobile nav) works correctly on all pages
- [ ] Add touch-friendly targets (minimum 44px tap targets) where needed

### Must-Haves
**Truths:**
- [ ] All admin pages are usable on 375px mobile viewport
- [ ] No horizontal overflow / broken layouts on any page
- [ ] Dialogs are accessible and scrollable on mobile

**Artifacts:**
- [ ] Updated page components with responsive fixes

**Links:**
- [ ] Layout changes consistent with existing Tailwind breakpoint patterns

### Acceptance Criteria
- [ ] Dashboard renders cleanly on iPhone SE (375px)
- [ ] Player inventory grid adapts to single column on mobile
- [ ] Config page groups are usable on tablet
- [ ] All action dialogs fit within mobile viewport
- [ ] No horizontal scrollbar on any page at any breakpoint

### Test Cases
- Visual verification at 375px, 768px, 1280px viewports

---

## Phase 21.8: Fix Issues
{empty — populated during implementation/review}

## Phase 21.9: Documentation
- Update IMPLEMENTATION_PLAN.md status table
- Update CLAUDE.md if new services/patterns added
