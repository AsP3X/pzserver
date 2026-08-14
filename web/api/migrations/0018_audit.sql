-- Staff action ledger. Mutating /admin requests write a row after they finish.

CREATE TABLE audit_logs (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id    uuid        REFERENCES users (id) ON DELETE SET NULL,
    actor       text        NOT NULL,
    action      text        NOT NULL,
    method      text        NOT NULL,
    path        text        NOT NULL,
    target      text,
    status      integer     NOT NULL,
    details     jsonb       NOT NULL DEFAULT '{}'::jsonb,
    ip_address  text,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_logs_created_idx ON audit_logs (created_at DESC);
CREATE INDEX audit_logs_actor_idx ON audit_logs (actor);
CREATE INDEX audit_logs_action_idx ON audit_logs (action);
CREATE INDEX audit_logs_target_idx ON audit_logs (target);
