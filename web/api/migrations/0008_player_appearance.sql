-- How a survivor's head looks, as KnoxRelay last reported it.
ALTER TABLE player_stats
    ADD COLUMN appearance jsonb;
