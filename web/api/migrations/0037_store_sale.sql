ALTER TABLE store_items
    ADD COLUMN on_sale boolean NOT NULL DEFAULT false,
    ADD COLUMN discount_percent integer NOT NULL DEFAULT 0
        CHECK (discount_percent >= 0 AND discount_percent <= 99);
