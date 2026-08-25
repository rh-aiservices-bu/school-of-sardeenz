# runner-mlserver

The **Seldon MLServer (KServe V2)** runner image. It is not run as a container in production — it
is built + signed in CI, converted to a **SIF** by the librarian job, and `apptainer exec`'d by a
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
> sardeenz-runner-mlserver:1.6 .`

## Pins (keep in sync; re-test on any bump)

| Input                        | Value                          | Note                                             |
| ----------------------------- | ------------------------------ | ------------------------------------------------- |
| base image                    | `nvidia/cuda:12.6.3-runtime-ubi9` | **placeholder — pin `@sha256` before publishing** |
| `mlserver`                    | `1.6.1`                        |                                                   |
| `mlserver-sklearn`            | `1.6.1`                        | CPU-classical baseline                           |
| `mlserver-huggingface`        | `1.6.1`                        | GPU torch runtime                                |

On any bump, re-run the MLServer shim's pytest suite (`runners/mlserver`) and re-validate the
gRPC/metrics aux-port offsets (`sardeenz_mlserver_runner/cli.py`) before publishing.

## Runtime notes (handled by the worker agent, not here)

- **`MLSERVER_HOST=0.0.0.0`**: the shim sets this explicitly (not MLServer's implicit default) so
  the proxy can reach the engine's bind address — see the shim README's `#159` note.
- **gRPC/metrics ports**: MLServer also binds a gRPC server and a Prometheus metrics server even in
  this REST-only deployment; the shim derives non-colliding ports from `--engine-port`. Cluster
  validation of the offset defaults is tracked as a follow-up (see the shim README).
- **Offline at runtime:** the image keeps `HF_HUB_OFFLINE=1`; weights are pre-staged on the
  weights volume. Only the model-staging step overrides it.
- **Launch:** `apptainer exec --nv --bind /weights --bind /scratch <sif> python3 -m
  sardeenz_mlserver_runner --model /weights/<model> --port <PORT> -- --served-model-name
  <served-name>` — same launch shape as `runner-vllm`, sharing the worker's argv-construction path
  (`ApptainerLauncher`).

## Convert to a SIF

Reuses the runner-agnostic librarian pipeline — no pipeline code change needed for this runner
(`build-sif.sh` takes `--image`/`--name`; `mlserver-1.6` is a valid `--name` and matches the
catalog's `sifName`):

```bash
export APPTAINER_TMPDIR=/scratch APPTAINER_CACHEDIR=/scratch/cache
apptainer pull /modules/mlserver-1.6.sif docker://<registry>/sardeenz-runner-mlserver:1.6
apptainer sign /modules/mlserver-1.6.sif
```

Or via the librarian job manifest: set `IMAGE_REF=<mlserver image @sha256>`,
`SIF_NAME=mlserver-1.6` in `deployment/librarian/job.yaml` and apply; or
`scripts/build-sif.sh --image <ref> --name mlserver-1.6`.
