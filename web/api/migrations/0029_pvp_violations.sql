-- Safe-zone PvP incidents imported from safezone_violations.json.

CREATE TABLE pvp_violations (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    attacker       text        NOT NULL,
    victim         text        NOT NULL,
    zone_id        text        NOT NULL,
    zone_name      text        NOT NULL,
    attacker_x     integer,
    attacker_y     integer,
    strike_number  integer     NOT NULL,
    status         text        NOT NULL DEFAULT 'pending',
    resolution_note text,
    resolved_by    text,
    occurred_at    timestamptz NOT NULL,
    resolved_at    timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pvp_violations_status_chk
        CHECK (status IN ('pending', 'dismissed', 'actioned'))
);

CREATE UNIQUE INDEX pvp_violations_fingerprint
    ON pvp_violations (attacker, victim, zone_id, occurred_at, strike_number);

CREATE INDEX pvp_violations_status_idx ON pvp_violations (status);
CREATE INDEX pvp_violations_occurred_idx ON pvp_violations (occurred_at DESC);
