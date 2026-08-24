-- Auto-rerender of small world edits (doors, window sheets, a few tiles).
-- Staff can turn it off. Dirty 8-square blocks accumulate until a batch
-- size or a max wait, then one regional job paints them.

CREATE TABLE map_tile_settings (
    id              integer PRIMARY KEY CHECK (id = 1),
    auto_rerender   boolean     NOT NULL DEFAULT true,
    batch_blocks    integer     NOT NULL DEFAULT 8
                                CHECK (batch_blocks >= 1 AND batch_blocks <= 256),
    max_wait_secs   integer     NOT NULL DEFAULT 300
                                CHECK (max_wait_secs >= 0 AND max_wait_secs <= 86400),
    pending_since   timestamptz
);

INSERT INTO map_tile_settings (id) VALUES (1);

CREATE TABLE map_tile_blocks (
    bx        integer NOT NULL,
    by        integer NOT NULL,
    mtime_ms  bigint  NOT NULL,
    PRIMARY KEY (bx, by)
);
