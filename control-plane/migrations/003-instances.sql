-- Splits "instance" out of "models": models stays the logical-model configuration registry
-- (unique name, config columns); instances is the durable identity/placement ledger for the N
-- runtime replicas a model may have. Additive and empty-start — existing models rows remain
-- valid logical models with zero recorded instances; the reconciliation loop and future
-- deploy/instance-create calls populate this table going forward. No backfill: Redis lifecycle
-- state (models:{name}:{instanceId}) is the authoritative runtime source and is rebuilt by
-- reconciliation, not derived from this table. See ADR-019.
CREATE TABLE IF NOT EXISTS instances (
    instance_id     text PRIMARY KEY,
    model_name      text NOT NULL REFERENCES models(name) ON DELETE CASCADE,
    worker_id       text,
    device_indices  integer[],
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_instances_model  ON instances (model_name);
CREATE INDEX IF NOT EXISTS idx_instances_worker ON instances (worker_id);
