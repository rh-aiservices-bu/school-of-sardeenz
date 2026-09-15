-- Engine-reported model identity, distinct from the configuration name (ADR-020, #154).
-- Nullable: absent means the configuration name is used (current behavior, unchanged argv).
-- Deliberately NOT unique — multiple configurations may share one served model name (that's the
-- whole point of the split: A/B testing engine args or runtimeModule under one reported identity).
ALTER TABLE models ADD COLUMN IF NOT EXISTS served_model_name text;
