-- Ticket thread. The original report body is the first player message.
-- Staff replies append; they no longer overwrite a single resolution field.

ALTER TABLE player_reports
    ADD COLUMN player_last_read_at timestamptz;

CREATE TABLE player_report_messages (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    report_id       bigint      NOT NULL REFERENCES player_reports (id) ON DELETE CASCADE,
    author_role     text        NOT NULL CHECK (author_role IN ('player', 'staff')),
    staff_id        uuid        REFERENCES users (id) ON DELETE SET NULL,
    author_username text        NOT NULL,
    body            text        NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX player_report_messages_thread_idx
    ON player_report_messages (report_id, created_at);

-- Opening statement.
INSERT INTO player_report_messages (report_id, author_role, author_username, body, created_at)
SELECT
    r.id,
    'player',
    coalesce(a.username, r.author_username, 'player'),
    r.body,
    r.created_at
FROM player_reports r
LEFT JOIN users a ON a.id = r.user_id
WHERE r.body <> '';

-- Last staff note, if any.
INSERT INTO player_report_messages (report_id, author_role, staff_id, author_username, body, created_at)
SELECT
    r.id,
    'staff',
    r.handled_by,
    coalesce(h.username, 'staff'),
    r.resolution,
    coalesce(r.handled_at, r.updated_at)
FROM player_reports r
LEFT JOIN users h ON h.id = r.handled_by
WHERE r.resolution IS NOT NULL AND r.resolution <> '';
