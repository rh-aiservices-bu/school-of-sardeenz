-- Verbatim CLI tokens passed to the engine after the shim's `--` separator (issue #126).
-- A native text[] round-trips to string[] via node-postgres with no JSON parse. Nullable:
-- unset means no user-supplied engine args. Old rows keep their inert engine_config JSON.
ALTER TABLE models ADD COLUMN IF NOT EXISTS engine_args text[];
