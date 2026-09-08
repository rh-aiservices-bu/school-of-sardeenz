# worker-base

The reusable base for the production `sardeenz-worker` image and the librarian's SIF conversion
container. It provides **Apptainer (rootless)** + FUSE helpers so the worker agent can `apptainer
exec` engine **SIF** files straight off the shared module volume. It deliberately contains no
worker-agent code and no inference engine — see [`../worker/`](../worker/) for the deployable
worker image. Engines ship as SIFs (see
[ADR-015](../../docs/architecture/adrs/adr-015-sif-runtime-packaging.md)).

## What's in it

- UBI9 base + EPEL `apptainer` (rootless, **not** `apptainer-suid`)
- FUSE stack: `fuse-overlayfs`, `squashfuse`, `fuse3` (for `squashfuse` no-copy SIF mounts)
- `tzdata` **and** `/etc/localtime` → Apptainer bind-mounts `/etc/localtime`/`/etc/hosts` by
  default; without them `apptainer exec` fails with `mount source /etc/localtime doesn't exist`
- diagnostics: `procps-ng`, `iproute`, `jq`, `ca-certificates`
- Node.js 22, used by the worker-agent layer

## How it must run (worker Pod)

Per [ADR-016](../../docs/architecture/adrs/adr-016-sif-worker-security-posture.md):

- SCC: the mild custom seccomp SCC (seccomp `Unconfined`, no privileged, no added caps, no
  `hostUsers: false`)
- Pod annotation: `io.kubernetes.cri-o.Devices: "/dev/fuse"` (4.15+, no device plugin)
- Runtime: `crun`
- Mounts: `/modules` (RWX module store, **readOnly**), `/weights` (RWX), `/scratch` (`emptyDir`,
  node-local — used for `APPTAINER_TMPDIR`/cache and writable engine caches), `/dev/shm`
  (`emptyDir` `medium: Memory`)

The exact Deployment/SCC manifests are a Phase 4 deliverable (`deployment/`, Task 8). The spike's
§5/§8 manifests are the validated starting point.

## Build

Build this base first, then build [`../worker/Containerfile`](../worker/Containerfile) with its
registry-resolvable reference as `WORKER_BASE_IMAGE`. The worker README contains both OpenShift and
local build recipes. Do not deploy `worker-base` directly: it has no worker-agent entrypoint.

## Provenance

Materialized from the Phase 4 spike §4 (validated on OKD 4.21). See
[`docs/project/phase4-apptainer-spike.md`](../../docs/project/phase4-apptainer-spike.md).
