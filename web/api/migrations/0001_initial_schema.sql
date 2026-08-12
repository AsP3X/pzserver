-- Initial schema for the Rust control plane.
--
-- This is a fresh, Rust-owned schema — it is not a copy of the Laravel one.
-- Only what the public site needs today is here; admin tables land with the
-- passes that use them.
--
-- Timestamps are timestamptz throughout. The game's own clock (which reads
-- 1993 and stops when the world pauses) never enters this database.

-- ---------------------------------------------------------------------------
-- site_settings — singleton row driving the public site's copy and branding.
-- ---------------------------------------------------------------------------
CREATE TABLE site_settings (
    id               integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),

    site_name        text        NOT NULL DEFAULT 'Knox County',
    hero_badge       text        NOT NULL DEFAULT '',
    hero_title       text        NOT NULL DEFAULT '',
    hero_subtitle    text        NOT NULL DEFAULT '',
    hero_description text        NOT NULL DEFAULT '',
    hero_cta_label   text        NOT NULL DEFAULT '',
    footer_text      text        NOT NULL DEFAULT '',

    -- [{ "icon": "...", "title": "...", "description": "..." }]
    features         jsonb       NOT NULL DEFAULT '[]'::jsonb,

    -- What players type into the game client. Null host means "not published
    -- yet" and the UI hides the connect panel rather than showing a blank.
    connect_host     text,
    connect_port     integer     NOT NULL DEFAULT 16261,
    discord_url      text,

    default_locale   text        NOT NULL DEFAULT 'en',
    updated_at       timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT site_settings_features_is_array CHECK (jsonb_typeof(features) = 'array'),
    CONSTRAINT site_settings_locale_supported CHECK (default_locale IN ('en', 'ka'))
);

-- ---------------------------------------------------------------------------
-- player_stats — one row per character, folded in from the mod's export.
-- ---------------------------------------------------------------------------
CREATE TABLE player_stats (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    username        text        NOT NULL,
    zombie_kills    integer     NOT NULL DEFAULT 0 CHECK (zombie_kills >= 0),
    hours_survived  real        NOT NULL DEFAULT 0 CHECK (hours_survived >= 0),
    profession      text,

    -- Perk name -> level. Untrained perks are omitted by the mod.
    skills          jsonb       NOT NULL DEFAULT '{}'::jsonb,
    -- Absent on KnoxRelay builds older than 1.3, hence nullable rather than '[]'.
    traits          jsonb,
    vitals          jsonb,

    is_dead         boolean     NOT NULL DEFAULT false,

    first_seen_at   timestamptz NOT NULL DEFAULT now(),
    last_synced_at  timestamptz NOT NULL DEFAULT now()
);

-- PZ usernames are case-sensitive on the game side, so this is a plain unique.
CREATE UNIQUE INDEX player_stats_username_key ON player_stats (username);

-- Leaderboards sort by one stat and take the top N.
CREATE INDEX player_stats_zombie_kills_idx ON player_stats (zombie_kills DESC);
CREATE INDEX player_stats_hours_survived_idx ON player_stats (hours_survived DESC);

-- ---------------------------------------------------------------------------
-- game_events — append-only log of notable world events (deaths, PvP, …).
-- ---------------------------------------------------------------------------
CREATE TABLE game_events (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    event_type  text        NOT NULL,
    player      text,
    detail      jsonb       NOT NULL DEFAULT '{}'::jsonb,

    x           real,
    y           real,
    z           integer,

    occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX game_events_type_occurred_idx ON game_events (event_type, occurred_at DESC);
CREATE INDEX game_events_player_idx ON game_events (player) WHERE player IS NOT NULL;

-- ---------------------------------------------------------------------------
-- server_status_samples — population history, written by the status poller.
-- ---------------------------------------------------------------------------
CREATE TABLE server_status_samples (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    online       boolean     NOT NULL,
    player_count integer     NOT NULL DEFAULT 0 CHECK (player_count >= 0),
    sampled_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX server_status_samples_sampled_at_idx ON server_status_samples (sampled_at DESC);

-- ---------------------------------------------------------------------------
-- Seed the singleton so the site renders before anyone opens the admin UI.
-- ---------------------------------------------------------------------------
INSERT INTO site_settings (
    id, site_name, hero_badge, hero_title, hero_subtitle, hero_description,
    hero_cta_label, footer_text, features
) VALUES (
    1,
    'Knox County',
    'Georgian Gaming Community',
    'Survive Knox County',
    'Project Zomboid Dedicated Server',
    'A managed server with automated backups, curated mods and an admin team that actually shows up. Bring a spare bag.',
    'Join the server',
    'Knox County — a Georgian Project Zomboid community.',
    '[
      {"icon": "clock",   "title": "Always up",        "description": "Automated restarts and scheduled backups. Your character is still there tomorrow."},
      {"icon": "package", "title": "Curated mods",     "description": "A hand-picked mod list kept in sync with the Workshop, never broken by a surprise update."},
      {"icon": "shield",  "title": "Moderated",        "description": "Reports get read. Griefers get removed. Safe zones are enforced, not suggested."},
      {"icon": "map",     "title": "Live map",         "description": "See who is out there, where the last deaths happened, and which routes are worth avoiding."}
    ]'::jsonb
);
