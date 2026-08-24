-- Buy offers take a wanted count. Many people can fill parts of it until that
-- count is gone. Staff may post unlimited quantity and no end date.
-- `price` becomes the unit price (was the total on 0038).

UPDATE auction_buy_offers
SET price = GREATEST(1, price / GREATEST(quantity, 1));

ALTER TABLE auction_buy_offers
    ADD COLUMN remaining integer;

UPDATE auction_buy_offers
SET remaining = CASE
    WHEN status IN ('live', 'collecting') THEN quantity
    ELSE 0
END;

ALTER TABLE auction_buy_offers
    ALTER COLUMN quantity DROP NOT NULL,
    ALTER COLUMN remaining DROP NOT NULL,
    ALTER COLUMN ends_at DROP NOT NULL;

ALTER TABLE auction_buy_offers
    DROP CONSTRAINT IF EXISTS auction_buy_offers_quantity_check;

ALTER TABLE auction_buy_offers
    ADD CONSTRAINT auction_buy_offers_quantity_check CHECK (
        (quantity IS NULL AND remaining IS NULL AND staff)
        OR (
            quantity IS NOT NULL
            AND remaining IS NOT NULL
            AND quantity >= 1
            AND quantity <= 10000
            AND remaining >= 0
            AND remaining <= quantity
        )
    );

CREATE TABLE auction_buy_offer_fills (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    offer_id    uuid        NOT NULL REFERENCES auction_buy_offers (id) ON DELETE CASCADE,
    filler_id   uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    quantity    integer     NOT NULL CHECK (quantity >= 1),
    status      text        NOT NULL
                            CHECK (status IN ('collecting', 'done', 'failed')),
    created_at  timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz
);

CREATE INDEX auction_buy_offer_fills_offer_idx
    ON auction_buy_offer_fills (offer_id, created_at DESC);
CREATE INDEX auction_buy_offer_fills_open_idx
    ON auction_buy_offer_fills (filler_id)
    WHERE status = 'collecting';
