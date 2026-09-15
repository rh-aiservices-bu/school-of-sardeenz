-- Human-friendly presentation label for a model configuration (e.g. "Qwen test 1").
-- Nullable: the dashboard falls back to models.name when unset. Deliberately NOT unique and NOT
-- indexed — free-form text, never a routing key, never crosses the worker boundary or enters
-- Redis (presentation-only, unlike servedModelName).
ALTER TABLE models ADD COLUMN IF NOT EXISTS display_name text;
