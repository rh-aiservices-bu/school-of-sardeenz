-- The runtime module (e.g. "vllm-0.21") the worker execs to serve a model, resolved to
-- /modules/<runtime_module>.sif by the Apptainer launcher. Nullable: when unset the worker falls
-- back to <runner_type>-<engine_config.version>.
ALTER TABLE models ADD COLUMN IF NOT EXISTS runtime_module text;
