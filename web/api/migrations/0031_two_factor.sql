-- Opt-in TOTP, plus the two things it needs around it: one-time recovery
-- codes, and a short-lived challenge for the gap between a correct password
-- and a correct code.
--
-- The shared secret is stored as it is used. Unlike a session token or a
-- recovery code it cannot be hashed — verifying a TOTP means recomputing it,
-- which needs the original. It is therefore the one credential here that a
-- database dump hands over intact. That is accepted because Postgres is on the
-- internal network and never published; if that ever changes, this column is
-- what has to be encrypted at rest first.

ALTER TABLE users
    ADD COLUMN two_factor_secret text,
    -- Null while enrolling. Set when the user proves they can read a code off
    -- their app, which is the point 2FA actually starts being enforced: an
    -- enrolment abandoned halfway must not lock anybody out.
    ADD COLUMN two_factor_confirmed_at timestamptz;

-- One-time codes for a lost phone. High-entropy and single-use, so SHA-256 is
-- enough — the same reasoning that lets sessions store a digest rather than
-- an Argon2 hash.
CREATE TABLE two_factor_recovery_codes (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    code_hash  text        NOT NULL,
    used_at    timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, code_hash)
);

CREATE INDEX two_factor_recovery_unused_idx
    ON two_factor_recovery_codes (user_id)
    WHERE used_at IS NULL;

-- The half-authenticated state. Issued once the password checks out and
-- exchanged for a real session by a correct code, so a password alone never
-- produces anything that can read the API.
CREATE TABLE two_factor_challenges (
    token_hash text PRIMARY KEY,
    user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    -- Counted here rather than in memory so restarting the API cannot reset
    -- an attacker's budget for guessing a six-digit code.
    attempts   integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX two_factor_challenges_expiry_idx ON two_factor_challenges (expires_at);
