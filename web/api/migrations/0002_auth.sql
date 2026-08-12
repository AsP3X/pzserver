-- Accounts and sessions.
--
-- Role values deliberately match the PHP stack's UserRole enum
-- (super_admin/admin/moderator/player) so porting the existing users later is a
-- straight copy rather than a mapping exercise.

CREATE TABLE users (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Stored as typed. PZ usernames are case-sensitive on the game side, so the
    -- display value has to survive intact; the unique index below is what stops
    -- two accounts differing only by case.
    username      text        NOT NULL,
    email         text        NOT NULL,
    password_hash text        NOT NULL,

    role          text        NOT NULL DEFAULT 'player'
                              CHECK (role IN ('super_admin', 'admin', 'moderator', 'player')),
    steam_id      text,

    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),

    -- Same character class the PHP stack's route patterns enforce.
    CONSTRAINT users_username_format CHECK (username ~ '^[a-zA-Z0-9_]{1,50}$'),
    CONSTRAINT users_email_shape CHECK (position('@' IN email) > 1)
);

-- Case-insensitive uniqueness, case-preserving storage.
CREATE UNIQUE INDEX users_username_lower_key ON users (lower(username));
CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));
CREATE UNIQUE INDEX users_steam_id_key ON users (steam_id) WHERE steam_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- sessions — server-side, so they can be revoked one by one.
-- ---------------------------------------------------------------------------
CREATE TABLE sessions (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,

    -- A SHA-256 of the cookie value, never the value itself: a leaked database
    -- dump must not hand anyone a working session. The token carries full
    -- entropy, so a plain digest is enough — no password KDF needed.
    token_hash   text        NOT NULL,

    expires_at   timestamptz NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    user_agent   text
);

CREATE UNIQUE INDEX sessions_token_hash_key ON sessions (token_hash);
CREATE INDEX sessions_user_id_idx ON sessions (user_id);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);
