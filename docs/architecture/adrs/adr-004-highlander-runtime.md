# ADR-004: Highlander Runtime Integration with Self-Contained Easyconfigs

## Status

**Superseded by [ADR-015](adr-015-sif-runtime-packaging.md).**

The _goals_ of this ADR still hold (deliver runtimes without baking them into worker images;
fast version switching, side-by-side versions, slim workers, no per-host copy). The _mechanism_
— EasyBuild/Lmod modules on shared storage — is replaced by **Apptainer SIF files on a shared
RWX volume**, which keeps every benefit here while removing the from-source authoring burden and
the metadata-storm risk (a SIF is the "flattened single-file module" this ADR's Consequences
already pointed to). See [ADR-015](adr-015-sif-runtime-packaging.md),
[ADR-016](adr-016-sif-worker-security-posture.md), and
[ADR-017](adr-017-runner-image-pipeline.md). The `easyconfigs/` deliverable is dropped in favor
of `containers/`. Retained below for historical rationale.

## Context

In traditional container-based AI platforms, inference engine runtimes (vLLM, Triton, etc.) are baked into container images. This creates several friction points:

- **Image size.** Container images carrying a full Python runtime, PyTorch, and an inference engine can easily exceed 15GB. On uncached nodes, pulling these images adds significant cold-start latency.
- **Engine version iteration.** Testing a different engine version requires rebuilding and redeploying the entire container image. Each cycle may take 10+ minutes, making rapid iteration impractical.
- **No side-by-side versions.** Running two engine versions concurrently (for canary testing or A/B comparison) requires two separate container deployments, doubling resource overhead.

[Project Highlander](https://odh-highlander.github.io/) applies High-Performance Computing (HPC) paradigms to solve this. It uses EasyBuild to package AI runtimes into Lmod environment modules, stored on shared network storage (CephFS). Worker containers become thin stubs — just a base OS and accelerator drivers — that dynamically compose their runtime environment via `module load`.

## Decision

Sardeenz integrates the Highlander runtime model into its worker containers. Engine runtimes are loaded as Lmod modules from a shared CephFS mount, not baked into container images.

**Sardeenz is self-contained.** The EasyBuild configurations (easyconfigs) that define how to package runtimes into modules, and the base worker container image, live in this repository — not in the upstream Highlander repo. This ensures the platform can be built and deployed independently.

The storage layout uses two mount profiles:

| Mount                   | Access                | Purpose                                            |
| ----------------------- | --------------------- | -------------------------------------------------- |
| **Model weights**       | Read-Write Many (RWX) | Shared model weight storage, `.safetensors` format |
| **Application modules** | Read-Only Many (ROX)  | Compiled Lmod modules (engine runtimes, libraries) |

## Consequences

- **Fast engine iteration.** Switching engine versions is a `module load` / `module unload` — seconds, not a container rebuild cycle.
- **Zero-downtime upgrades.** New engine versions run as parallel processes in the same container. The proxy shifts traffic, the old process drains and exits.
- **Canary and A/B testing.** Two engine versions can serve traffic side-by-side from the same worker, with traffic splitting at the proxy layer.
- **Slim worker images.** Container images shrink to base OS + accelerator drivers, reducing pull times and storage costs.
- **CephFS dependency.** The shared network storage becomes a critical infrastructure component. Availability and performance of the storage fabric directly affect model load times and module availability.
- **Metadata storm risk.** Python runtime initialization over network storage can generate intense metadata operations on CephFS MDS. Must be mitigated with client-side caching or flattened module packaging (squashfs/erofs).
- **Self-contained ownership.** Easyconfig maintenance (adding new engine versions, patching CVEs) is the project's responsibility, not an upstream dependency.
