-- Opt-in to loading pickle-based weight formats for a model configuration (#336).
-- Formats that deserialize with pickle (.bin, .pt, .pth, .ckpt, .pkl, .pickle, .joblib) can
-- execute arbitrary code on a GPU worker; the runner shim refuses them at startup unless this
-- is true (SARDEENZ_ALLOW_UNSAFE_WEIGHTS=1, emitted by the worker only when the flag is set).
-- Default false: refuse (deploy behavior unchanged for safetensors/ONNX/GGUF/.bst). The
-- enforcement is fail-closed in the shim — this column only records the operator's opt-in,
-- persisted so every later start (start/add-instance/reclamation) keeps it.
ALTER TABLE models ADD COLUMN IF NOT EXISTS allow_unsafe_weights boolean NOT NULL DEFAULT false;
