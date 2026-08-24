# ADR-015: Engine Runtime Delivery via Apptainer SIF on Shared RWX Storage

## Status

Accepted — **supersedes [ADR-004](adr-004-highlander-runtime.md)** (Highlander runtime
integration with self-contained easyconfigs).

## Context

[ADR-004](adr-004-highlander-runtime.md) set the goal of delivering engine runtimes (vLLM,
Triton, …) to workers **without baking them into worker container images** — to get fast
version switching, side-by-side versions, slim workers, and no per-host image copy. Its chosen
mechanism was **EasyBuild + Lmod modules on shared storage** (the Highlander model): worker
containers become thin stubs that `module load <engine>/<version>` from a read-only mount.

Two problems emerged with the Lmod/EasyBuild mechanism (not with ADR-004's _goals_, which
still stand):

- **Authoring burden.** EasyBuild means owning a from-source compilation stack and writing an
  easyconfig for every engine and every version. For a GPU Python stack (vLLM + PyTorch +
  CUDA + kvcached) that is a heavy, fragile lift for whoever provisions a runtime — and it is
  _different_ work from the container images the ecosystem already ships.
- **Metadata storm.** Initializing a Python runtime directly off network storage generates
  intense metadata traffic (thousands of small `stat`/`open` calls) against the storage MDS.
  ADR-004 itself flagged this and pointed at "flattened module packaging (squashfs/erofs)" as
  the mitigation — i.e. the module should be _one file_, not a directory tree.

The Phase 4 feasibility spike ([`docs/project/phase4-apptainer-spike.md`](../../project/phase4-apptainer-spike.md))
validated an alternative that keeps every ADR-004 benefit while removing both problems: package
each runtime as an **Apptainer SIF** (a single squashfs file = a whole OCI image in one file)
and execute it in place with `apptainer exec`. The spike ran all gates green on a live OpenShift
(OKD 4.21) cluster, including two vLLM runners sharing one GPU via kvcached.

## Decision

**Engine runtimes are delivered as Apptainer SIF files on a shared RWX volume, executed in
place by the worker.** A "runner module" is a single `.sif` file; starting a runner is
`apptainer exec --nv /modules/<engine>-<version>.sif <serve cmd>`.

- **Any OCI image converts to a SIF** (`apptainer pull` / `apptainer build`) — **no EasyBuild,
  no from-source stack.** Sardeenz publishes a `Containerfile` per runner and builds the images
  with the normal container toolchain (see [ADR-017](adr-017-runner-image-pipeline.md)).
- **Single squashfs file ⇒ no metadata storm.** The runtime is one file that `squashfuse`
  mounts read-only and pages in lazily; the thousands of per-import file lookups resolve inside
  the mounted squashfs, not as individual network-FS metadata operations.
- **Storage is RWX-agnostic.** SIFs live on any shared RWX volume. The spike proved the design
  on **AWS EFS (NFSv4)**; **CephFS** (ODF) remains the priority target. The two mount profiles
  are: model weights (RWX) and the SIF **module store** (RWX; consumer workers mount it
  read-only — see [ADR-017](adr-017-runner-image-pipeline.md)).
- The security posture required to run SIFs unprivileged is
  [ADR-016](adr-016-sif-worker-security-posture.md); the build/sign/convert pipeline and
  `containers/` layout are [ADR-017](adr-017-runner-image-pipeline.md).

This replaces `module load` as the runtime-composition mechanism in [ADR-010](adr-010-engine-runners.md)'s
runner model: a runner is now a process that `apptainer exec`s its SIF rather than one that
runs `module load`. The worker/runner hierarchy and the runner contract are unchanged.

## Consequences

- **ADR-004's wins are preserved:** fast version switching (drop a new `.sif`, no rebuild),
  side-by-side versions, slim workers (base OS + Apptainer, no engine baked in), no per-host
  copy (workers page the SIF in from shared storage; nothing is pulled or stored per node).
- **Hot-add without recycling workers** is a first-class property: a new `.sif` on the volume
  is runnable immediately, no Pod restart (spike Gate 6).
- **EasyBuild/Lmod is dropped.** `easyconfigs/` is removed; the runtime is packaged with the
  container toolchain everyone already knows. Runtime isolation between concurrent runners now
  comes from each runner exec-ing its own SIF (self-contained filesystem), not from per-process
  Lmod environments.
- **A mild custom SCC is required** (seccomp `Unconfined` + a `/dev/fuse` annotation, no
  privileged, no added capabilities). This is the one real cost versus a stock `restricted-v2`
  deployment — see [ADR-016](adr-016-sif-worker-security-posture.md). It is not free, but it is
  far milder than `privileged`.
- **Supply chain must be closed deliberately.** SIFs on an RWX volume bypass the cluster's
  image-admission/scanning surface, so Sardeenz signs SIFs at build time and workers verify at
  exec — [ADR-017](adr-017-runner-image-pipeline.md).
- **kvcached (and any patched runtime) needs a custom-built image** — base engine image + the
  kvcached wheel + enablement env. This is true for a plain container deployment too, so it is
  _SIF-neutral_; it just means the runner image is a Sardeenz-built artifact, not an upstream
  pull ([ADR-017](adr-017-runner-image-pipeline.md)).
- **Build vs. exec split.** SIF _conversion_ is a one-time, resource-heavy build step (needs
  node-local scratch, several GB RAM) and belongs in a librarian/CI job — never on the serving
  worker, which only needs to `apptainer exec`.
- **The alternatives were weighed** (OpenShift `zstd:chunked` lazy pulls, Kubernetes
  ImageVolumes, hand-rolled bubblewrap, and the original EasyBuild/Lmod). SIF's differentiator
  is _hot-add without a Pod restart_ plus _no per-node copy_; the trade is the mild SCC. See
  §13 of the spike for the full comparison.
