-- Opt-in to kvcached elastic co-location for a model configuration (Phase 5, #276).
-- When true, the placement pipeline may place this model's instances on a device past naive
-- byte-sum capacity when every instance already resident on that device (including sleeping
-- ones) belongs to a runner type declaring kvCacheElasticSharing on the target worker, bounded
-- by the control plane's oversubscription cap (SARDEENZ_COLOCATION_MAX_POOL_HEADROOM_PERCENT).
-- Default false: bytes must fit (placement behavior unchanged). The capability guard is
-- fail-closed in code — this column only records the operator's opt-in.
ALTER TABLE models ADD COLUMN IF NOT EXISTS allow_co_location boolean DEFAULT false;
