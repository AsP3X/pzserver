-- Turning in-game cash into wallet coins, through the KR_Vault queue.
--
-- Items-first, like every other economy move here: the mod strips the cash and
-- writes a result, and only then is the wallet credited. wallet_transaction_id
-- starts NULL and is set when that credit lands, so a row with a success
-- status and no transaction is a deposit that still owes the player coins.

CREATE TABLE money_deposits (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id               uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    -- Denormalised so an admin can still read the queue after an account goes.
    username              text        NOT NULL,
    -- The id handed to the mod. Unique so a replayed result cannot pay twice.
    lua_id                text        NOT NULL UNIQUE,
    status                text        NOT NULL DEFAULT 'pending',
    note_count            integer     NOT NULL DEFAULT 0 CHECK (note_count >= 0),
    bundle_count          integer     NOT NULL DEFAULT 0 CHECK (bundle_count >= 0),
    coins                 bigint      NOT NULL DEFAULT 0 CHECK (coins >= 0),
    -- Rates at the moment of the request, so a later rate change cannot make
    -- an old row look mispriced.
    note_value            bigint      NOT NULL DEFAULT 1 CHECK (note_value >= 0),
    bundle_value          bigint      NOT NULL DEFAULT 100 CHECK (bundle_value >= 0),
    detail                text,
    wallet_transaction_id uuid REFERENCES wallet_transactions (id),
    attempts              integer     NOT NULL DEFAULT 1 CHECK (attempts >= 1),
    created_at            timestamptz NOT NULL DEFAULT now(),
    finished_at           timestamptz,
    CONSTRAINT money_deposits_status_chk
        CHECK (status IN ('pending', 'credited', 'failed', 'cancelled')),
    -- A credited deposit must say where the coins went.
    CONSTRAINT money_deposits_credited_has_transaction
        CHECK (status <> 'credited' OR wallet_transaction_id IS NOT NULL)
);

-- The poller reads only pending rows, oldest first.
CREATE INDEX money_deposits_pending_idx
    ON money_deposits (created_at)
    WHERE status = 'pending';

CREATE INDEX money_deposits_user_idx
    ON money_deposits (user_id, created_at DESC);
