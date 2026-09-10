-- Durable, instance-scoped startup output. Deliberately has no foreign key to models/instances:
-- failed move replacements and deleted instances must retain their startup history.
CREATE TABLE IF NOT EXISTS startup_log_sessions (
    instance_id      text PRIMARY KEY,
    model_name       text NOT NULL,
    worker_id        text NOT NULL,
    outcome          text NOT NULL DEFAULT 'IN_PROGRESS'
                     CHECK (outcome IN ('IN_PROGRESS', 'SUCCEEDED', 'FAILED', 'UNKNOWN')),
    capture_complete boolean NOT NULL DEFAULT false,
    error_message    text,
    started_at       timestamptz NOT NULL DEFAULT now(),
    completed_at     timestamptz
);

CREATE TABLE IF NOT EXISTS startup_log_lines (
    id          bigserial PRIMARY KEY,
    instance_id text NOT NULL REFERENCES startup_log_sessions(instance_id) ON DELETE CASCADE,
    logged_at   timestamptz NOT NULL,
    stream      text NOT NULL CHECK (stream IN ('stdout', 'stderr')),
    content     text NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_startup_log_sessions_model
    ON startup_log_sessions (model_name, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_startup_log_lines_instance
    ON startup_log_lines (instance_id, id);
