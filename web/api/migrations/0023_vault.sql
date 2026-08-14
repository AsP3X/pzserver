-- Player item vault. Storing is free. Retrieving costs coins. Capacity is bought.

CREATE TABLE vault_settings (
    id                     smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    enabled                boolean     NOT NULL DEFAULT true,
    default_slots          integer     NOT NULL DEFAULT 20
                                       CHECK (default_slots >= 1 AND default_slots <= 2000),
    max_slots              integer     NOT NULL DEFAULT 200
                                       CHECK (max_slots >= 1 AND max_slots <= 2000),
    slot_upgrade_increment integer     NOT NULL DEFAULT 10
                                       CHECK (slot_upgrade_increment >= 1 AND slot_upgrade_increment <= 200),
    slot_upgrade_cost      bigint      NOT NULL DEFAULT 100 CHECK (slot_upgrade_cost >= 1),
    withdraw_fee_flat      bigint      NOT NULL DEFAULT 5 CHECK (withdraw_fee_flat >= 0),
    withdraw_fee_per_item  bigint      NOT NULL DEFAULT 1 CHECK (withdraw_fee_per_item >= 0),
    updated_at             timestamptz NOT NULL DEFAULT now(),
    CHECK (max_slots >= default_slots)
);

INSERT INTO vault_settings (id) VALUES (1);

CREATE TABLE vaults (
    user_id       uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    slot_capacity integer     NOT NULL CHECK (slot_capacity >= 1 AND slot_capacity <= 2000),
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vault_items (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid        NOT NULL REFERENCES vaults (user_id) ON DELETE CASCADE,
    item_type    text        NOT NULL,
    item_name    text        NOT NULL,
    category     text        NOT NULL DEFAULT 'General',
    condition_bp smallint    NOT NULL DEFAULT 100
                             CHECK (condition_bp >= 0 AND condition_bp <= 100),
    quantity     integer     NOT NULL CHECK (quantity >= 1),
    UNIQUE (user_id, item_type, condition_bp)
);

CREATE INDEX vault_items_user_idx ON vault_items (user_id, item_name);

CREATE TABLE vault_moves (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id               uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    direction             text        NOT NULL CHECK (direction IN ('store', 'retrieve')),
    status                text        NOT NULL
                                      CHECK (status IN ('pending', 'done', 'failed', 'partial')),
    item_type             text        NOT NULL,
    item_name             text        NOT NULL,
    category              text        NOT NULL DEFAULT 'General',
    condition_bp          smallint    NOT NULL DEFAULT 100
                                      CHECK (condition_bp >= 0 AND condition_bp <= 100),
    requested             integer     NOT NULL CHECK (requested >= 1),
    actual                integer     NOT NULL DEFAULT 0 CHECK (actual >= 0),
    fee                   bigint      NOT NULL DEFAULT 0 CHECK (fee >= 0),
    wallet_transaction_id uuid        REFERENCES wallet_transactions (id) ON DELETE SET NULL,
    created_at            timestamptz NOT NULL DEFAULT now(),
    finished_at           timestamptz
);

CREATE INDEX vault_moves_user_idx ON vault_moves (user_id, created_at DESC);
CREATE INDEX vault_moves_open_idx ON vault_moves (status) WHERE status = 'pending';
