-- Account XP and staff-authored objectives. Rank is derived from XP;
-- completing an objective is what awards it.

CREATE TABLE account_progress (
    user_id    uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    xp         bigint      NOT NULL DEFAULT 0 CHECK (xp >= 0),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE objectives (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    title       text        NOT NULL,
    description text,
    kind        text        NOT NULL
                            CHECK (kind IN ('play', 'kills', 'hours', 'spend', 'trade', 'manual')),
    goal        integer     NOT NULL CHECK (goal >= 1 AND goal <= 100000),
    xp          integer     NOT NULL CHECK (xp >= 0 AND xp <= 100000),
    coins       bigint      NOT NULL DEFAULT 0 CHECK (coins >= 0 AND coins <= 100000),
    cadence     text        NOT NULL
                            CHECK (cadence IN ('daily', 'once')),
    active      boolean     NOT NULL DEFAULT true,
    sort_order  integer     NOT NULL DEFAULT 0,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX objectives_active_idx ON objectives (active, sort_order, title);

CREATE TABLE objective_completions (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    objective_id  uuid        NOT NULL REFERENCES objectives (id) ON DELETE CASCADE,
    user_id       uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    period        date        NOT NULL,
    xp_awarded    integer     NOT NULL,
    coins_awarded bigint      NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (objective_id, user_id, period)
);

CREATE INDEX objective_completions_user_idx
    ON objective_completions (user_id, created_at DESC);
