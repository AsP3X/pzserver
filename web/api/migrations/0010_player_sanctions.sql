-- Timed suspensions and permanent bans the panel issued.
--
-- Project Zomboid has no temp-ban command. We ban via RCON and remember
-- when to unban. expires_at NULL is a permanent ban; a timestamp is a
-- suspension the expiry loop lifts. Only one open row per name, so a later
-- action replaces the previous rather than stacking.
CREATE TABLE player_sanctions (
    id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username          text        NOT NULL,
    reason            text,
    duration_seconds  integer     CHECK (duration_seconds IS NULL OR duration_seconds > 0),
    starts_at         timestamptz NOT NULL DEFAULT now(),
    expires_at        timestamptz,
    lifted_at         timestamptz,
    lifted_reason     text,
    created_by        uuid        REFERENCES users (id) ON DELETE SET NULL,
    CONSTRAINT player_sanctions_expiry_after_start
        CHECK (expires_at IS NULL OR expires_at > starts_at)
);

CREATE UNIQUE INDEX player_sanctions_one_active
    ON player_sanctions (lower(username))
    WHERE lifted_at IS NULL;

CREATE INDEX player_sanctions_due_idx
    ON player_sanctions (expires_at)
    WHERE lifted_at IS NULL AND expires_at IS NOT NULL;
