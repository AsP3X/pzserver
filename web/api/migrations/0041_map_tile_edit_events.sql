-- Each door / curtain / sheet action is one count, even when they share an
-- 8-square block. Debug overlay is staff-only.

ALTER TABLE map_tile_settings
    ADD COLUMN debug_overlay boolean NOT NULL DEFAULT false;

CREATE TABLE map_tile_edits (
    lua_id      text PRIMARY KEY,
    username    text        NOT NULL DEFAULT '',
    bx          integer     NOT NULL,
    by          integer     NOT NULL,
    kind        text        NOT NULL DEFAULT '',
    created_at  timestamptz NOT NULL DEFAULT now(),
    flushed_at  timestamptz
);

CREATE INDEX map_tile_edits_open_idx
    ON map_tile_edits (created_at)
    WHERE flushed_at IS NULL;
