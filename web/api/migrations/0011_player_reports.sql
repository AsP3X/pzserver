-- Player reports and support tickets.
--
-- Same shape as the PHP stack: a player files one, staff handle it, the
-- author can read the reply. 'report' names another survivor; 'support' is
-- just a question for the team.
CREATE TABLE player_reports (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    kind        text        NOT NULL DEFAULT 'support'
                            CHECK (kind IN ('report', 'support')),
    subject     text        NOT NULL,
    body        text        NOT NULL,
    -- Free text: the accused may not have a website account.
    accused     text,
    status      text        NOT NULL DEFAULT 'open'
                            CHECK (status IN ('open', 'investigating', 'resolved', 'rejected')),
    resolution  text,
    handled_by  uuid        REFERENCES users (id) ON DELETE SET NULL,
    handled_at  timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX player_reports_queue_idx
    ON player_reports (status, created_at DESC);

CREATE INDEX player_reports_author_idx
    ON player_reports (user_id, created_at DESC);
