-- Held vault rows: unsold auction returns. They do not occupy a slot and
-- retrieving them is free. Desk notices are the in-game inbox for the same
-- events.

ALTER TABLE vault_items
    ADD COLUMN held boolean NOT NULL DEFAULT false,
    ADD COLUMN origin text;

CREATE INDEX vault_items_held_idx ON vault_items (user_id, held);

CREATE TABLE desk_notices (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    kind            text        NOT NULL,
    title           text        NOT NULL,
    body            text        NOT NULL,
    reference_type  text,
    reference_id    uuid,
    read_at         timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX desk_notices_user_idx ON desk_notices (user_id, created_at DESC);
CREATE INDEX desk_notices_unread_idx ON desk_notices (user_id) WHERE read_at IS NULL;
