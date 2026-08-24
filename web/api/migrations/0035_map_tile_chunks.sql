-- Last mtime we have painted for each map cell. Empty on first boot: the
-- scanner seeds it without enqueueing, so a restart does not redraw the
-- whole visited world.

CREATE TABLE map_tile_chunks (
    cx        integer NOT NULL,
    cy        integer NOT NULL,
    mtime_ms  bigint  NOT NULL,
    PRIMARY KEY (cx, cy)
);
