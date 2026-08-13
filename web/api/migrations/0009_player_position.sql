-- Last tile the live roster reported for this character.
--
-- players_live.json is everyone online right now. When the file is empty,
-- mid-write, or the player just logged out, the map still needs the last
-- square we saw them on. Stats never carried coordinates; this is that
-- memory.
ALTER TABLE player_stats
    ADD COLUMN x double precision,
    ADD COLUMN y double precision,
    ADD COLUMN z integer;
