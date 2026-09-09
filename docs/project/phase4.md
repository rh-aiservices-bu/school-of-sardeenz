# Phase 4 — SIF Runner Runtime (Apptainer)

## Implementation Status

All ten tasks are **implemented**. The artifacts split into two groups by how far they can be
verified off-cluster:

- **Fully verified here** (typecheck / lint / unit tests / contract validation / kustomize build):
  Task 4 (RunnerLauncher + ApptainerLauncher — 90 dev-worker tests green), Task 5 (vLLM shim — 12
  pytest cases green), Task 6 (contracts + regenerated types), Task 8 (`deployment/sif-runner`
  kustomize base builds), Task 7 (`scripts/build-sif.sh` + `deployment/librarian` kustomize base).
- **Cluster-gated** (written + statically validated, but only runnable on OpenShift 4.15+ / a GPU):
  Task 9 (`tests/gates/run-gates.sh` gate suite), the actual image builds (Tasks 2/3), the librarian
  SIF conversion, live worker admission under the SCC, and the kvcached co-tenancy (Gate 9) + CephFS
  perf re-run (Task 10 — see [`phase4-perf.md`](phase4-perf.md)). These are the acceptance items
  that must be exercised on the target cluster.

## Goal

Deliver engine runtimes as **Apptainer SIF files** on a shared RWX volume and run them from a
**production worker agent** inside an OpenShift Pod. A runner is started by `apptainer exec`-ing
the model's engine SIF (with GPU via `--nv`, weights bind-mounted, scratch writable); multiple
engine versions coexist, new SIFs hot-add without recycling the worker, and two runners can share
one GPU via kvcached.

This phase turns the Phase 4 feasibility spike (validated GO) into shipped artifacts: the
`containers/` image definitions, the SIF build/sign/convert pipeline, the worker security
posture, and the production worker agent's SIF-launch path.

**Read first (authoritative context):**

- [`phase4-apptainer-spike.md`](phase4-apptainer-spike.md) — the runbook + field findings +
  exact commands/manifests that this phase productionizes. Every design choice below traces to a
  spike gate or finding.
- [ADR-015](../architecture/adrs/adr-015-sif-runtime-packaging.md) — SIF runtime delivery
  (supersedes ADR-004).
- [ADR-016](../architecture/adrs/adr-016-sif-worker-security-posture.md) — the mild custom SCC +
  `/dev/fuse` + in-container userns posture.
- [ADR-017](../architecture/adrs/adr-017-runner-image-pipeline.md) — `containers/` layout +
  build/sign/convert pipeline + supply chain.
- [ADR-010](../architecture/adrs/adr-010-engine-runners.md) — the runner/worker hierarchy and
  runner contract (unchanged; the launch mechanism is what changes).

## Scope

### In scope

1. **`containers/` runner image definitions** — the base worker image and the first runner image
   (vLLM+kvcached), with a documented convention for adding more.
2. **SIF build/sign/convert pipeline** — a librarian Job/script that builds+signs the OCI image
   and converts it to a signed SIF on the module PVC.
3. **Worker security + shape** — the custom seccomp SCC, the `/dev/fuse` annotation, and the
   worker Deployment/Pod template (scratch, `/dev/shm`, module + weights mounts).
4. **Production worker agent — SIF launch** — the worker agent that runs in the worker Pod and
   starts runners via `apptainer exec` of the engine SIF, reusing the Phase 3.6 worker-agent
   management API, Redis self-registration, and runner contract.
5. **Contract touch-ups** — how the worker agent learns _which_ SIF to exec for a given
   runner type + version (module selector on the worker-agent API).
6. **Verification** — automate the spike's gates against the built artifacts; record perf on the
   target RWX backend.

### Out of scope

- **Autoscaling workers** — manual/Deployment provisioning initially.
- **Non-RWX / block storage** for the module store (the design is RWX-agnostic; block classes are
  a future option if idmapped mounts ever matter — see ADR-016).
- **GPU driver management** — assumes the NVIDIA GPU Operator on worker nodes.
- **Replacing the dev-worker stub path** (Phase 3.6) — it stays for containerless local dev; this
  phase adds the _production_ launch path alongside it.
- **Scoped seccomp profile via the Security Profiles Operator** — the ADR-016 hardening endgame;
  Phase 4 ships the mild `Unconfined` SCC and records SPO as follow-up.
- **Control-plane kvcached oversubscription / co-location policy (Phase 5).** The existing
  byte-budget placement sums `requiredMemory` per device with no oversubscription and no
  exclusivity lock. Phase 4 does **not** change it. Consequences to be explicit about:
  - The **decisive kvcached gate (Gate 9)** is validated by driving the **worker agent directly**
    (two runners on one GPU), exactly as the spike did — it does **not** depend on the control
    plane deciding to co-locate. That is sufficient for Phase 4 acceptance.
  - The **production** path — the control plane deliberately packing two kvcached-capable runners
    onto one device _past_ naive byte-sum capacity (kvcached's whole point: elastic, reclaimable
    usage) — needs new placement logic keyed on the `kvCacheElasticSharing` capability (Task 5).
    That, plus guarding against _silently_ co-locating two **non**-kvcached runners that would
    OOM a real GPU, is a **Phase 5 design item**. Phase 4 only adds the capability flag so Phase 5
    has something to key on.

## Dependencies

| Dependency                           | Status   | Notes                                                                                                                                      |
| ------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase 3.6 dev worker                 | Complete | Reuse: `runners/dev-worker` registration, management API, runner-manager, worker-agent contract                                            |
| Worker-agent API spec                | Complete | `packages/contracts/specs/worker-agent.yaml` — extend with a module selector (Task 6)                                                      |
| Engine runner contract               | Complete | `packages/contracts/specs/engine-runner.yaml` — the SIF's runner shim implements this                                                      |
| Phase 2 control plane                | Complete | Issues `POST/DELETE /runners`; byte-budget placement/eviction unchanged in Phase 4 (kvcached oversubscription is out of scope — see below) |
| Phase 1 proxy                        | Complete | Traffic shifting for zero-downtime version upgrades                                                                                        |
| OpenShift/OKD 4.15+ (tested on 4.21) | Cluster  | `/dev/fuse` annotation, `crun`, custom SCC rights                                                                                          |
| Shared RWX StorageClass              | Cluster  | Module store + weights; EFS proven, CephFS the target                                                                                      |
| GPU node(s) + NVIDIA GPU Operator    | Cluster  | For GPU runners and the kvcached gate                                                                                                      |

> **Platform caveat:** the `/dev/fuse` annotation needs no MachineConfig on **4.15+** (works on
> Managed OpenShift — ROSA/ARO — too). On clusters **older than 4.15** it requires a CRI-O
> MachineConfig, which Managed OpenShift forbids — so pre-4.15 Managed OpenShift is unsupported
> for this design (spike §1/§9.4). Sardeenz targets self-managed OpenShift/OKD 4.15+ with
> CephFS/ODF, so this is a documented constraint, not a blocker.

## Architecture

### Runtime model (what runs where)

```text
Worker Pod (containers/worker-base image: UBI + Apptainer + FUSE + tzdata)
│  SCC: apptainer-spike-seccomp (seccomp Unconfined, no privileged/caps)
│  annotation: io.kubernetes.cri-o.Devices=/dev/fuse
│  mounts: /modules (RWX, readOnly), /weights (RWX), /scratch (emptyDir), /dev/shm (Memory)
│
├── Worker agent  (long-lived; self-registers to Redis; POST/DELETE /runners)
│     └── on POST /runners → apptainer exec --nv --bind /weights \
│           --env <cache redirects> /modules/<engine>-<version>.sif <runner-entrypoint>
│               └── Runner shim (in the SIF) : serves the runner contract on :PORT
│                     └── Engine (vLLM+kvcached) : serves OpenAI traffic
└── … one exec per model, versions side by side …
```

Two build-time / run-time boundaries:

- **Build time (librarian/CI):** `containers/runners/<engine>/<version>/Containerfile` → OCI image
  (scanned, signed) → `apptainer build/pull` + `apptainer sign` → signed `.sif` on the module PVC.
- **Run time (worker):** worker agent `apptainer exec`s the SIF; `squashfuse` mounts it read-only
  and pages it in. No pull, no `mksquashfs`, no per-host copy.

### Design decisions baked in (traceable to the spike)

- **The runner shim lives inside the SIF**, not on the worker. `apptainer exec <sif>
<runner-entrypoint>` starts the shim, which starts the engine and serves the runner contract.
  This co-versions the shim with the engine and keeps the worker image engine-agnostic. The
  worker agent only needs to know the SIF path + the entrypoint + ports/binds.
- **The worker agent is the production counterpart of the Phase 3.6 dev worker.** Refactor a
  **`RunnerLauncher` interface** with two implementations: `StubLauncher` (Phase 3.6, forks a
  runner stub — dev) and `ApptainerLauncher` (this phase — `apptainer exec` of a SIF). Registration,
  the management API, heartbeat, and runner tracking are shared. Recommended: keep it TypeScript
  (reuse Phase 3.6 code) and add Node to `containers/worker-base`; the alternative (a small
  standalone Go/Rust agent) is viable but duplicates the Phase 3.6 logic — decide in Task 4.
- **In-container userns, not `hostUsers: false`** (ADR-016) — required for RWX volumes.
- **Conversion is a librarian job, never the serving worker** (ADR-017) — node-local scratch +
  memory headroom; the worker only execs.
- **Writable cache redirect** — app-derived runner images bake cache dirs under a read-only-in-SIF
  path (`/opt/app-root/src`); the launcher must set `XDG_CACHE_HOME`/`HF_HOME`/
  `FLASHINFER_WORKSPACE_DIR` to node-local `/scratch` (spike Gate 9d finding).
- **Writable HOME on node-local scratch.** The spike put `HOME` on the (then read-write) module
  PVC to give Apptainer a writable config/keys dir under the arbitrary OpenShift UID. The module
  PVC is now mounted **read-only**, so `HOME` must point at a writable node-local path — use
  `HOME=/scratch/home` (the `/scratch` `emptyDir`), created group-writable (gid 0) so the
  arbitrary UID can write. Do **not** pass HOME via `apptainer --env` (Apptainer rejects it); set
  it as a container env var.
- **Serialize runner cold-starts on a worker.** Two engines cold-starting concurrently each spike
  host RAM (torch + CUDA init + graph capture) and OOM-killed one in the spike (Gate 9c). The
  worker agent's `ApptainerLauncher` must **not** launch multiple `apptainer exec` cold-starts in
  parallel — start one, wait until it is serving, then start the next. This is a worker-agent
  orchestration requirement, not just memory-limit tuning.

### `containers/` layout (target)

```text
containers/
├── README.md              # the convention + build/sign/convert flow (Task 1)
├── worker-base/           # worker host image: UBI + Apptainer + FUSE + tzdata (Task 2)
│   ├── Containerfile
│   └── README.md
├── runner-vllm/           # runner image → becomes a SIF: base vLLM + kvcached (Task 3)
│   ├── Containerfile
│   └── README.md
├── control-plane/         # (existing) control-plane service image
└── dashboard/             # (existing) dashboard service image
```

Adding a runner type or version = a new `containers/runners/<engine>/<version>/` directory +
`Containerfile`; no easyconfig, no from-source stack.

## Implementation Plan

### Task 1: `containers/` convention doc

Document how runner images and SIFs are produced so any contributor can add an engine.

**Files to create:**

- `containers/README.md`

**Content:**

- The two image kinds: `worker-base` (the host that execs SIFs) vs. `runner-<engine>` (becomes a
  SIF). Point at ADR-015/016/017.
- The pipeline: `Containerfile` → CI build+scan+sign → librarian `apptainer build/pull` +
  `apptainer sign` → signed `.sif` on the module PVC (versioned filename, write-new-then-symlink).
- Naming: SIF filename convention `<engine>-<version>.sif`; how the worker agent maps a
  runnerType+version to a SIF path (Task 6).
- The worker security posture summary (link ADR-016) and the runtime prerequisites (4.15+, crun,
  RWX, `/dev/fuse` annotation).

### Task 2: `containers/worker-base/` image

The slim worker host image (materialize the spike §4 image).

**Files to create:**

- `containers/worker-base/Containerfile` — UBI9 + EPEL Apptainer (rootless, **not** `-suid`) +
  `fuse-overlayfs`/`squashfuse`/`fuse3` + `tzdata` + `ln -sf /usr/share/zoneinfo/Etc/UTC
/etc/localtime` (required — Apptainer bind-mounts `/etc/localtime` by default). If the
  production worker agent is TypeScript (Task 4), also install Node here.
- `containers/worker-base/README.md` — what it is, why `tzdata`/`/etc/localtime`, why rootless
  Apptainer, how it's built (`oc new-build`/CI), and the SCC/annotation it must run under.

**Verification:** builds in CI; `apptainer --version` runs; `/etc/localtime` present.

### Task 3: `containers/runners/vllm/0.21.0/` image (vLLM + kvcached)

The reference runner image that becomes the vLLM SIF. Derived from the v1
[`docker/Containerfile`](https://github.com/rh-aiservices-bu/sardeenz/blob/main/docker/Containerfile),
stripped to just the vLLM+kvcached stages (no Node/app).

**Files to create:**

- `containers/runners/vllm/0.21.0/Containerfile` — multi-stage: `FROM quay.io/vllm/vllm-cuda:<pinned>`;
  builder stage installs the CUDA devel toolchain + git and `pip wheel`s the pinned
  `github.com/ovg-project/kvcached` commit (`--no-build-isolation`, `LIBRARY_PATH` includes CUDA
  stubs); runtime stage `pip install`s the wheel and sets `ENV ENABLE_KVCACHED=true
KVCACHED_AUTOPATCH=1`. Include the **runner-entrypoint shim** (Task 5) or install it here.
- `containers/runners/vllm/0.21.0/README.md` — the base image tag, the pinned kvcached commit (and the
  rule: pin per vLLM version, re-run Gate 9 on bumps), the enablement env, and the cache-dir
  caveat (redirected at exec, not here).

**Verification:** builds in CI; `apptainer exec <sif> python3 -c "import vllm, kvcached"` works
after conversion (Task 7); Gate 9 kvcached sharing passes.

### Task 4: Production worker agent — launcher abstraction

Extract a `RunnerLauncher` interface from the Phase 3.6 worker agent and add the Apptainer
implementation, so the same agent runs stubs in dev and SIFs in prod.

**Files (recommended TS, reusing `runners/dev-worker`):**

- Refactor `runners/dev-worker/src/runner-manager.ts` to depend on a `RunnerLauncher` interface
  (`start(config) → {pid, host, port}`, `stop(runnerId)`), moving the current fork-stub logic into
  a `StubLauncher`.
- Add `ApptainerLauncher` that builds and runs the `apptainer exec` command:
  `apptainer exec --nv --bind /weights --env XDG_CACHE_HOME=/scratch/cache --env
HF_HOME=/scratch/cache/huggingface --env FLASHINFER_WORKSPACE_DIR=/scratch/cache/flashinfer
/modules/<engine>-<version>.sif <runner-entrypoint> --model /weights/<model> --port <PORT>`
  (kvcached env baked in the image; pass explicitly to be safe). Do **not** pass `--env HOME=…`
  (Apptainer rejects it — set `HOME=/scratch/home` as a container env instead). Handle SIGTERM →
  propagate to the exec (spike Gate 5: the inner process dies with the launcher, no orphan).
- **Serialize cold-starts** — the runner-manager must not run concurrent `apptainer exec`
  cold-starts on one worker (each spikes host RAM and OOM-killed a peer in spike Gate 9c). Start
  runners sequentially, waiting for each to become healthy before the next. (The `StubLauncher`
  path can stay concurrent; this constraint is specific to real engine cold-starts.)
- Package the production agent (new `runners/worker-agent/` entrypoint, or a `--mode=apptainer`
  flag on the existing agent) that selects `ApptainerLauncher`.
- **Decision to record:** language/packaging (reuse TS + Node-in-worker-base, vs. a standalone
  agent). Recommended: reuse TS.

**Verification:** unit tests for `ApptainerLauncher` command construction + SIGTERM propagation;
`StubLauncher` path still passes all Phase 3.6 tests.

### Task 5: Runner shim in the SIF (vLLM runner contract)

The engine-specific shim that runs _inside_ the SIF, exposes the runner contract
(`engine-runner.yaml`), and drives vLLM (start, `/health`, `/sleep`↔`/wake` via vLLM's own
endpoints, `/memory-report`, `/progress`, `/capabilities` incl. kvcached). This is the
production `runners/vllm` implementation.

**Files:** `runners/vllm/` — the shim + its packaging into `containers/runners/vllm/0.21.0/`.

**Notes:** reuse the runner contract shape validated by the Phase 3.6 stub; the real shim maps
those endpoints onto vLLM + kvcached. Sleep/wake uses vLLM's sleep levels.

**kvcached capability flag (contract convention):** `engine-runner.yaml`'s
`WorkerCapability.features` well-known keys today are `kvCacheOffload` (host-RAM KV offload — a
_different_ thing), `prefixCaching`, `streamingInference`, `chatTemplate`, `toolUse`. Add a new
well-known key for **elastic GPU-memory sharing across co-located runners** (e.g.
`kvCacheElasticSharing`) and have the vLLM shim declare it. Don't overload `kvCacheOffload`. This
is what a future control-plane oversubscription policy keys on (see Out of scope + Task 6).

### Task 6: Worker-agent contract — module/version selector

The worker agent must know _which_ SIF to exec. Extend the worker-agent API so `StartRunnerRequest`
carries the runtime module (e.g. `runtimeModule: "vllm-0.21"` or `runnerType` + `runnerVersion`),
resolved to `/modules/<...>.sif` by a documented convention.

**Files to modify:**

- `packages/contracts/specs/worker-agent.yaml` — add the module/version field(s) to
  `StartRunnerRequest`; regenerate types (`npm run codegen -w @sardeenz/types`, or root
  `npm run codegen`).
- `packages/contracts/specs/engine-runner.yaml` — add the `kvCacheElasticSharing` well-known
  feature key (Task 5) to the documented `WorkerCapability.features` set.
- Control plane placement/deploy path — populate the module field (which SIF a model's
  runnerType+version maps to). Keep back-compat with the dev-worker stub (it can ignore/echo the
  field). **Note:** this does _not_ change placement/oversubscription logic — see Out of scope.

**Validation:** `npm run validate -w @sardeenz/contracts`; types compile.

### Task 7: SIF librarian build/sign/convert pipeline

The job that turns a runner image into a signed SIF on the module PVC (ADR-017). Never runs on a
serving worker.

**Files to create:**

- `deployment/librarian/` — a Kubernetes `Job` (or CronJob) manifest that: mounts the module PVC
  **read-write** + a node-local `emptyDir` scratch (`APPTAINER_TMPDIR`/`CACHEDIR`, sized for one
  uncompressed image, ~50Gi) + memory request/limit (≥8Gi/16Gi — the spike OOM finding);
  `apptainer pull`/`build` the image → `.sif`; `apptainer sign` it; then **`chmod 644`** the SIF
  (world-readable — the librarian's write UID ≠ the worker's arbitrary read UID) and write it with
  a versioned filename via write-new-then-symlink.
- `scripts/build-sif.sh` (or a Makefile target) — the build+sign+publish steps, parameterized by
  image ref + output SIF name.

**SIF signing key management (this is new — ADR-013 governs only env-var app secrets, not
signing keypairs; see ADR-017):**

- Generate an Apptainer signing keypair (`apptainer key newpair`).
- The **private key** lives in a Kubernetes `Secret` mounted **only** into the librarian job
  (never on workers), imported into the job's keyring before `apptainer sign`.
- The **public key** is distributed to every worker (ConfigMap or Secret → `apptainer key
import` into the worker's keyring, or baked into `worker-base`) so the worker can
  `apptainer verify` at exec; `apptainer.conf` can require verification.
- Record a rotation approach (re-sign existing SIFs with a new key; roll the public key to
  workers before retiring the old one).

**Verification:** running the job produces a signed, world-readable `<engine>-<version>.sif` on
the PVC; a worker with the public key `apptainer verify`s it and refuses an unsigned/tampered SIF.

### Task 8: Worker security + Deployment manifests

The cluster-side shape from the spike (ADR-016), as reusable manifests.

> **Manifest format — decide first (this is the repo's FIRST K8s manifests).** `deployment/` is
> empty and `containers/control-plane|dashboard` ship only Dockerfiles, so there is no precedent
> to copy. Pick a format and namespace/naming convention before writing Task 7/8 manifests.
> _Recommended:_ a **Kustomize** base under `deployment/sif-runner/` (raw YAML is fine too; avoid
> Helm unless the project adopts it elsewhere). Record the choice at the top of `deployment/`.

**Files to create (under `deployment/`):**

- The custom seccomp SCC (`apptainer-spike-seccomp` → rename to a product name, e.g.
  `sardeenz-sif-runner`) + `oc adm policy add-scc-to-user` / RoleBinding to the worker SA.
- The worker `Deployment` template: `containers/worker-base` image, `seccompProfile: Unconfined`,
  `io.kubernetes.cri-o.Devices: "/dev/fuse"` annotation, **no** `hostUsers: false`, GPU limit,
  memory requests/limits, `fsGroup: 0`, `HOME=/scratch/home`, and mounts: `/modules` (RWX
  **readOnly**), `/weights` (RWX), `/scratch` (`emptyDir` sizeLimit; holds `APPTAINER_TMPDIR`,
  caches, and the writable `HOME`), `/dev/shm` (`emptyDir` medium: Memory). Create `/scratch/home`
  group-writable (gid 0) at start (init step or the agent) so the arbitrary UID can write it.
- **Module-PVC write protection — name the mechanism (RBAC alone does NOT gate mount mode).** Any
  pod that can reference the PVC can request `readOnly: false`; ServiceAccount RBAC does not
  restrict rw vs ro. Choose one and document it: (a) a **ValidatingAdmissionPolicy / Kyverno**
  rule that rejects Pods (other than the librarian SA) mounting the module PVC read-write; or
  (b) **two PVCs** — a librarian-only build/staging PVC and a separate module PVC that workers
  mount `readOnly` — with only the librarian's namespace/SA able to write the published one; or
  (c) accept it as a **documented convention** (worker Deployments authored by Sardeenz always
  set `readOnly: true`) if no admission controller is available. Do not leave it as a bare claim.
- A `ContainerRuntimeConfig` note/manifest to ensure `crun` if a node defaults to `runc` (§9.7).

> **SELinux / volume-label caveat (spike §12).** On some storage classes (NFS/EFS especially) the
> RWX volume can arrive with labels that block reads from the container context despite correct
> POSIX perms. If a worker gets "permission denied" reading a world-readable SIF, check the CSI
> driver's relabeling behavior and the SCC `seLinuxContext`. CephFS/ODF handles this more
> gracefully than plain NFS/EFS — verify on the target backend in Task 10.

**Verification:** a worker Pod admits under the SCC with `/dev/fuse` present; `apptainer exec`
runs unprivileged (spike Gates 0–3 against the real worker image); `HOME` is writable; the worker
cannot mount the module PVC read-write (per the chosen mechanism).

### Task 9: Integration tests — automate the spike gates

Turn the spike's gates into a repeatable suite runnable against a real cluster (gated on GPU).

**Coverage:**

- CPU gates (0–6): userns probe, build/exec a SIF, no-copy squashfuse (process check + zero
  scratch growth), weights via `--bind`, long-lived runner + clean SIGTERM, parallel/hot-add.
- GPU gates (7–9): `--nv` visibility, ipc/pid/net namespace sharing, **two runners + kvcached on
  one GPU** (the decisive gate) via the real worker agent + `ApptainerLauncher`.
- Gate 10 (measurement): cold/warm spawn + record on the target RWX backend.

**Gate:** `cluster-gpu` — skipped without a GPU cluster; CPU gates run on any 4.15+ cluster.

### Task 10: CephFS re-validation (perf) + docs/changelog

- Re-run the spike's Gate 9c/9d + Gate 10 on **CephFS/ODF** (the spike ran on EFS) and record the
  numbers; confirm idmap behavior is unchanged (in-container userns path is unaffected).
- Update `CHANGELOG.md`, `docs/project/README.md`, and `CLAUDE.md` project status for Phase 4.

## Task Summary

| #   | Task                                                  | Layer        | Primary artifacts                                          |
| --- | ----------------------------------------------------- | ------------ | ---------------------------------------------------------- |
| 1   | `containers/` convention doc                          | Docs         | `containers/README.md`                                     |
| 2   | `worker-base` image                                   | Containers   | `containers/worker-base/{Containerfile,README.md}`         |
| 3   | `runner-vllm` image (vLLM+kvcached)                   | Containers   | `containers/runners/vllm/0.21.0/{Containerfile,README.md}` |
| 4   | Worker agent launcher abstraction + ApptainerLauncher | Worker       | `runners/dev-worker` refactor + prod agent                 |
| 5   | vLLM runner shim (contract in the SIF)                | Runner       | `runners/vllm/`                                            |
| 6   | Worker-agent module selector                          | Contracts    | `packages/contracts/specs/worker-agent.yaml` + types       |
| 7   | SIF librarian build/sign/convert                      | Build/Deploy | `deployment/librarian/`, `scripts/build-sif.sh`            |
| 8   | Worker SCC + Deployment manifests                     | Deploy       | `deployment/` (SCC, worker Deployment, RBAC)               |
| 9   | Integration tests (spike gates)                       | Tests        | cluster gate suite                                         |
| 10  | CephFS re-validation + docs                           | Docs/Verify  | CHANGELOG, README, CLAUDE.md, perf record                  |

## Acceptance Criteria

### Images & pipeline

- [ ] `containers/worker-base` and `containers/runners/vllm/0.21.0` build in CI
- [ ] The librarian job converts the vLLM+kvcached image to a **signed** SIF on the module PVC,
      using node-local scratch and adequate memory (no OOM)
- [ ] The SIF is world-readable (`chmod 644`) and workers mount the module PVC `readOnly`; worker
      write-access to the module PVC is prevented by the chosen mechanism (Task 8) or documented as
      convention

### Worker & launch

- [ ] A worker Pod admits under the custom SCC with `/dev/fuse` present; `apptainer exec` runs
      unprivileged (Gates 0–3 against the real `worker-base`)
- [ ] The production worker agent starts a vLLM runner by `apptainer exec` of a SIF, reads weights
      via `--bind`, serves OpenAI traffic, and drains cleanly on SIGTERM (no orphan/zombie)
- [ ] Cache dirs are redirected to `/scratch`; no read-only-SIF cache failures
- [x] The dev-worker stub path (Phase 3.6) still passes all its tests (shared launcher interface)

### Two-port routing end-to-end (#77 re-verification)

The two-port (management vs engine) runner model is implemented and unit-tested; this item re-verifies it on a live GPU deployment — the exact reproduction from #77:

- [ ] Deploy a vLLM model, wait for `ACTIVE`, then `POST /v1/chat/completions` through the proxy returns a **real completion** (not `{"detail":"Not Found"}`)
- [ ] `HGET sardeenz:routing-map <model>` shows the **engine** port (not the management port) as the endpoint
- [ ] `GET /v1/models` through the proxy still lists the model
- [ ] sleep → wake → infer still resolves (the persisted `runnerEnginePort` path re-registers the same engine endpoint)

### Multi-version & GPU

- [ ] Two engine versions run side-by-side; a new SIF hot-adds with no Pod restart (Gate 6)
- [ ] GPU visible inside the SIF via `--nv` (Gate 7); ipc/pid/net shared across the SIF (Gate 8)
- [ ] **Two runners share one GPU via kvcached** through the worker agent (Gate 9) — elastic, not
      static split
- [ ] Worker verifies the SIF signature at exec

### Supply chain & perf

- [ ] SIFs are signed at build and verified at exec; the public key is distributed to workers
- [ ] Runtime perf recorded on the target RWX backend (CephFS re-run recorded; EFS numbers from
      the spike retained as the floor)

### Quality

- [x] `npm run lint` / `npm run typecheck` pass; OpenAPI specs valid; generated types compile
- [x] Integration gate suite authored (`tests/gates/run-gates.sh`); _running_ it is cluster-gated
      (CPU gates on any 4.15+ cluster; GPU gates on a GPU cluster)

## Decisions already made (proceed on these; recorded here so they aren't re-litigated)

- **Worker agent = TypeScript, reusing the Phase 3.6 dev worker** via a `RunnerLauncher`
  interface (`StubLauncher` dev, `ApptainerLauncher` prod). Add Node to `worker-base`. Rationale:
  avoids duplicating Phase 3.6 registration/management/heartbeat.
- **Runner shim lives in the SIF** (co-versioned with the engine; worker agent stays
  engine-agnostic). Until the shim exists, the `ApptainerLauncher` invokes `vllm serve` directly
  (Task 3's Containerfile already defers the shim — see its TODO).
- **Module selection = explicit `runtimeModule` field** on `StartRunnerRequest`, resolved to a
  `/modules/<...>.sif` path by convention (Task 6).
- **Task ordering:** Task 3 ships the runner image without the shim (worker agent uses `vllm serve`);
  Task 5 adds the shim and updates the Containerfile entrypoint. Task 8's manifest-format choice
  (Kustomize base recommended) precedes writing Task 7/8 manifests.

## Open Questions (genuinely undecided)

- **Module-PVC write protection mechanism** — ValidatingAdmissionPolicy/Kyverno vs. two-PVC split
  vs. documented convention (Task 8). Depends on what admission tooling the target cluster has.
- **SIF cold-start prefetch** — optional `initContainer` `cp` of the SIF to a node-local
  `emptyDir` for latency-critical cold starts (spike §12) — measure against Gate 10 before
  adopting.

## References

- [Phase 4 Apptainer spike](phase4-apptainer-spike.md) — runbook, gates, findings, manifests
- [ADR-015](../architecture/adrs/adr-015-sif-runtime-packaging.md) · [ADR-016](../architecture/adrs/adr-016-sif-worker-security-posture.md) · [ADR-017](../architecture/adrs/adr-017-runner-image-pipeline.md) · [ADR-010](../architecture/adrs/adr-010-engine-runners.md) · [ADR-004](../architecture/adrs/adr-004-highlander-runtime.md) _(superseded)_
- [Architecture overview — Runtime Delivery (Apptainer SIF)](../architecture/overview.md#runtime-delivery--apptainer-sif)
- [Worker-agent contract](../../packages/contracts/specs/worker-agent.yaml) · [Engine runner contract](../../packages/contracts/specs/engine-runner.yaml)
- [Phase 3.6 dev worker](phase3.6.md) — the worker-agent management API, registration, runner-manager to reuse
- v1 [`docker/Containerfile`](https://github.com/rh-aiservices-bu/sardeenz/blob/main/docker/Containerfile) — reference for the kvcached vLLM image
