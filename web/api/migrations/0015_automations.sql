-- Named jobs that fire server actions on a clock.

CREATE TABLE automations (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name          text        NOT NULL,
    enabled       boolean     NOT NULL DEFAULT true,
    action        text        NOT NULL
                              CHECK (action IN (
                                  'restart',
                                  'start',
                                  'stop',
                                  'save',
                                  'backup',
                                  'broadcast',
                                  'rcon'
                              )),
    message       text,
    warn_seconds  integer     NOT NULL DEFAULT 0
                              CHECK (warn_seconds >= 0 AND warn_seconds <= 3600),
    warn_message  text,
    schedule_kind text        NOT NULL
                              CHECK (schedule_kind IN ('times', 'every')),
    times         text[]      NOT NULL DEFAULT '{}',
    every_minutes integer     CHECK (every_minutes IS NULL OR (every_minutes >= 5 AND every_minutes <= 10080)),
    last_run_at   timestamptz,
    last_status   text,
    last_error    text,
    last_slot     text,
    pending_at    timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX automations_enabled_idx ON automations (enabled);

CREATE TABLE automation_runs (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    automation_id  uuid        NOT NULL REFERENCES automations (id) ON DELETE CASCADE,
    started_at     timestamptz NOT NULL DEFAULT now(),
    finished_at    timestamptz,
    status         text        NOT NULL
                               CHECK (status IN ('ok', 'error', 'warned')),
    detail         text
);

CREATE INDEX automation_runs_automation_idx ON automation_runs (automation_id, started_at DESC);
