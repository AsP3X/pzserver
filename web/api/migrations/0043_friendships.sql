-- Friendships between website accounts (each bound to a PZ character).
--
-- One row per unordered pair. Pending/accepted/declined/blocked share the
-- table so a block always wins over a new request. Position sharing is
-- per-edge and opt-out after accept: last-known squares are sensitive on a
-- PvP server, but friends expect to find each other unless they hide.

CREATE TABLE friendships (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Ordered so (A,B) and (B,A) cannot both exist. Postgres uuid comparison
    -- is byte-wise; the check just has to be a total order.
    user_low             uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    user_high            uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,

    requested_by         uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    blocked_by           uuid        REFERENCES users (id) ON DELETE CASCADE,

    status               text        NOT NULL DEFAULT 'pending'
                                     CHECK (status IN ('pending', 'accepted', 'declined', 'blocked')),

    share_position_low   boolean     NOT NULL DEFAULT true,
    share_position_high  boolean     NOT NULL DEFAULT true,

    created_at           timestamptz NOT NULL DEFAULT now(),
    responded_at         timestamptz,

    CONSTRAINT friendships_ordered CHECK (user_low < user_high),
    CONSTRAINT friendships_not_self CHECK (user_low <> user_high),
    CONSTRAINT friendships_requester_in_pair CHECK (
        requested_by = user_low OR requested_by = user_high
    ),
    CONSTRAINT friendships_blocked_by CHECK (
        (status = 'blocked' AND blocked_by IS NOT NULL
            AND (blocked_by = user_low OR blocked_by = user_high))
        OR (status <> 'blocked' AND blocked_by IS NULL)
    )
);

CREATE UNIQUE INDEX friendships_pair_key ON friendships (user_low, user_high);

CREATE INDEX friendships_pending_idx
    ON friendships (requested_by, created_at DESC)
    WHERE status = 'pending';
