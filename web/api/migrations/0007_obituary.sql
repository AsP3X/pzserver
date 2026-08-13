-- Make game_events safe to import into repeatedly.
--
-- The table has been read since the initial schema — the landing page's death
-- and PvP counters and the leaderboard's deaths column all come out of it —
-- but nothing has ever written to it, so all three have been sitting at zero.
-- The obituary sync is the first writer.
--
-- It reads the mod's deaths.json, which is a rolling window of the most recent
-- 200 deaths with no ids on the entries and no marker for what has already
-- been taken. So the same death is offered again on every pass, and the import
-- has to be idempotent on a natural key rather than on anything the mod says.
--
-- Partial indexes rather than one table-wide constraint: the key that makes a
-- death unique is not the key that makes an arbitrary future event unique, and
-- an append-only log should not be told otherwise.

-- One character cannot die twice in the same second. occurred_at comes off the
-- real clock, not the in-game calendar, so this holds even across a world that
-- is paused or rewound.
CREATE UNIQUE INDEX game_events_one_death_per_character_per_second
    ON game_events (player, occurred_at)
    WHERE event_type = 'death';

-- A kill is identified by all three: one player can kill two others in the
-- same second, and the mod finds both corpses in the same scan and stamps them
-- with the same time.
CREATE UNIQUE INDEX game_events_one_kill_per_pair_per_second
    ON game_events (player, occurred_at, (detail ->> 'victim'))
    WHERE event_type = 'pvp_kill';
