-- Friend map pins. Sharing is opt-out per character and can be switched off
-- for the whole server. Admins still see everyone on the staff map.

ALTER TABLE users
    ADD COLUMN share_map boolean NOT NULL DEFAULT true;

CREATE TABLE friends_settings (
    id          smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    map_enabled boolean     NOT NULL DEFAULT true,
    updated_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO friends_settings (id) VALUES (1);
