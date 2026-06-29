CREATE TABLE IF NOT EXISTS models (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name            text UNIQUE NOT NULL,
    runner_type     text NOT NULL,
    model_path      text NOT NULL,
    required_memory bigint,
    device_type     text,
    tensor_parallel integer DEFAULT 1,
    engine_config   jsonb,
    pinned          boolean DEFAULT false,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memory_profiles (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    model_name      text NOT NULL,
    runner_type     text NOT NULL,
    device_type     text NOT NULL,
    weights_bytes   bigint,
    kv_cache_bytes  bigint,
    overhead_bytes  bigint,
    total_bytes     bigint NOT NULL,
    measured_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS benchmarks (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    model_name              text NOT NULL,
    runner_type             text NOT NULL,
    tokens_per_second       real,
    time_to_first_token_ms  real,
    context_length          integer,
    batch_size              integer,
    measured_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS settings (
    key         text PRIMARY KEY,
    value       jsonb NOT NULL,
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_models_runner_type ON models (runner_type);
CREATE INDEX IF NOT EXISTS idx_memory_profiles_model ON memory_profiles (model_name, runner_type);
CREATE INDEX IF NOT EXISTS idx_benchmarks_model ON benchmarks (model_name, runner_type);
