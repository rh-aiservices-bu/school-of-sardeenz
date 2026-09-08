# runner-mlserver

The **Seldon MLServer (KServe V2)** runner image. It is not run as a container in production — it
is built by the OpenShift librarian pipeline, converted to a **SIF** (optionally signed), and
`apptainer exec`'d by a
worker off the shared module volume. See
[ADR-015](../../docs/architecture/adrs/adr-015-sif-runtime-packaging.md),
[ADR-017](../../docs/architecture/adrs/adr-017-runner-image-pipeline.md), and
[`docs/project/phase4.md`](../../docs/project/phase4.md) (Task 3).

## What's in it

Single-stage build (unlike `runner-vllm`, there is no builder stage — MLServer ships as prebuilt
wheels, nothing to compile):

1. **base** — `nvidia/cuda:12.6.3-runtime-ubi9` + Python 3.12 (placeholder tag; **pin `@sha256`
   before publishing**, same discipline as `runner-vllm`'s base).
2. `pip install`s the pinned MLServer runtime set — `mlserver==1.6.1`,
   `mlserver-sklearn==1.6.1` (CPU-classical baseline), `mlserver-huggingface==1.6.1` (GPU torch
   runtime). No xgboost/lightgbm/mlflow runtimes yet (issue "Initial runtime set"; additive later
   as a package pin + catalog entry, no code change).
3. `pip install`s the runner-contract shim from `runners/mlserver/` (`sardeenz-mlserver-runner`),
   so the SIF serves the [engine-runner
   contract](../../packages/contracts/specs/engine-runner.yaml) and drives MLServer.
4. Drops to a non-root user (`sardeenz`, uid 1001) — the base ships no unprivileged app user.

> **Build context is the repo root** (the shim lives at `runners/mlserver/`, outside this
> directory): `podman build -f containers/runner-mlserver/Containerfile -t
sardeenz-runner-mlserver:1.6 .`

## Pins (keep in sync; re-test on any bump)

| Input                  | Value                             | Note                                              |
| ---------------------- | --------------------------------- | ------------------------------------------------- |
| base image             | `nvidia/cuda:12.6.3-runtime-ubi9` | **placeholder — pin `@sha256` before publishing** |
| `mlserver`             | `1.6.1`                           |                                                   |
| `mlserver-sklearn`     | `1.6.1`                           | CPU-classical baseline                            |
| `mlserver-huggingface` | `1.6.1`                           | GPU torch runtime                                 |

On any bump, re-run the MLServer shim's pytest suite (`runners/mlserver`) and re-validate the
gRPC/metrics aux-port offsets (`sardeenz_mlserver_runner/cli.py`) before publishing.

## Runtime notes (handled by the worker agent, not here)

- **`MLSERVER_HOST=0.0.0.0`**: the shim sets this explicitly (not MLServer's implicit default) so
  the proxy can reach the engine's bind address — see the shim README's `#159` note.
- **gRPC/metrics ports**: MLServer also binds gRPC and Prometheus listeners. A worker launch
  reserves a four-port block and supplies their exact ports through
  `SARDEENZ_MLSERVER_GRPC_PORT`/`SARDEENZ_MLSERVER_METRICS_PORT`; the shim's offset derivation is
  standalone/direct-SIF fallback only. The production worker NetworkPolicy permits no ingress to
  either auxiliary listener.
- **Offline at runtime:** the image keeps `HF_HUB_OFFLINE=1`; weights are pre-staged on the
  weights volume. Only the model-staging step overrides it.
- **Launch:** `apptainer exec --nv --bind /weights --bind /scratch <sif> python3 -m
sardeenz_mlserver_runner --model /weights/<model> --port <PORT> -- --served-model-name
<served-name>` — same launch shape as `runner-vllm`, sharing the worker's argv-construction path
  (`ApptainerLauncher`).

## Build and publish

Use the parameterized [`deployment/librarian`](../../deployment/librarian/) OpenShift Job. Set
`GIT_REF`, `CONTAINERFILE=containers/runner-mlserver/Containerfile`, the OCI/ORAS repositories and
tags, and `SIGN_SIF=false` for PoC output or `true` after provisioning the signing key.
