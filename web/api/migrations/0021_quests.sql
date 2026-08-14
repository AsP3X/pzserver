-- Staged flows. Staff draw a graph; players walk it. Audience picks who sees it.

CREATE TABLE player_groups (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name       text        NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE player_group_members (
    group_id uuid NOT NULL REFERENCES player_groups (id) ON DELETE CASCADE,
    user_id  uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    PRIMARY KEY (group_id, user_id)
);

CREATE TABLE quests (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    title              text        NOT NULL,
    description        text,
    audience           text        NOT NULL
                                   CHECK (audience IN ('all', 'players', 'group', 'claimable')),
    audience_usernames text[]      NOT NULL DEFAULT '{}',
    audience_group_id  uuid        REFERENCES player_groups (id) ON DELETE SET NULL,
    active             boolean     NOT NULL DEFAULT false,
    graph              jsonb       NOT NULL,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX quests_active_idx ON quests (active, updated_at DESC);

CREATE TABLE quest_node_completions (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    quest_id      uuid        NOT NULL REFERENCES quests (id) ON DELETE CASCADE,
    user_id       uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    node_id       text        NOT NULL,
    period        date        NOT NULL,
    xp_awarded    integer     NOT NULL DEFAULT 0,
    coins_awarded bigint      NOT NULL DEFAULT 0,
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (quest_id, user_id, node_id, period)
);

CREATE INDEX quest_node_completions_user_idx
    ON quest_node_completions (user_id, quest_id);
