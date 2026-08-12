-- Development seed: plausible data for building UI against.
--
-- NOT a migration and never loaded automatically. Run it with `make web-seed`
-- against a development database only — it truncates the tables it fills.
--
-- Real data arrives from the KnoxRelay export via the API's sync task; this
-- exists so the site has something to render while the game server is down.

BEGIN;

TRUNCATE player_stats, game_events, server_status_samples RESTART IDENTITY;

-- vitals mirrors what KR_Progress exports: overall health, bleeding parts, the
-- zombie infection flag and the common cold. Values here are spread across the
-- healthy/hurt/critical bands so the character page's meter can be seen in each.
INSERT INTO player_stats (username, zombie_kills, hours_survived, profession, skills, traits, vitals, is_dead) VALUES
    ('rook',        2847, 412.5, 'Police Officer', '{"Aiming": 7, "Reloading": 6, "Sprinting": 4}', '[{"id":"Brave","label":"Brave"}]', '{"health": 92.4, "bleeding_parts": 0, "infected": false, "has_cold": false}', false),
    ('vesper',       931, 508.0, 'Nurse',          '{"Doctor": 8, "Cooking": 5}',                   '[{"id":"Fast Healer","label":"Fast Healer"}]', '{"health": 100.0, "bleeding_parts": 0, "infected": false, "has_cold": false}', false),
    ('marlowe',     1994, 288.5, 'Burglar',        '{"Lightfooted": 7, "Nimble": 6}',               '[]', '{"health": 54.0, "bleeding_parts": 2, "infected": false, "has_cold": true}', false),
    ('pike',         612, 190.0, 'Fisherman',      '{"Fishing": 6, "Foraging": 5}',                 '[]', '{"health": 88.0, "bleeding_parts": 0, "infected": false, "has_cold": true}', false),
    ('sable',       3310, 355.5, 'Veteran',        '{"Aiming": 9, "Maintenance": 5}',               '[{"id":"Desensitized","label":"Desensitized"}]', '{"health": 71.5, "bleeding_parts": 1, "infected": false, "has_cold": false}', false),
    ('halden',       458, 121.0, 'Chef',           '{"Cooking": 7}',                                '[]', '{"health": 0.0, "bleeding_parts": 4, "infected": true, "has_cold": false}', true),
    ('mercer',      1205, 244.5, 'Carpenter',      '{"Carpentry": 8, "Strength": 6}',               '[]', '{"health": 96.0, "bleeding_parts": 0, "infected": false, "has_cold": false}', false),
    ('quinn',        789, 167.5, 'Park Ranger',    '{"Foraging": 8, "Trapping": 6}',                '[]', '{"health": 22.5, "bleeding_parts": 3, "infected": true, "has_cold": false}', false),
    ('brandt',      2103, 301.0, 'Mechanic',       '{"Mechanics": 8, "Electrical": 4}',             '[]', '{"health": 83.0, "bleeding_parts": 0, "infected": false, "has_cold": false}', false),
    ('odette',       344,  88.5, 'Student',        '{"Sprinting": 3}',                              '[]', '{"health": 0.0, "bleeding_parts": 2, "infected": false, "has_cold": false}', true),
    ('cutter',      1567, 276.0, 'Construction Worker', '{"Strength": 8, "Fitness": 6}',            '[]', '{"health": 100.0, "bleeding_parts": 0, "infected": false, "has_cold": false}', false),
    ('ferris',       902, 203.5, 'Doctor',         '{"Doctor": 9, "First Aid": 7}',                 '[]', '{"health": 64.0, "bleeding_parts": 1, "infected": false, "has_cold": false}', false);

-- Deaths and PvP, spread across the last three weeks.
INSERT INTO game_events (event_type, player, detail, x, y, z, occurred_at)
SELECT
    CASE WHEN random() < 0.82 THEN 'death' ELSE 'pvp_kill' END,
    (ARRAY['rook','vesper','marlowe','pike','sable','halden','mercer','quinn','brandt','odette','cutter','ferris'])[1 + floor(random() * 12)::int],
    '{"cause": "zombie"}'::jsonb,
    10200 + random() * 800,
    9500 + random() * 800,
    0,
    now() - make_interval(mins => floor(random() * 60 * 24 * 21)::int)
FROM generate_series(1, 64);

-- 24h of population samples on a five-minute cadence, following a rough
-- evening-peak curve so the activity graph has a believable shape.
INSERT INTO server_status_samples (online, player_count, sampled_at)
SELECT
    true,
    greatest(0, round(5 + 4 * sin((minutes_ago / 60.0) * pi() / 6) + random() * 2))::int,
    now() - make_interval(mins => minutes_ago)
FROM generate_series(0, 24 * 60, 5) AS minutes_ago;

COMMIT;
