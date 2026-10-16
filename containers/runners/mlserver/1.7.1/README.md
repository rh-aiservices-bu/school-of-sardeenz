# MLServer 1.7.1 runner

The **Seldon MLServer (KServe V2)** runner image. It is not run as a container in production — it
is built by the OpenShift librarian pipeline, converted to a **SIF** (optionally signed), and
`apptainer exec`'d by a
worker off the shared module volume. See
[ADR-015](../../../../docs/architecture/adrs/adr-015-sif-runtime-packaging.md),
[ADR-017](../../../../docs/architecture/adrs/adr-017-runner-image-pipeline.md), and
[`docs/project/phase4.md`](../../../../docs/project/phase4.md) (Task 3).

## What's in it

Single-stage build (unlike `runner-vllm`, there is no builder stage — MLServer ships as prebuilt
wheels, nothing to compile):

1. **base** — `nvidia/cuda:12.6.3-runtime-ubi9` + Python 3.12 (placeholder tag; **pin `@sha256`
   before publishing**, same discipline as `runner-vllm`'s base). Python 3.12 is installed directly
   from UBI AppStream; UBI does not expose a `python312` DNF module stream.
2. `pip install`s the pinned MLServer runtime set — `mlserver==1.7.1`,
   `mlserver-sklearn==1.7.1` (CPU-classical baseline), `mlserver-huggingface==1.7.1` (GPU torch
   runtime) with `torch==2.10.0` (last PyPI torch built for CUDA 12) — then swaps the CPU-only
   `onnxruntime` wheel that `mlserver-huggingface` pulls in for
   `onnxruntime-gpu[cuda,cudnn]==1.26.0`, which backs the shim's own ONNX runtime
   (`sardeenz_mlserver_runner.onnx_runtime.ONNXRuntimeModel`; Seldon publishes no
   `mlserver-onnx`). The `nvidia-*-cu12` wheels (shared by torch and the `[cuda,cudnn]` extras)
   ship the CUDA 12.8 + cuDNN 9 libraries that build links against, since the base's 12.6 toolkit
   is older. RHEL-family Python installs those pure wheels under `/usr/local/lib/...` while
   `onnxruntime-gpu` lives under `/usr/local/lib64/...`, so the image puts their `lib/` directories
   on `LD_LIBRARY_PATH` and the build `dlopen()`s every one of them; without this the CUDA
   provider silently degrades to CPU (the `1.7.1-rc3` bug). No xgboost/lightgbm/mlflow runtimes
   yet (additive later as a package pin + catalog entry).
3. `pip install`s the runner-contract shim from `runners/mlserver/` (`sardeenz-mlserver-runner`),
   so the SIF serves the [engine-runner
   contract](../../../../packages/contracts/specs/engine-runner.yaml) and drives MLServer.
4. Drops to a non-root user (`sardeenz`, uid 1001) — the base ships no unprivileged app user.

> **Build context is the repo root** (the shim lives at `runners/mlserver/`, outside this
> directory): `podman build -f containers/runners/mlserver/1.7.1/Containerfile -t
quay.io/rh-aiservices-bu/sardeenz-runner-images/mlserver:1.7 .`

## Pins (keep in sync; re-test on any bump)

| Input                  | Value                             | Note                                               |
| ---------------------- | --------------------------------- | -------------------------------------------------- |
| base image             | `nvidia/cuda:12.6.3-runtime-ubi9` | **placeholder — pin `@sha256` before publishing**  |
| Python                 | `3.12`                            | MLServer 1.7.1 requires `>=3.9,<3.13`              |
| `mlserver`             | `1.7.1`                           |                                                    |
| `mlserver-sklearn`     | `1.7.1`                           | CPU-classical baseline                             |
| `mlserver-huggingface` | `1.7.1`                           | GPU torch runtime                                  |
| `torch`                | `2.10.0`                          | last PyPI build for CUDA 12; 2.11+ ship CUDA 13    |
| `onnxruntime-gpu`      | `1.26.0` (`[cuda,cudnn]` extras)  | last PyPI build for CUDA 12; 1.27+ default CUDA 13 |

On any bump, re-run the MLServer shim's pytest suite (`runners/mlserver`, including
`tests/test_onnx_runtime.py` from a venv with `mlserver`, `onnxruntime` and `onnx` installed) and
re-validate the gRPC/metrics aux-port offsets (`sardeenz_mlserver_runner/cli.py`) before
publishing. Bumping `onnxruntime-gpu` past 1.26 requires either a CUDA 13 base + driver or the
separate CUDA 12 package index documented by onnxruntime. `torch` and `onnxruntime-gpu` must stay
on the same CUDA major: their `nvidia-cudnn-cu12`/`-cu13` wheels write the same
`nvidia/cudnn/lib/` files, and the build refuses an image where both are installed.

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

Use the parameterized [`deployment/librarian`](../../../../deployment/librarian/) OpenShift Job. Set
`GIT_REF`, `CONTAINERFILE=containers/runners/mlserver/1.7.1/Containerfile`, the OCI/ORAS repositories and
tags, and `SIGN_SIF=false` for PoC output or `true` after provisioning the signing key.
