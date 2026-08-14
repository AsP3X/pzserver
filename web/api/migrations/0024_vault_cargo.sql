-- Packed bags stay one vault slot. Their contents ride along as cargo
-- and raise the retrieve fee.

ALTER TABLE vault_items
    ADD COLUMN cargo jsonb NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN cargo_count integer NOT NULL DEFAULT 0
        CHECK (cargo_count >= 0);

ALTER TABLE vault_moves
    ADD COLUMN cargo jsonb NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN cargo_count integer NOT NULL DEFAULT 0
        CHECK (cargo_count >= 0);

ALTER TABLE vault_items
    DROP CONSTRAINT vault_items_user_id_item_type_condition_bp_key;

CREATE INDEX vault_items_stack_idx
    ON vault_items (user_id, item_type, condition_bp);
