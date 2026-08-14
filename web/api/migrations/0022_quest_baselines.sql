-- Per-node kill counters. A "kill 10" step starts when that node unlocks,
-- not from the character's lifetime total.

CREATE TABLE quest_node_baselines (
    quest_id      uuid        NOT NULL REFERENCES quests (id) ON DELETE CASCADE,
    user_id       uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    node_id       text        NOT NULL,
    zombie_kills  integer     NOT NULL DEFAULT 0,
    created_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (quest_id, user_id, node_id)
);
