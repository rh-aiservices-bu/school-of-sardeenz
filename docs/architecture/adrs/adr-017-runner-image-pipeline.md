# ADR-017: Runner Image Build and Supply Chain

## Status

Accepted. Defines the build/provisioning half of [ADR-015](adr-015-sif-runtime-packaging.md).
Amended by [ADR-018](adr-018-runner-catalog-oras-distribution.md), which distributes pre-built
signed SIFs via ORAS and adds the **control plane** as a second module-store writer (importing via
`apptainer pull`, not build) alongside the librarian.

## Context

[ADR-015](adr-015-sif-runtime-packaging.md) delivers engine runtimes as SIF files on a shared
RWX volume. Three facts from the Phase 4 spike shape how those SIFs are produced and trusted:

- **SIFs bypass cluster image admission.** A SIF executed off an RWX volume is not subject to
  the cluster's `ClusterImagePolicy`, signature policy, or scanner coverage. Whatever writes the
  module volume becomes a code-injection path into every worker.
- **Some runtimes need a custom-built image.** kvcached — the GPU-memory-sharing layer central
  to Sardeenz — is not in the stock vLLM image; it is a wheel (built from a pinned
  `github.com/ovg-project/kvcached` commit, needs the CUDA devel toolchain) installed on top,
  enabled with `ENABLE_KVCACHED=true` + `KVCACHED_AUTOPATCH=1` (it autopatches vLLM at import;
  vLLM itself is not statically patched). This custom-image need is identical for a plain
  container deployment, so it is SIF-neutral — but it means the runner image is a Sardeenz
  artifact, not an upstream pull.
- **Conversion is heavy and one-time.** Converting a ~5–6 GB OCI image to SIF needs node-local
  scratch (a network-FS `APPTAINER_TMPDIR` fails the hardlink-heavy OCI unpack with
  `unpriv.link … too many links`) and several GB of RAM (an un-budgeted Pod was node-pressure
  OOM-killed once). It must not run on a serving worker.

## Decision

**Sardeenz owns a build pipeline that produces signed SIFs; workers only consume them.**

1. **Publish a `Containerfile` per runner** in the repo under `containers/`:
   - `containers/worker-base/` — the slim worker host image (UBI + Apptainer + FUSE helpers +
     `tzdata`/`/etc/localtime`); this is what the worker Pod runs and what execs SIFs.
   - `containers/runner-<engine>/` — the image that _becomes a SIF_ (e.g. `runner-vllm/` = base
     vLLM + kvcached wheel + `ENABLE_KVCACHED`/`KVCACHED_AUTOPATCH`). One directory per runner
     type; versioned and reviewed.
2. **Build the OCI images in CI** with the container toolchain (including the CUDA devel
   toolchain where a runner needs to compile a wheel), scan them, and push to a registry — the
   normal, admission-covered image pipeline.
3. **Convert image → SIF once in a librarian job** (a Kubernetes `Job`/CronJob or CI step) that
   mounts the module PVC read-write, has node-local scratch (`emptyDir`) for `APPTAINER_TMPDIR`
   and enough RAM, runs `apptainer pull`/`build`, **`apptainer sign`**s the result, makes it
   **world-readable (`chmod 644`)** — the librarian's write UID differs from the worker's
   arbitrary read UID — and writes it to the module store with a **versioned filename**
   (`vllm-0.21.sif`, not `-latest`) using a **write-new-then-symlink** update so an in-use SIF is
   never overwritten in place.
4. **Workers only `apptainer exec`** the SIF from a **read-only** mount of the module PVC, and
   **verify the signature** at exec (`apptainer.conf` can require it). No pull, no `mksquashfs`,
   minimal RAM/scratch.

**SIF signing keys** are a new concern this ADR owns (ADR-013 governs only env-var _application_
secrets, not signing keypairs): an `apptainer key newpair` whose **private** key lives in a
Secret mounted **only** into the librarian job, and whose **public** key is distributed to every
worker (ConfigMap/Secret → `apptainer key import`, or baked into `worker-base`) so workers verify
at exec. Document a rotation path (re-sign, roll the public key to workers before retiring the old
one).

**Write-protecting the module PVC needs an explicit mechanism** — Kubernetes RBAC does _not_
restrict a PVC's mount mode by ServiceAccount, so "only the librarian writes it" must be enforced
by one of: a ValidatingAdmissionPolicy/Kyverno rule that rejects non-librarian Pods mounting it
read-write; a two-PVC split (librarian-only staging PVC + a separate module PVC workers mount
`readOnly`); or, absent admission tooling, a documented convention that Sardeenz-authored worker
Deployments always mount it `readOnly`. Phase 4 picks and records one.

Baked cache-dir env in an app-derived image (e.g. `XDG_CACHE_HOME`/`HF_HOME`/
`FLASHINFER_WORKSPACE_DIR` under `/opt/app-root/src`) must be **redirected to a writable path**
at exec (node-local scratch), because the SIF root is read-only.

## Consequences

- **The supply-chain gap is closed** by construction: Sardeenz builds, scans, and signs; workers
  verify. Combined with the module-PVC write-protection mechanism above (admission policy,
  two-PVC split, or documented convention), the admission-bypass concern is answered.
- **`containers/` is the home for all runner image definitions.** Adding a runner type = adding
  a `containers/runner-<engine>/` directory with a `Containerfile` and building it — not writing
  an easyconfig. `easyconfigs/` is removed (see [ADR-015](adr-015-sif-runtime-packaging.md)).
- **Reproducible, first-class artifacts.** kvcached-patched vLLM (and any future patched engine)
  becomes a reviewed, versioned image rather than a per-user chore.
- **Build cost is amortized.** The heavy conversion happens once per engine version for the whole
  fleet; a container-based deployment would pay a comparable per-node image pull anyway, so the
  one-time conversion is not a runtime economic factor (spike Gate 10).
- **Disconnected clusters** fit naturally: the librarian pre-builds SIFs and places them on the
  PVC; there is no per-worker `docker://` egress requirement at serve time.
- **Model weights are staged separately** (their own RWX volume) and runners stay offline at
  runtime (`HF_HUB_OFFLINE=1`); the librarian/CI stages weights, mirroring the SIF pattern.
