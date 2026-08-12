-- Usernames come from the game, not from the registration form.
--
-- Registering on the site now takes an email and a password. The PZ name is
-- stamped on later, when the player runs /account register in game with a code
-- issued here. Until that happens the account simply has no username.

ALTER TABLE users ALTER COLUMN username DROP NOT NULL;

-- The existing format check still holds for real names: a CHECK is satisfied
-- when its expression is NULL, and lower(NULL) is NULL, which a unique index
-- allows any number of. So neither constraint needs touching.

-- ---------------------------------------------------------------------------
-- account_link_codes — short-lived one-time codes claimed from in game.
-- ---------------------------------------------------------------------------
CREATE TABLE account_link_codes (
    code             text        PRIMARY KEY,
    user_id          uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,

    created_at       timestamptz NOT NULL DEFAULT now(),
    expires_at       timestamptz NOT NULL,

    -- Set when a claim succeeds. A code is single-use: claimed_at is what makes
    -- replaying the same code from chat a no-op.
    claimed_at       timestamptz,
    claimed_username text
);

CREATE INDEX account_link_codes_user_id_idx ON account_link_codes (user_id);
CREATE INDEX account_link_codes_expires_at_idx ON account_link_codes (expires_at);
