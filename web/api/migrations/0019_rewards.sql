-- Daily drops, tasks and rank-ups. Coins still move only through
-- wallet_transactions; these tables remember what was already collected.

CREATE TABLE reward_claims (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    reward_key  text        NOT NULL,
    claim_date  date        NOT NULL,
    coins       bigint      NOT NULL CHECK (coins >= 0),
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, reward_key, claim_date)
);

CREATE INDEX reward_claims_user_idx ON reward_claims (user_id, created_at DESC);

CREATE TABLE reward_baselines (
    user_id         uuid             NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    day             date             NOT NULL,
    zombie_kills    integer          NOT NULL DEFAULT 0,
    hours_survived  double precision NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day)
);

CREATE TABLE account_ranks (
    user_id        uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    last_paid_rank integer     NOT NULL DEFAULT 1 CHECK (last_paid_rank >= 1),
    updated_at     timestamptz NOT NULL DEFAULT now()
);
