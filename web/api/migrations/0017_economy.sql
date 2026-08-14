-- Wallet ledger, admin store, player auction house, and item-order tracking.
--
-- Money sources are free text so daily rewards, quests and levels can credit
-- the same wallet without another migration. Amounts are whole coins.

CREATE TABLE wallets (
    user_id      uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    balance      bigint      NOT NULL DEFAULT 0 CHECK (balance >= 0),
    total_earned bigint      NOT NULL DEFAULT 0 CHECK (total_earned >= 0),
    total_spent  bigint      NOT NULL DEFAULT 0 CHECK (total_spent >= 0),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE wallet_transactions (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    kind          text        NOT NULL CHECK (kind IN ('credit', 'debit')),
    amount        bigint      NOT NULL CHECK (amount > 0),
    balance_after bigint      NOT NULL CHECK (balance_after >= 0),
    source        text        NOT NULL,
    reference_type text,
    reference_id  uuid,
    description   text,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX wallet_transactions_user_idx
    ON wallet_transactions (user_id, created_at DESC);

CREATE TABLE store_items (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name            text        NOT NULL,
    item_type       text        NOT NULL,
    description     text,
    category        text        NOT NULL DEFAULT 'other',
    quantity        integer     NOT NULL DEFAULT 1
                                CHECK (quantity >= 1 AND quantity <= 100),
    price           bigint      NOT NULL CHECK (price >= 0),
    stock           integer     CHECK (stock IS NULL OR stock >= 0),
    max_per_player  integer     CHECK (max_per_player IS NULL OR max_per_player >= 1),
    featured        boolean     NOT NULL DEFAULT false,
    active          boolean     NOT NULL DEFAULT true,
    sort_order      integer     NOT NULL DEFAULT 0,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX store_items_active_idx ON store_items (active, sort_order, name);

CREATE TABLE store_purchases (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id               uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    item_id               uuid        REFERENCES store_items (id) ON DELETE SET NULL,
    item_type             text        NOT NULL,
    item_name             text        NOT NULL,
    quantity              integer     NOT NULL CHECK (quantity >= 1),
    unit_price            bigint      NOT NULL,
    total_price           bigint      NOT NULL CHECK (total_price >= 0),
    status                text        NOT NULL
                                      CHECK (status IN ('pending', 'queued', 'delivered', 'failed', 'refunded')),
    wallet_transaction_id uuid        REFERENCES wallet_transactions (id) ON DELETE SET NULL,
    created_at            timestamptz NOT NULL DEFAULT now(),
    finished_at           timestamptz
);

CREATE INDEX store_purchases_user_idx ON store_purchases (user_id, created_at DESC);
CREATE INDEX store_purchases_open_idx ON store_purchases (status) WHERE status IN ('pending', 'queued');

CREATE TABLE auction_listings (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    seller_id         uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    item_type         text        NOT NULL,
    item_name         text        NOT NULL,
    quantity          integer     NOT NULL CHECK (quantity >= 1 AND quantity <= 100),
    condition         real,
    start_price       bigint      NOT NULL CHECK (start_price >= 1),
    buyout_price      bigint      CHECK (buyout_price IS NULL OR buyout_price >= start_price),
    current_price     bigint      NOT NULL,
    current_bidder_id uuid        REFERENCES users (id) ON DELETE SET NULL,
    status            text        NOT NULL
                                  CHECK (status IN ('collecting', 'live', 'sold', 'cancelled', 'expired', 'failed')),
    ends_at           timestamptz NOT NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    settled_at        timestamptz
);

CREATE INDEX auction_listings_live_idx ON auction_listings (status, ends_at);
CREATE INDEX auction_listings_seller_idx ON auction_listings (seller_id, created_at DESC);

CREATE TABLE auction_bids (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    listing_id  uuid        NOT NULL REFERENCES auction_listings (id) ON DELETE CASCADE,
    bidder_id   uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    amount      bigint      NOT NULL CHECK (amount >= 1),
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX auction_bids_listing_idx ON auction_bids (listing_id, created_at DESC);

CREATE TABLE item_orders (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    lua_id         text        NOT NULL UNIQUE,
    kind           text        NOT NULL,
    reference_type text        NOT NULL,
    reference_id   uuid        NOT NULL,
    username       text        NOT NULL,
    item_type      text        NOT NULL,
    count          integer     NOT NULL CHECK (count >= 1),
    condition      real,
    action         text        NOT NULL,
    status         text        NOT NULL CHECK (status IN ('pending', 'done', 'failed')),
    attempts       integer     NOT NULL DEFAULT 0,
    detail         text,
    created_at     timestamptz NOT NULL DEFAULT now(),
    finished_at    timestamptz
);

CREATE INDEX item_orders_pending_idx ON item_orders (status, created_at) WHERE status = 'pending';
CREATE INDEX item_orders_reference_idx ON item_orders (reference_type, reference_id);
