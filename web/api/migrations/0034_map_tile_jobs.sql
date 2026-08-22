-- One tile job at a time is enforced in the API (container name), not here.

CREATE TABLE map_tile_jobs (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    squares         jsonb       NOT NULL DEFAULT '[]'::jsonb,
    cells           jsonb       NOT NULL DEFAULT '[]'::jsonb,
    status          text        NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed')),
    error           text,
    tiles_replaced  integer,
    created_at      timestamptz NOT NULL DEFAULT now(),
    started_at      timestamptz,
    finished_at     timestamptz
);

CREATE INDEX map_tile_jobs_created_idx ON map_tile_jobs (created_at DESC);
