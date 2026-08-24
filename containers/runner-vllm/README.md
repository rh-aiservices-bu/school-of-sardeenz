# runner-vllm

The **vLLM (+ kvcached)** runner image. It is not run as a container in production — it is built +
signed in CI, converted to a **SIF** by the librarian job, and `apptainer exec`'d by a worker off
the shared module volume. See [ADR-015](../../docs/architecture/adrs/adr-015-sif-runtime-packaging.md),
[ADR-017](../../docs/architecture/adrs/adr-017-runner-image-pipeline.md), and
[`docs/project/phase4.md`](../../docs/project/phase4.md) (Task 3).

## What's in it

Multi-stage build derived from the Sardeenz v1
[`docker/Containerfile`](https://github.com/rh-aiservices-bu/sardeenz/blob/main/docker/Containerfile),
stripped to just the runtime (no Node/app):

1. **base** — `quay.io/vllm/vllm-cuda:0.21.0_rhaiv.8` (the vetted RHAIV vLLM image; **kvcached is
   NOT in it**).
2. **kvcached-builder** — installs the CUDA-13.0 devel toolchain + git and `pip wheel`s the pinned
   `github.com/ovg-project/kvcached` commit (`--no-build-isolation`, `LIBRARY_PATH` includes the
   CUDA stubs). No GPU needed to build.
3. **runtime** — `pip install`s the kvcached wheel and sets `ENABLE_KVCACHED=true` +
   `KVCACHED_AUTOPATCH=1`. kvcached autopatches vLLM at import; **vLLM itself is not statically
   patched.** Also `pip install`s the runner-contract shim from `runners/vllm/`
   (`sardeenz-vllm-runner`), so the SIF serves the [engine-runner
   contract](../../packages/contracts/specs/engine-runner.yaml) and drives vLLM.

> **Build context is the repo root** (the shim lives at `runners/vllm/`, outside this directory):
> `podman build -f containers/runner-vllm/Containerfile -t sardeenz-runner-vllm:0.21 .`

## Pins (keep in sync; re-test on any bump)

| Input                | Value                                      | Note                                 |
| -------------------- | ------------------------------------------ | ------------------------------------ |
| base image           | `quay.io/vllm/vllm-cuda:0.21.0_rhaiv.8`    | vetted RHAIV vLLM                    |
| `KVCACHED_VERSION`   | `094481f3f77c53ad2edc13369b84eb42bbf082a1` | pinned ovg-project commit            |
| CUDA -devel versions | `13.0.*`                                   | **must match the base image's CUDA** |

On any bump, re-run the kvcached co-tenancy gate (spike Gate 9d) before publishing — kvcached
compatibility is version-sensitive.

## Runtime notes (handled by the worker agent, not here)

- **Writable caches:** the base image points `XDG_CACHE_HOME` / `HF_HOME` /
  `FLASHINFER_WORKSPACE_DIR` under `/opt/app-root/src`, which is **read-only inside a SIF**. The
  worker agent redirects them to node-local `/scratch` at exec (spike Gate 9d).
- **Launch:** `apptainer exec --nv --bind /weights --bind /scratch --env ENABLE_KVCACHED=true
--env KVCACHED_AUTOPATCH=1 --env XDG_CACHE_HOME=/scratch/cache … <sif> python3 -m
sardeenz_vllm_runner --model /weights/<model> --port <PORT>` (do **not** pass `--env HOME=…`;
  Apptainer rejects it — set `HOME=/scratch/home` as a process env). The shim launches
  `vllm serve` internally with `--enable-sleep-mode`. Cold-starts are serialized by the worker
  agent to avoid concurrent-cold-start host-RAM OOM (spike Gate 9c).
- **Offline at runtime:** the image keeps `HF_HUB_OFFLINE=1`; weights are pre-staged on the
  weights volume. Only the model-staging step overrides it.

## Convert to a SIF

Via the librarian job / `apptainer` (needs node-local scratch + ≥8Gi RAM; never on a serving
worker):

```bash
export APPTAINER_TMPDIR=/scratch APPTAINER_CACHEDIR=/scratch/cache
apptainer pull /modules/vllm-0.21.sif docker://<registry>/sardeenz-runner-vllm:0.21
apptainer sign /modules/vllm-0.21.sif
```
