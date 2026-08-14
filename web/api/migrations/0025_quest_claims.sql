-- Claimable flows stay hidden until a player picks one up.

CREATE TABLE quest_claims (
    quest_id   uuid        NOT NULL REFERENCES quests (id) ON DELETE CASCADE,
    user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    claimed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (quest_id, user_id)
);

CREATE INDEX quest_claims_user_idx ON quest_claims (user_id, claimed_at DESC);
