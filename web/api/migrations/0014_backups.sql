-- World backups taken by the control plane, plus the one-row schedule.

CREATE TABLE backups (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    filename      text        NOT NULL,
    path          text        NOT NULL,
    size_bytes    bigint      NOT NULL DEFAULT 0,
    "type"        text        NOT NULL
                              CHECK ("type" IN (
                                  'manual',
                                  'scheduled',
                                  'daily',
                                  'pre_rollback',
                                  'pre_update',
                                  'pre_import'
                              )),
    game_version  text,
    steam_branch  text,
    notes         text,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX backups_created_at_idx ON backups (created_at DESC);
CREATE INDEX backups_type_idx ON backups ("type");

CREATE TABLE backup_settings (
    id                    smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    hourly_enabled        boolean NOT NULL DEFAULT true,
    daily_enabled         boolean NOT NULL DEFAULT true,
    daily_time            time    NOT NULL DEFAULT TIME '04:00',
    retention_manual      integer NOT NULL DEFAULT 10,
    retention_scheduled   integer NOT NULL DEFAULT 24,
    retention_daily       integer NOT NULL DEFAULT 7,
    retention_pre_rollback integer NOT NULL DEFAULT 5,
    retention_pre_update  integer NOT NULL DEFAULT 3,
    retention_pre_import  integer NOT NULL DEFAULT 3
);

INSERT INTO backup_settings (id) VALUES (1);
