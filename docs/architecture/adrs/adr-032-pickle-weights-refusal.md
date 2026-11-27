# ADR-032: Pickle-Based Weights Are Refused at Runner Startup, With a Per-Model Opt-In

## Status

Accepted. Implements [#336](https://github.com/rh-aiservices-bu/school-of-sardeenz/issues/336)
(M22). Extends [ADR-016](adr-016-sif-worker-security-posture.md) (the SIF is verified at exec; the
weights it loads are not) and relates to
[#284](https://github.com/rh-aiservices-bu/school-of-sardeenz/issues/284) (signing/checksumming
weights — deliberately still open). Signing weights is out of scope here.

## Context

Engine SIFs are signature-verified before they run ([ADR-017](adr-017-runner-image-pipeline.md)),
but model weights were loaded with no format check at all. The MLServer shim explicitly treated
`pytorch_model.bin` as a valid Hugging Face marker, so a pickle load was the documented, encouraged
path. Three facts made that the platform's largest unstated trust assumption:

- **Weights are the one unsigned input on a worker.** Anyone who can write a weights directory can
  run code inside a runner process, i.e. on a GPU node.
- **Both shims are separate distributions.** vLLM and MLServer install on separate SIFs with no
  shared package and no shared dependency, so a shared detector would mean inventing a package that
  does not otherwise exist.
- **The worker already has a place to pass environment into the SIF.** `apptainer exec --cleanenv`
  re-emits every runner variable as an explicit `--env K=V` from one `envFlags` map, so a new
  control can travel without a new channel.

## Decision

1. **Default deny, with an opt-in.** Both shims refuse `.bin`, `.pt`, `.pth`, `.ckpt`, `.pkl`,
   `.pickle` and `.joblib` anywhere below the model directory unless the model opted in. The
   MLServer sklearn family is therefore opt-in-only. `.bst` (XGBoost binary) is **not** a pickle and
   stays allowed; safetensors, ONNX, GGUF, HDF5, `npy`/`npz` and JSON are unaffected (a
   `pytorch_model.bin.index.json` is allowed, its `.bin` shards are not).
2. **The refusal is enforced in the shim, not the control plane.** The worker sees the real model
   directory through its own `SARDEENZ_WEIGHTS_DIR`; the control plane's view may be a different
   mount or stale, so a control-plane-only check is bypassable and a shim-only check fails after GPU
   scheduling. The control plane refuses early on `POST`/`PUT /api/v1/models` as a courtesy
   (`control-plane/src/services/weights-policy.ts`, fail-open on an unreadable directory) and a
   drift test pins its suffix list to both shims.
3. **The scan walks every entry, metadata only.** Dot-directories (`.cache`, `.w`) and caches such as
   `__pycache__` are **not** pruned: a source-supplied `model-settings.json` can point
   `parameters.uri` at any contained directory, which made pruning a reachable bypass. The walk
   lists names and never opens a file; symlinked directories are not followed, and MLServer's
   `parameters.uri` containment check refuses realpath escapes. The residual — a vLLM `weight_map`
   entry or `--subfolder` following an outside-pointing link — is documented, not fixed: writes
   outside the deployed model directory are already code-execution-equivalent.
4. **The opt-in is one persisted flag.** `allowUnsafeWeights` (default false) travels
   contracts → control plane → `models.allow_unsafe_weights`
   (`control-plane/migrations/009-add-allow-unsafe-weights.sql`) → worker launch identity →
   `SARDEENZ_ALLOW_UNSAFE_WEIGHTS=1` in the SIF environment. Persisting it matters because
   `POST /api/v1/models/:name/start` rebuilds the launch spec from the stored record; a
   request-only flag would be lost on every later start. It is part of the worker's launch identity,
   so a changed flag on the same instance is a conflict, never a silent reuse.
5. **Absence is indistinguishable from `false`** at every layer: absent and false produce identical
   argv and no environment variable. Only `1`/`true` (case-insensitive) enable the opt-in;
   `yes`/`on`/`0`/empty deny, and a non-boolean value on `POST /runners` is rejected rather than
   coerced.
6. **One documented list.** The format policy lives once, in the _Model weights trust boundary_
   section of `docs/usage/deployment-security.md`; the MLServer guide cross-references it. The
   shim↔shim copy is kept honest by the shared conformance matrix
   (`runners/conformance/test_weights_policy.py`), and shim↔control-plane by a unit test that
   extracts both shims' `REFUSED_SUFFIXES` and asserts set equality.

## Consequences

- A pickle-based deploy now fails while starting, with the reason in the runner's startup log,
  naming every offending file and both spellings of the opt-in.
- The change is **inert on shipped images until the MLServer SIF is republished** (the shim is
  copied into the image and the catalog pins immutable digests). Rollout is safe in either order: a
  new worker with an old SIF passes a variable the old shim ignores, and a new SIF with an old
  worker refuses by default.
- A directory holding both safetensors and a pickle copy is refused; the message tells the operator
  to delete the pickle or opt in. That is deliberate — the engine's preference order is a library
  detail we cannot pin.
- `runtimeModule` (arbitrary repository code by design) and `--trust-remote-code` remain documented
  risks, not refusals; both belong to the threat model ([#337](https://github.com/rh-aiservices-bu/school-of-sardeenz/issues/337)).

## Non-goals

- Signing or checksumming weights ([#284](https://github.com/rh-aiservices-bu/school-of-sardeenz/issues/284)).
- Refusing repository code execution (`runtimeModule`, `--trust-remote-code`).
- Scanning inside the SIF at build time, or trusting the SIF for the weights check.
- Version-pinning the shims' Python dependencies (they install atop the engine base images).
