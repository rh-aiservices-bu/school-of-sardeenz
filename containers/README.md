# containers/

Container image definitions for Sardeenz. Two kinds live here:

| Kind                  | Directory                      | What it is                                                                                                                                          |
| --------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Service images**    | `control-plane/`, `dashboard/` | The TypeScript services, deployed as normal K8s workloads.                                                                                          |
| **Worker host image** | `worker-base/`                 | The slim image a **worker Pod** runs: base OS + accelerator driver access + **Apptainer**. It `apptainer exec`s runner SIFs; no engine is baked in. |
| **Runner images**     | `runner-<engine>/`             | The image that **becomes a SIF** for an engine (e.g. `runner-vllm/` = base vLLM + kvcached). One directory per runner type.                         |

See [ADR-015](../docs/architecture/adrs/adr-015-sif-runtime-packaging.md) (SIF runtime delivery),
[ADR-016](../docs/architecture/adrs/adr-016-sif-worker-security-posture.md) (worker security
posture), and [ADR-017](../docs/architecture/adrs/adr-017-runner-image-pipeline.md) (build &
supply chain). Implementation plan: [`docs/project/phase4.md`](../docs/project/phase4.md).

## How a runner runtime is produced

Runner runtimes are **not** baked into the worker image and **not** Lmod modules (the superseded
Highlander/EasyBuild plan, ADR-004). Each runtime is a `Containerfile` here → an OCI image → an
ORAS-distributed **SIF** that an administrator imports onto the shared module volume:

```text
Git ref + containers/runner-<engine>/Containerfile
        │  OpenShift native Docker build
        ▼
   tagged OCI image + immutable registry digest
        │  librarian Job: apptainer build + optional sign + ORAS push (node-local scratch)
        ▼
   tagged SIF artifact in OCI registry
        │  target admin: Runner Catalog → Import
        ▼
   <engine>-<version>.sif on shared RWX module PVC
        │  worker: apptainer exec --nv … (squashfuse, read-only; verify when enabled)
        ▼
   Runner process serving the engine-runner contract + the engine
```

## Distributing ready-made SIFs (ORAS + catalog)

Rather than have every operator build SIFs, **official** runners are pushed to an OCI registry as
**ORAS** artifacts (`apptainer push <engine>-<version>.sif oras://quay.io/<ns>/<repo>:<tag>`) and
listed in a [`runners.yaml`](../runners.yaml) catalog. Operators **Import** them from the dashboard,
which has the control plane `apptainer pull oras://…` the SIF onto the module store (verifying the
signature). See [`docs/usage/runner-catalog.md`](../docs/usage/runner-catalog.md). The librarian
build/sign flow below remains for building your own SIFs.

Maintainers can launch the complete Git-ref → OCI image → signed ORAS SIF operation from the
parameterized OpenShift librarian Job; all heavy work stays in the build cluster.

Key rules:

- **Conversion is a librarian/CI step, never a serving worker.** It needs node-local scratch
  (`APPTAINER_TMPDIR` on an `emptyDir`, not the network volume — a network-FS tmp fails the
  hardlink-heavy OCI unpack with `unpriv.link … too many links`) and several GB of RAM.
- **Sign at build, verify at exec for production.** SIFs on an RWX volume bypass cluster image
  admission; the signature + locked module PVC close that gap (ADR-017). The publisher supports an
  explicit unsigned PoC mode, which requires verification to be disabled at import and exec.
- **kvcached (and other patched runtimes) need a custom image** — base engine + the kvcached
  wheel + `ENABLE_KVCACHED`/`KVCACHED_AUTOPATCH`. This is required for a plain container too, so
  it's SIF-neutral; it just makes the runner image a first-class, versioned artifact.

## Naming

- SIF filename: `<engine>-<version>.sif` (e.g. `vllm-0.21.sif`). Versioned, never `-latest`.
- Runner image directory: `runner-<engine>/`.
- Pin external inputs (base image tag, kvcached commit) in each runner's `Containerfile` and
  `README.md`; re-run the kvcached co-tenancy gate on any bump.

## Adding a runner type

1. Create `containers/runner-<engine>/Containerfile` (+ `README.md`) — base engine image, any
   patches (as installed wheels/packages, not from-source where avoidable), runtime enablement
   env, and the runner-contract shim entrypoint.
2. Build and publish the OCI image + SIF via the parameterized OpenShift librarian Job.
3. Add/adjust the runner shim under `runners/<engine>/` so the SIF serves the
   [engine runner contract](../packages/contracts/specs/engine-runner.yaml).

## Runtime prerequisites (worker side)

OpenShift/OKD 4.15+ (tested on 4.21), `crun` runtime, a shared RWX StorageClass, the custom
seccomp SCC bound to the worker SA, and the `io.kubernetes.cri-o.Devices: "/dev/fuse"` pod
annotation. Full detail: [ADR-016](../docs/architecture/adrs/adr-016-sif-worker-security-posture.md)
and the [Phase 4 spike](../docs/project/phase4-apptainer-spike.md).
