-- Accounts can only be created from in game.
--
-- The previous pass had it the other way round: register on the site, then link
-- a character. That allowed an account to exist with no character attached,
-- which is exactly what should not be possible. Now `/account register` in game
-- opens a registration and hands the player a code; the site turns that code
-- into an account. The character is proven first, always.

-- Unusable under the new model: there is no longer any path that gives one of
-- these a character, and an account with no character is the state this change
-- exists to prevent.
DELETE FROM users WHERE username IS NULL;

ALTER TABLE users ALTER COLUMN username SET NOT NULL;

-- Codes now travel game -> site, so the previous direction's table goes.
DROP TABLE IF EXISTS account_link_codes;

-- ---------------------------------------------------------------------------
-- account_registrations — a character waiting for someone to finish signing up.
-- ---------------------------------------------------------------------------
CREATE TABLE account_registrations (
    code        text        PRIMARY KEY,

    -- The character that ran the command. Copied onto the user on completion.
    username    text        NOT NULL,
    steam_id    text,

    created_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL,
    consumed_at timestamptz
);

CREATE INDEX account_registrations_expires_at_idx ON account_registrations (expires_at);

-- One open registration per character: running the command again replaces the
-- previous code rather than leaving two valid ones lying around.
CREATE UNIQUE INDEX account_registrations_open_username_key
    ON account_registrations (lower(username))
    WHERE consumed_at IS NULL;
