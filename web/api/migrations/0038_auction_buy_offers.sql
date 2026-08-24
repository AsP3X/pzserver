-- Buy offers: a player (or staff) posts a price for an item they want.
-- Coins leave a player wallet immediately. Staff offers are house-funded
-- and mint the payout when someone fills them.

CREATE TABLE auction_buy_offers (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    buyer_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    filler_id   uuid        REFERENCES users (id) ON DELETE SET NULL,
    item_type   text        NOT NULL,
    item_name   text        NOT NULL,
    quantity    integer     NOT NULL CHECK (quantity >= 1 AND quantity <= 100),
    price       bigint      NOT NULL CHECK (price >= 1),
    staff       boolean     NOT NULL DEFAULT false,
    status      text        NOT NULL
                            CHECK (status IN ('live', 'collecting', 'filled', 'cancelled', 'expired', 'failed')),
    ends_at     timestamptz NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    settled_at  timestamptz
);

CREATE INDEX auction_buy_offers_live_idx ON auction_buy_offers (status, ends_at);
CREATE INDEX auction_buy_offers_buyer_idx ON auction_buy_offers (buyer_id, created_at DESC);
CREATE INDEX auction_buy_offers_filler_idx ON auction_buy_offers (filler_id, created_at DESC)
    WHERE filler_id IS NOT NULL;
