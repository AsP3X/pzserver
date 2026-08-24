ALTER TABLE map_tile_jobs
    ADD COLUMN progress_stage text,
    ADD COLUMN progress_pct integer;
