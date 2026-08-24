# Phase 4 Feasibility Spike — Apptainer / SIF runners on OpenShift (v3)

> **v3 changelog (what changed and why)**
>
> - **Re-targeted at OpenShift 4.21, then corrected by field results.** 4.21 ships
>   purpose-built SCCs (`restricted-v3`, **`nested-container`**) with pod-level user
>   namespaces (`userNamespaceLevel: RequirePodLevel`) — the "Kubernetes-native" way to run a
>   container runtime in a Pod. **But that path proved unusable for our shared-CephFS design**
>   (field finding below), so the spike deploys onto the **network-FS-compatible path** instead: a
>   custom seccomp SCC permitting `Unconfined` + the `/dev/fuse` CRI-O annotation, with
>   **Apptainer creating its own user namespace inside the container** (rootless nested, no
>   pod-level userns). We no longer climb from `restricted-v2` — the §9 matrix records what
>   won't work so we don't test it.
> - **Storage goal is RWX-agnostic.** The aim is to run on **any RWX volume**, not one FS. This
>   run used **AWS EFS (NFSv4)** — a first-class proof point (CephFS is a priority follow-up,
>   needs another cluster). EFS mounts via the efs-csi TLS `stunnel` as `127.0.0.1:/… nfs4`.
>   Findings below are network-FS-general; per-backend perf/idmap are worth re-checking but
>   don't gate the general result (see the storage-goal note in §2).
> - **Field finding (confirmed on a live 4.21 cluster):** `hostUsers: false` + a network RWX
>   PVC (EFS/NFSv4 here) fails at container create with `mount_setattr … doesn't support idmap
mounts on this kernel` — pod-level userns needs idmapped volume mounts that NFS/EFS (and
>   CephFS on current RHCOS kernels) can't provide, and `nested-container` _requires_ pod-level
>   userns. The in-container-userns path (above) sidesteps it and was verified: Gate 0
>   fingerprint clean (`Seccomp: 0`, `max_user_namespaces > 0`, `/dev/fuse` present) and Gate 1
>   passed (`unshare --user --map-root-user` → `uid=0(root)`). See §9.3.
> - **Field finding — OCI→SIF conversion scratch must be node-local, not the RWX volume.** The
>   hardlink-heavy OCI rootfs unpack fails on a network-FS `APPTAINER_TMPDIR` (observed on
>   EFS/NFSv4) with `unpriv.link … too many links` (EMLINK). §5/§8 put
>   `APPTAINER_TMPDIR`/`CACHEDIR` on a node-local `scratch` `emptyDir`; the finished SIF still
>   lands on the RWX module store. Execution (squashfuse) unpacks nothing, so exec-only workers
>   need little scratch — heavy builds belong in a librarian job.
> - **Field finding — `worker-base` must ship `/etc/localtime`.** Apptainer bind-mounts
>   `/etc/localtime`/`/etc/hosts` by default; stock UBI9 has neither, so `apptainer exec` fails
>   with `mount source /etc/localtime doesn't exist`. §4 now installs `tzdata` and symlinks
>   `/etc/localtime` (quick unblock: `apptainer exec --no-mount bind-paths`). Gate 2 passes
>   after both fixes.
> - **Method correction — Gate 3 no-copy evidence.** The `squashfuse_ll` mount lives in
>   Apptainer's **session mount namespace**, and the container root is a read-only `overlay`
>   whose `lowerdir` is that squashfuse rootfs — so it's invisible in _both_ the parent shell's
>   and the container's own `/proc/mounts`, and the old grep false-reports "no mount." Gate 3
>   now proves no-copy via the running `squashfuse_ll` process (serving the SIF read-only via
>   an fd) + zero scratch growth across many runs. Confirmed on OKD 4.21: SIF runs in place off
>   the shared volume, no per-run copy.
> - **Confirmed — the RWX volume was AWS EFS (NFSv4).** `/runner` mounts as `nfs4` via the
>   efs-csi localhost `stunnel` (`127.0.0.1:/…`), which explains the idmap and hardlink findings
>   and means perf gates (9c/10) are **NFS-grade**. Good news for the RWX-agnostic goal: it
>   works on a real, common RWX class. Re-run perf per additional backend you plan to support.
> - **The workload is now a `Deployment`, not a bare `Pod`** — so you can scale to 0 / back
>   to 1 to stop/start, edit the template and re-roll, and keep a stable name for `oc rsh`.
> - **`/dev/fuse` needs no device plugin on 4.21** — on OpenShift/OKD 4.15+ it is exposed by
>   the pod annotation `io.kubernetes.cri-o.Devices: "/dev/fuse"` (and is available by default
>   on recent releases). We removed the earlier device-plugin prerequisite; direct SIF mount
>   (the no-copy promise, Gate 3) is impossible without `/dev/fuse`, so the annotation is set
>   on both Deployments and verified in Gate 0.
> - **Storage guidance folded in** (§12): SIFs world-readable under user-namespace UID
>   mapping, scratch kept off the network volume, SELinux/label caveats, versioned filenames
>   - write-new-then-symlink so in-flight SIFs aren't replaced under running pods, and the
>     librarian-writes / consumer-reads-`readOnly` split for production.
>
> **What carried over from v2:** the seccomp reasoning (why `restricted-v2` can't do userns),
> Gate 3's mount-backend evidence standard, the three GPU gates (namespace-sharing, kvcached
> co-tenancy, realistic cold-start/fan-out), Gate 5's signal/zombie checks, and §13's
> comparison against `zstd:chunked` / ImageVolumes.

## How this fits the architecture (start here after a context reset)

This document is the **feasibility spike** (can we, and at what cost). The decisions it produced
and the implementation plan live in the canonical docs — read these together:

- **Decisions (ADRs):**
  [ADR-015](../architecture/adrs/adr-015-sif-runtime-packaging.md) — SIF runtime delivery
  (supersedes [ADR-004](../architecture/adrs/adr-004-highlander-runtime.md) Highlander/EasyBuild);
  [ADR-016](../architecture/adrs/adr-016-sif-worker-security-posture.md) — the mild custom SCC +
  `/dev/fuse` + in-container userns posture;
  [ADR-017](../architecture/adrs/adr-017-runner-image-pipeline.md) — `containers/` +
  build/sign/convert pipeline;
  [ADR-010](../architecture/adrs/adr-010-engine-runners.md) — the runner/worker hierarchy +
  contract (unchanged; only the launch mechanism changes).
- **Architecture:** [`overview.md` → Runtime Delivery (Apptainer SIF)](../architecture/overview.md#runtime-delivery--apptainer-sif).
- **Implementation plan:** [`phase4.md`](phase4.md) — the autonomously-implementable task
  breakdown built from this spike's findings.
- **Contracts:** [`worker-agent.yaml`](../../packages/contracts/specs/worker-agent.yaml) (start/stop
  runners) and [`engine-runner.yaml`](../../packages/contracts/specs/engine-runner.yaml) (the
  contract the SIF's runner shim serves).
- **Code to adapt:** [`runners/dev-worker`](../../runners/dev-worker) (Phase 3.6 — worker-agent
  management API, Redis registration, runner-manager to reuse via a launcher abstraction),
  [`runners/vllm`](../../runners/vllm) (the vLLM runner shim), and
  [`containers/`](../../containers) (`worker-base` + `runner-vllm` image definitions).

## Background — what we're ultimately trying to do

Sardeenz runs AI inference engines (vLLM, Triton, MLServer, …) as **runners** — one process
per model, on a **worker** (a Pod with GPUs). The open question for **Phase 4** is purely
about _how the engine's software gets onto the worker_:

- **The usual way — bake the engine into a container image.** Painful: images are 10–20 GB,
  cold starts wait on the pull, every version bump is a rebuild, and running two versions
  side by side (canary / A-B) means two full deployments. Each host also has to pull and
  store a local copy.
- **The HPC way our architecture originally proposed — EasyBuild + Lmod modules on CephFS.**
  Great runtime story, but it means owning a from-source compilation stack and authoring
  build recipes for every engine/version. That's a heavy lift for whoever provisions a runner.

**What we actually want:** treat an engine runtime like a _module you drop onto a shared
volume and point a launcher at_ — no per-host copy, no rebuild-the-world, versions living
side by side, and new runtimes added **without recycling worker Pods**.

**The idea this spike tests:** package each runtime as an **Apptainer SIF** (a single
squashfs file = a whole container image in one file), keep those SIFs on **any shared RWX
volume** (CephFS, AWS EFS, …), and have the worker **execute them in place** with
`apptainer exec`. In
this model a "runner module" is just a `.sif` file:

```
/runner/vllm-0.20.sif      apptainer exec --nv /runner/vllm-0.20.sif  <serve cmd>
/runner/vllm-0.25.sif      apptainer exec --nv /runner/vllm-0.25.sif  <serve cmd>
/runner/mlserver.sif       apptainer exec --nv /runner/mlserver.sif   <serve cmd>
```

If it works, we get container-level packaging convenience (build any image, convert to SIF —
**no EasyBuild required**) _and_ the HPC runtime benefits (shared storage, no local copy,
hot-swappable versions), and — because a SIF is one squashfs file — we sidestep the CephFS
metadata-storm problem that plagues running a Python runtime directly off network storage.

## What this test intends to prove — or disprove

The whole approach hinges on one thing: **can an unprivileged process run Apptainer inside an
OpenShift Pod on the platform's supported user-namespace path?** OpenShift's _default_ posture
(`restricted-v2`: non-root, arbitrary UID, no privilege escalation, **seccomp
`RuntimeDefault`**) deliberately blocks the user-namespace / FUSE machinery Apptainer needs —
that's not in question, the 4.21 capability matrix already settles it (§9). The way we opt in
that works with a shared network RWX PVC is a **custom seccomp SCC** (permitting `Unconfined`) +
the `/dev/fuse` CRI-O annotation, letting **Apptainer create its own userns inside the
container** — _not_ `hostUsers: false`, which breaks network RWX mounts (§5 field finding, §9.3).
So this spike answers, concretely:

1. **Can we run a SIF at all** on that path, and **is that privilege cost acceptable for a
   product default?** (The landing zone is the `apptainer-spike-seccomp` SCC + `/dev/fuse`
   annotation, no `hostUsers`/`procMount`/added-caps/privileged; the interesting questions are
   whether that suffices and whether it can be trimmed further — the failure case is "needs
   `privileged` anyway.")
2. **Does it run in place off the shared volume** with **no local copy** to the host?
3. **Can a runner read model weights** from a bind-mounted volume, and stay up as a
   **long-lived HTTP service** that shuts down cleanly on SIGTERM (the shape a real runner
   and its runner-manager need)?
4. **Can multiple versions coexist**, and can we **add a new module live** without restarting
   the Pod?
5. **Does GPU access survive** (`apptainer --nv`) inside the SIF?
6. **Do SIF-launched processes still share the namespaces kvcached needs** (IPC/PID), and can
   **two runners actually share one GPU with kvcached** — the Sardeenz-defining feature?
7. **Is cold start with a real 10–20 GB engine SIF actually faster** than an image pull, and
   does it hold up when several workers fan out from the same SIF on a shared RWX volume?

> **Prediction, updated with field results:** on the network-FS-compatible path (custom seccomp
> SCC + `/dev/fuse` annotation, in-container userns, no `hostUsers: false`) **Gate 0 and Gate 1
> passed on a live 4.21 cluster** — clean fingerprint (`Seccomp: 0`, `max_user_namespaces >
0`, `/dev/fuse` present) and `unshare --user --map-root-user` → `uid=0(root)`. So "does
> userns work" is settled; the remaining open risks are: (a) does direct SIF mount actually use
> squashfuse and not fall back to extraction (Gate 3), (b) does GPU + kvcached survive the SIF
> boundary (Gates 8–9), and (c) does cold-start economics beat an image pull (Gate 10). We do
> **not** re-test `restricted-v2` for userns, nor `hostUsers: false` on the network RWX volume
> — §9 records both as known-fails.

**Bottom line it delivers:** a go / no-go on building Phase 4 on Apptainer/SIF, and — if it's
"go" — the **exact SCC + Pod securityContext** required. On a network RWX volume that turned
out to be a custom seccomp SCC (seccomp `Unconfined`) + the `/dev/fuse` annotation — a _mild_
SCC (no capabilities, no privileged), but a **custom one**, not a stock/shipped SCC, since
`nested-container` can't be used with network RWX-backed volumes here. If it's a "no-go," the gates
tell us _where_ it broke so we can pivot (§13: `zstd:chunked` lazy pulls, ImageVolumes,
bubblewrap, EasyBuild modules).

**Goal of the runbook below:** find out whether we can run engine runtimes as **Apptainer SIF
images** mounted from a shared RWX volume inside an **OpenShift** Pod — with no per-host copy,
multiple versions in parallel, GPU access, kvcached-compatible process semantics, and dynamic
add of new modules without recycling the Pod.

The spike is **fail-fast**: each gate isolates one risk. We deploy onto the network-FS-compatible
path up front (§5), so a gate failing there is a real signal, not a rung to climb — stop and
jump to the **Playbook** (§9), which also documents how to _trim_ privileges to find the true
minimum. The single most important thing to record is **the SCC + securityContext** each gate
actually needs — that decides whether this is a mild-SCC product default or a lab trick.

---

## 0. How to read this guide

Every command block is tagged with where to run it:

- `# [LAPTOP]` — your workstation, logged into the cluster with `oc`.
- `# [POD]` — a shell **inside** the test Pod (you get there with `oc rsh` in Step 5).

Copy the whole block. Blocks are ordered; run them top to bottom.

Gates 0–6 need no GPU. Gates 7–10 run in a separate GPU Pod (§8). Gates 9–10 are the
heavyweight, Sardeenz-specific gates — budget most of your wall-clock time there.

---

## 1. Prerequisites

`# [LAPTOP]`

```bash
# You need the OpenShift CLI and an active login with rights to create a project,
# PVCs, builds, and (for the escalation steps) SCCs.
oc version            # any recent 4.x client is fine
oc whoami             # confirm you are logged in
oc whoami --show-console   # sanity: right cluster?
```

You do **not** need Docker/Podman or Apptainer on your laptop — the worker image is built
**in-cluster**, and the SIFs are built **inside the Pod**.

You **do** need:

- **OpenShift 4.15+** (tested on OKD **4.21**). The `/dev/fuse` annotation needs 4.15+; the
  in-container-userns approach only needs the kernel to permit unprivileged user namespaces
  (`/proc/sys/user/max_user_namespaces > 0`, checked in Gate 0).
- Rights to **create a custom SCC** (the runbook creates `apptainer-spike-seccomp` in §5) and
  bind it to the project's service account. Note: the shipped **`nested-container` SCC is
  _not_ used** — it requires pod-level user namespaces (`hostUsers: false`), which break
  network RWX PVC mounts (no idmapped mounts on NFS/EFS, nor CephFS on current RHCOS kernels)
  (§5 field finding, §9.3).
- **`crun` as the container runtime** (it's the default on modern 4.x and is the runtime with
  userns support). Verify, and if a node still defaults to `runc`, set it via a
  `ContainerRuntimeConfig` (see §9.7) before running the gates.
- **`/dev/fuse` access — no device plugin needed on 4.21.** On OpenShift/OKD **4.15+**,
  `/dev/fuse` is exposed to an unprivileged Pod simply by the annotation
  `io.kubernetes.cri-o.Devices: "/dev/fuse"` (it's even available by default on recent
  releases). Without `/dev/fuse`, _direct SIF mount_ (Gate 3, the no-copy promise) cannot work
  — only extraction. §5/§8 set the annotation; Gate 0 verifies the device appears. (On
  clusters older than 4.15, an admin must first allow it via a CRI-O MachineConfig — see §9.4.
  This whole mechanism is unavailable on Managed OpenShift — ROSA/ARO — which forbids custom
  MachineConfigs; on 4.15+ the annotation still works there since no MachineConfig is needed.)
- A shared **RWX** StorageClass on the cluster (for the module store + weights). The goal is
  RWX-agnostic; this spike run used **AWS EFS** (NFSv4), a first-class proof point (CephFS is a
  priority follow-up on another cluster) — see the storage-goal note in §2.
- For the GPU gates (§8): at least one GPU node with the NVIDIA GPU Operator installed.
- **Egress from Pods to `docker.io`, `registry.access.redhat.com`, `quay.io` (the Gate 9
  vLLM image) and (for Gates 9–10) `huggingface.co`.** On a disconnected cluster, mirror the
  images into the internal registry first and adjust the `apptainer pull docker://…` URIs
  accordingly — Apptainer reads registry credentials from `APPTAINER_DOCKER_USERNAME` /
  `APPTAINER_DOCKER_PASSWORD` or `apptainer remote login` if the registry/mirror needs auth.

> **UID-range caveat (only relevant to the unused `hostUsers: false` path):** _pod-level_ user
> namespaces require the project's `openshift.io/sa.scc.uid-range` to fit in ≤ 65535. Our
> in-container-userns path doesn't hit this (Apptainer uses single-UID mapping), so you can
> ignore it unless you experiment with `hostUsers: false` — see §9.8.

---

## 2. Set variables (run once per shell)

`# [LAPTOP]`

```bash
export PROJECT=apptainer-spike
export RUNNER_PVC=runner-modules     # RWX volume that holds the .sif "modules"
export WEIGHTS_PVC=model-weights     # RWX volume that stands in for model weights

# Find your RWX StorageClass name and paste it below:
oc get storageclass
export RWX_SC=ocs-storagecluster-cephfs   # <-- EDIT to match your cluster

# Internal registry path for the image we build in Step 4 (usually correct as-is):
export IMAGE=image-registry.openshift-image-registry.svc:5000/${PROJECT}/worker-base:latest
```

> **Storage goal — RWX-agnostic — read this.** The aim is for Sardeenz to run SIF runners on
> **any RWX volume** it's given, not one specific filesystem. CephFS (Highlander on ODF) is a
> priority backend, but not the only one. **This spike run was executed on AWS EFS** (an
> `efs.csi` RWX class), which mounts as **NFSv4 over a localhost `stunnel` proxy**
> (`127.0.0.1:/…` — that's why the mount table shows `nfs4`). EFS is therefore a _first-class
> proof point_, not a stand-in: passing here proves the approach on a real, common RWX class.
> The findings are deliberately written as **network-FS-general** and hold for any NFS-class RWX
> (incl. EFS, and CephFS on current RHCOS kernels): unprivileged userns works, `hostUsers:
false` fails (no idmapped mounts), the OCI→SIF unpack must use node-local scratch, and
> squashfuse runs the SIF in place. **Worth re-checking per backend** (desirable follow-up, not
> a blocker for the general result): (a) whether a newer-kernel CephFS + CSI supports idmapped
> mounts (which would re-open the `nested-container`/`hostUsers` path _on that backend_), and
> (b) **Gate 10 economics per FS** — EFS is NFS-grade; CephFS/ODF may do better (Fable's point),
> so treat EFS cold-start numbers as a solid-but-not-best-case data point. CephFS validation
> needs a separate cluster.
>
> Any **RWX** class works for gates 0–7; "no local copy" (Gate 3) and the fan-out measurement
> (Gate 10) are only meaningful on a real shared FS.

---

## 3. Create the project and the shared volumes

`# [LAPTOP]`

```bash
oc new-project ${PROJECT} 2>/dev/null || oc project ${PROJECT}
```

`# [LAPTOP]`

```bash
# Module store (RWX): where the final .sif files live and are executed from.
# NOTE: the OCI->SIF *conversion* scratch (cache + unpack tmp) does NOT go here — it must be
# node-local (an emptyDir), because a network RWX FS breaks the hardlink-heavy OCI unpack
# (observed on EFS/NFSv4; see §5/§12). This PVC only holds finished SIFs, so 80Gi is room for
# several real-engine versions. RWX PVCs are typically expandable — if you run out, bump
# spec.resources.requests.storage.
cat <<EOF | oc apply -f -
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ${RUNNER_PVC}
  namespace: ${PROJECT}
spec:
  accessModes: ["ReadWriteMany"]
  storageClassName: ${RWX_SC}
  resources:
    requests:
      storage: 80Gi
EOF
```

`# [LAPTOP]`

```bash
# Fake "model weights" volume (RWX). 20Gi leaves room for a small real model in Gate 9.
cat <<EOF | oc apply -f -
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ${WEIGHTS_PVC}
  namespace: ${PROJECT}
spec:
  accessModes: ["ReadWriteMany"]
  storageClassName: ${RWX_SC}
  resources:
    requests:
      storage: 20Gi
EOF
```

`# [LAPTOP]`

```bash
oc get pvc -n ${PROJECT}     # both should reach STATUS=Bound
```

---

## 4. Build the `worker-base` image (Apptainer inside a UBI container)

This is the first real content for `containers/worker-base/`. We build it **in-cluster** so
you need no local container tooling.

`# [LAPTOP]`

```bash
mkdir -p /tmp/worker-base && cd /tmp/worker-base
cat > Containerfile <<'EOF'
FROM registry.access.redhat.com/ubi9/ubi:latest

# EPEL provides apptainer + fuse helpers on UBI9.
RUN dnf install -y https://dl.fedoraproject.org/pub/epel/epel-release-latest-9.noarch.rpm && \
    dnf install -y \
      apptainer \
      fuse-overlayfs \
      squashfuse \
      fuse3 \
      shadow-utils \
      procps-ng \
      iproute \
      strace \
      jq \
      tzdata \
      ca-certificates && \
    ln -sf /usr/share/zoneinfo/Etc/UTC /etc/localtime && \
    dnf clean all

# NOTE: we install "apptainer" (rootless), NOT "apptainer-suid".
# The whole point of the spike is to see how far the unprivileged path gets.
# strace/jq are diagnostics for Gates 3–4.
# tzdata + the /etc/localtime symlink are REQUIRED: Apptainer bind-mounts /etc/localtime
# (and /etc/hosts) into every container by default, and the stock UBI9 base ships neither,
# so `apptainer exec` fails with "mount source /etc/localtime doesn't exist" without this.

CMD ["sleep", "infinity"]
EOF
```

`# [LAPTOP]`

```bash
# Create a binary Docker-strategy build and run it from the current dir.
oc new-build --name worker-base --binary --strategy=docker -n ${PROJECT} 2>/dev/null || true
oc start-build worker-base --from-dir=. --follow -n ${PROJECT}
```

`# [LAPTOP]`

```bash
oc get istag worker-base:latest -n ${PROJECT}   # confirm the image tag exists
```

---

## 5. Deploy the test workload as a `Deployment`

> **Test substrate:** this run used **AWS EFS (NFSv4)** as the RWX volume (Phase 4 targets
> CephFS — see the §2 test-env note). Everything below is network-FS-general.
>
> **Field finding (recorded during this spike): don't use `hostUsers: false` with a network
> RWX PVC.** `hostUsers: false` puts the whole Pod in a Kubernetes user namespace, and the
> kubelet then has to bring every volume in via **idmapped mounts**. NFS/EFS doesn't support
> that (nor does CephFS on current RHCOS kernels), so mounting the RWX PVC fails hard at
> container create:
> `mount_setattr /runner (… doesn't support idmap mounts on this kernel): Invalid argument`.
> The `nested-container` SCC _requires_ pod-level userns (`userNamespaceLevel:
RequirePodLevel`), so it's unusable for our shared-RWX design on this platform. See §9.3.

So we deploy onto the **network-FS-compatible path**: a **custom seccomp SCC** that permits
`seccompProfile: Unconfined` + the `/dev/fuse` CRI-O annotation, and we let **Apptainer create
its own user namespace _inside_ the container** (rootless nested) rather than a pod-level one.
The container stays in the host userns, so the network RWX PVC mounts normally. This clears
`restricted-v2`'s only real blocker (its `RuntimeDefault` seccomp filter) without any added
capability, `procMount`, `hostUsers`, or privileged. A writable `HOME`/cache/tmp on the RWX
PVC keeps Apptainer's working dirs writable under the arbitrary OpenShift UID, and a
memory-backed `/dev/shm` is provided up front (vLLM needs it in Gate 9).

Using a **`Deployment`** (not a bare Pod) is deliberate: you can `oc scale … --replicas=0/1`
to stop/start the environment, edit the template and re-roll, and keep a stable name for
`oc rsh`.

**Create the seccomp SCC and grant it to the workload's service account first** (this is the
§9.1 SCC — `restricted-v2` with the single change of permitting `unconfined` seccomp; no added
capabilities, no `RunAsAny`, no privilege escalation):

`# [LAPTOP]`

```bash
cat <<'EOF' | oc apply -f -
apiVersion: security.openshift.io/v1
kind: SecurityContextConstraints
metadata:
  name: apptainer-spike-seccomp
allowHostDirVolumePlugin: false
allowHostIPC: false
allowHostNetwork: false
allowHostPID: false
allowHostPorts: false
allowPrivilegeEscalation: false
allowPrivilegedContainer: false
allowedCapabilities: [NET_BIND_SERVICE]
requiredDropCapabilities: [ALL]
fsGroup:            { type: MustRunAs }
runAsUser:          { type: MustRunAsRange }
seLinuxContext:     { type: MustRunAs }
supplementalGroups: { type: RunAsAny }
seccompProfiles: [runtime/default, unconfined]
readOnlyRootFilesystem: false
volumes: ["configMap","csi","downwardAPI","emptyDir","ephemeral","persistentVolumeClaim","projected","secret"]
users: []
groups: []
EOF

oc adm policy add-scc-to-user apptainer-spike-seccomp -z default -n ${PROJECT}
```

`# [LAPTOP]`

```bash
cat <<EOF | oc apply -f -
apiVersion: apps/v1
kind: Deployment
metadata:
  name: spike
  namespace: ${PROJECT}
  labels: { app: apptainer-spike }
spec:
  replicas: 1
  selector:
    matchLabels: { app: apptainer-spike }
  template:
    metadata:
      labels: { app: apptainer-spike }
      annotations:
        io.kubernetes.cri-o.Devices: "/dev/fuse"   # 4.15+: exposes /dev/fuse, no device plugin
    spec:
      # NO hostUsers: false — it forces idmapped volume mounts the network RWX FS can't do (§9.3).
      # Apptainer creates its own user namespace inside the container instead.
      containers:
        - name: worker
          image: ${IMAGE}
          command: ["sleep", "infinity"]
          securityContext:
            seccompProfile: { type: Unconfined }   # THE unlock: no RuntimeDefault filter
            allowPrivilegeEscalation: false
          env:
            - { name: HOME,                value: /runner/home }
            # Conversion scratch MUST be node-local — see the field finding note below.
            - { name: APPTAINER_TMPDIR,    value: /scratch }
            - { name: APPTAINER_CACHEDIR,  value: /scratch/cache }
          volumeMounts:
            - { name: runner,  mountPath: /runner }
            - { name: weights, mountPath: /weights }
            - { name: scratch, mountPath: /scratch }
            - { name: dshm,    mountPath: /dev/shm }
      volumes:
        - name: runner
          persistentVolumeClaim: { claimName: ${RUNNER_PVC} }
        - name: weights
          persistentVolumeClaim: { claimName: ${WEIGHTS_PVC} }
        - name: scratch
          # Node-local (disk-backed) scratch for OCI->SIF conversion. NOT medium: Memory —
          # unpacking a 10-20 GB engine image (Gate 9) would blow up RAM. Sized to hold one
          # uncompressed engine image; the node needs this much ephemeral storage free.
          emptyDir: { sizeLimit: 50Gi }
        - name: dshm
          emptyDir: { medium: Memory }
EOF
```

> **Field finding — conversion scratch must be node-local, not on the RWX volume.** Building a
> SIF (`apptainer pull`/`build`) unpacks the OCI rootfs into `APPTAINER_TMPDIR`, and that unpack
> is hardlink-heavy (e.g. BusyBox's `/bin` is hundreds of applets hardlinked to one binary). On
> a network-FS `APPTAINER_TMPDIR` (observed on **AWS EFS/NFSv4** here) the rootless unpacker
> fails with `unpriv.link … too many links` (EMLINK). So `APPTAINER_TMPDIR`/`CACHEDIR` point at
> the node-local `scratch` `emptyDir` above; the **finished SIF still lands on the RWX module
> store** (`/runner/sifs`, a single squashfs file — no hardlinks). Executing a SIF (Gate 3)
> reads it via squashfuse and unpacks nothing, so it stays on the shared volume as intended.
> Implication for Phase 4: heavy conversions belong in a **librarian build job** with
> node-local scratch, and consumer workers that only `exec` SIFs need little or no scratch.

`# [LAPTOP]`

```bash
oc rollout status deployment/spike -n ${PROJECT} --timeout=120s
# Record which SCC the Pod was actually admitted under — it should be apptainer-spike-seccomp:
oc get pod -n ${PROJECT} -l app=apptainer-spike \
  -o jsonpath='{.items[0].metadata.annotations.openshift\.io/scc}{"\n"}'
```

> If the container fails to create with a `mount_setattr … idmap mounts` error, a
> `hostUsers: false` snuck into the template — remove it (see the §5 field finding and §9.3).
> If the Pod fails admission on a **UID-range** error, apply the §9.8 annotation fix and
> re-roll.

**Start / stop / re-roll the environment (why it's a Deployment):**

`# [LAPTOP]`

```bash
oc scale deployment/spike -n ${PROJECT} --replicas=0    # stop (frees the node, keeps PVCs)
oc scale deployment/spike -n ${PROJECT} --replicas=1    # start again
oc rollout restart deployment/spike -n ${PROJECT}       # re-roll after editing the template
```

Enter the running Pod (stable name via the Deployment):

`# [LAPTOP]`

```bash
oc rsh -n ${PROJECT} deploy/spike
```

Everything from here to §7 runs **inside** that shell.

---

## 6. One-time setup inside the Pod

`# [POD]`

```bash
mkdir -p /runner/home /runner/sifs   # HOME + module store on the RWX volume
mkdir -p /scratch/cache              # node-local conversion cache (APPTAINER_TMPDIR=/scratch)
cd /runner/sifs
id                      # note your uid/gid (OpenShift assigns an arbitrary high uid, gid 0)
apptainer --version     # <-- GATE 0: must print a version

# Environment fingerprint — record all three, they explain most later failures:
cat /proc/sys/user/max_user_namespaces          # >0 means the KERNEL allows userns
grep Seccomp /proc/self/status                  # "2" = a seccomp filter is active (RuntimeDefault)
ls -l /dev/fuse 2>/dev/null || echo "no /dev/fuse in this Pod"
```

**Gate 0 pass:** a version prints.
**Gate 0 fail:** Apptainer isn't installed/runnable → fix the image (Step 4) before continuing.

> Interpreting the fingerprint on the network-FS-compatible path — a **known-good reading**
> (observed on OKD 4.21): `Seccomp: 0` (the `Unconfined` profile took effect — a `2` means the
> SCC didn't apply and you're on `RuntimeDefault`), `max_user_namespaces` a large number
> (kernel allows unprivileged userns), and `/dev/fuse` present as `crw-rw-rw-` (the annotation
> worked). If Gate 1 fails despite `Seccomp: 0` and `max_user_namespaces > 0`, something else
> is wrong — capture the errno. If `Seccomp` is `2`, the admitted SCC isn't
> `apptainer-spike-seccomp` → check the SCC binding (§9.1). If `/dev/fuse` is missing, the
> annotation didn't take → §9.4. If `max_user_namespaces` is `0`, the node/kernel forbids
> unprivileged userns entirely and no SCC fixes it → pivot (§13).

---

## 7. The gates (run in order, inside the Pod)

### Gate 1 — User namespace probe (THE gate)

`# [POD]`

```bash
# The minimal thing Apptainer needs: a user namespace with a mount namespace inside it.
unshare --user --map-root-user --mount --pid --fork id

# If that fails, also try the narrower probe — it distinguishes "userns itself is blocked"
# from "userns is fine but pid/mount stacking is blocked":
unshare --user --map-root-user id
```

**Pass (confirmed on OKD 4.21):** prints `uid=0(root) gid=0(root) ...` — Apptainer's own
user+mount+pid namespace was created inside the container. This is the make-or-break gate and
it passes on the seccomp-SCC path with no `hostUsers`/`procMount`/added-caps.
**Fail:** `unshare: ... Operation not permitted` → nested userns/mount creation is blocked.
Before anything else, confirm the Pod was admitted under `apptainer-spike-seccomp` (not
`restricted-v2`) and that `seccompProfile: Unconfined` took effect (`grep Seccomp
/proc/self/status` from Gate 0 must show `Seccomp: 0`, not `2`). If the SCC/profile are correct
and it still fails, go to **§9.1**. Record the exact errno.

> Skipped by design: we do **not** re-run this on `restricted-v2` to "prove" it fails. The
> §9 capability matrix documents that as a known-fail; a Pod cycle spent confirming it is
> wasted. If a reviewer wants the baseline, cite the matrix.

---

### Gate 2 — Build/obtain a SIF and execute it

`# [POD]`

```bash
# Convert a tiny public image to a SIF, entirely inside the Pod.
# (Needs egress to docker.io — on a disconnected cluster point this at your mirror.)
apptainer pull /runner/sifs/hello.sif docker://busybox:latest

# Execute it:
apptainer exec /runner/sifs/hello.sif echo "hello from inside the SIF"
```

**Pass (confirmed on OKD 4.21):** the `pull` converts and the `exec` prints the hello line.
**Fail on `pull` with `unpriv.link … too many links`:** `APPTAINER_TMPDIR` is on the network
RWX volume — the hardlink-heavy OCI unpack can't run there (seen on EFS/NFSv4). It must be
node-local (the §5 `scratch` emptyDir); verify `echo $APPTAINER_TMPDIR` points at `/scratch`.
**Fail on `pull` with `Operation not permitted`:** conversion needs userns — recheck Gate 1.
**Fail on `exec` with `mount source /etc/localtime doesn't exist`:** the worker image lacks
`/etc/localtime` (Apptainer bind-mounts it by default) — rebuild with `tzdata` + the symlink
(§4), or as a quick check run `apptainer exec --no-mount bind-paths …`.
**Fail on `exec` with a mount/FUSE error:** note the exact message and go to **§9.4** (FUSE).

Record **how** it mounted — this becomes the authoritative input to Gate 3:

`# [POD]`

```bash
apptainer --debug exec /runner/sifs/hello.sif true 2>&1 \
  | grep -iE "mount|squashfuse|fuse|extract|image driver" | head
```

---

### Gate 3 — Execute off the shared FS with **no local copy**

The SIF already lives on the RWX PVC (`/runner/sifs`). Prove it's mounted **in place**
(squashfuse), not silently extracted somewhere per run.

> **Method corrections learned in this spike — the mount is NOT where you'd look:**
>
> 1. **The squashfuse mount is invisible in every `/proc/*/mounts` you'd naturally check.**
>    Apptainer mounts `squashfuse_ll` in its **session mount namespace**, then presents the
>    container root as a **read-only `overlay` whose `lowerdir` is that squashfuse rootfs**
>    (observed on OKD 4.21):
>    `overlay / overlay ro,…lowerdir=…/session/overlay-lowerdir:…/session/rootfs`.
>    So the parent shell's `/proc/mounts` shows nothing, _and_ the container's own
>    `/proc/self/mounts` shows the root as `overlay`, not `fuse`. The reliable positive signal
>    is the **running `squashfuse_ll` process** (see below), not any mount-table grep.
> 2. **`df -h /` alone is a false pass** — it only catches extraction onto the ephemeral disk.
>    The authoritative negative signal is **no growth in `APPTAINER_TMPDIR`** (the node-local
>    `/scratch`, where any sandbox extraction would land) across many runs.

`# [POD]`

```bash
du -sh /runner/sifs/hello.sif        # size of the module on shared storage
du -sh /scratch                      # baseline the place an extraction would land (TMPDIR)
df -h / | tail -1                    # ephemeral rootfs (belt & suspenders)

# (a) POSITIVE evidence — squashfuse actively serving the SIF DURING an exec (from outside):
apptainer exec /runner/sifs/hello.sif sleep 20 &
sleep 3
pgrep -af squashfuse_ll || echo "no squashfuse process (would mean extraction/loop)"
wait
# Expect: squashfuse_ll -f -o …,ro,uid=…  /proc/self/fd/N  …/session/rootfs
# (reads the SIF read-only via an fd on the shared volume — no copy).

# (b) SUPPORTING — inside, the root is a read-only overlay whose lowerdir IS that rootfs:
apptainer exec /runner/sifs/hello.sif sh -c 'head -1 /proc/self/mounts'
# Expect: overlay / overlay ro,…lowerdir=…/session/…rootfs   (NOT a 'fuse' root — see note)

# (c) NEGATIVE evidence — hammer 20 runs, confirm nothing accumulates:
for i in $(seq 1 20); do apptainer exec /runner/sifs/hello.sif true; done
du -sh /scratch
df -h / | tail -1
```

**Pass (confirmed on OKD 4.21):** a `squashfuse_ll` process is serving the SIF read-only
during exec, the root is a read-only overlay over that rootfs, and `/scratch` (+ ephemeral
disk) does **not** grow across 20 runs → running in place off the shared volume, no per-run
copy.
**Fail:** no `squashfuse_ll` process **and** `/scratch` grows by ~SIF-size per run → Apptainer
is extracting (FUSE unavailable). Works, but forfeits the "no copy" promise — see **§9.4**.

---

### Gate 4 — Model / filesystem access from inside the SIF

`# [POD]`

```bash
# Create a fake weight file on the weights volume:
echo "pretend-safetensors-bytes" > /weights/probe.safetensors
ls -l /weights

# Read it from INSIDE a SIF namespace via --bind, and start a real interpreter from the SIF:
apptainer pull /runner/sifs/py.sif docker://python:3.12-slim
apptainer exec --bind /weights:/weights /runner/sifs/py.sif \
  python3 -c "import sys,os; print('python', sys.version.split()[0]); print(open('/weights/probe.safetensors').read())"
```

**Pass:** prints the Python version and the file contents.
**Fail:** bind or read error → note whether it's a mount permission (SCC) or fsGroup/write
issue on the PVC (`ls -ld /weights`; the gid should be group-writable, typically gid 0).

_(Optional storm signal — how many stat/open syscalls a real import costs over the network FS.
`strace` is in the image; on our path (`seccompProfile: Unconfined`) `ptrace`
should be allowed, but if you ever run this under a tighter profile and get an EPERM from
ptrace, just skip it — it's informational only:)_

`# [POD]`

```bash
strace -f -e trace=stat,statx,openat -c \
  apptainer exec /runner/sifs/py.sif python3 -c "import json,http,urllib,email,xml" 2>&1 | tail -5
```

---

### Gate 5 — Long-lived runner process, reachable endpoint, **clean shutdown**

Proves a real runner (not a one-shot `exec`) can live here, serve HTTP, **and die properly
when told to** — the exact contract our worker `runner-manager` needs (SIGTERM → graceful
drain, no orphaned inner processes, no zombies).

`# [POD]`

```bash
# A tiny "runner" that exposes /health, written onto the module volume:
cat > /runner/sifs/server.py <<'PY'
from http.server import BaseHTTPRequestHandler, HTTPServer
import json, signal, sys
signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
class H(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.send_header("Content-Type","application/json"); self.end_headers()
        self.wfile.write(json.dumps({"state":"READY","activeRequests":0}).encode())
    def log_message(self, *a): pass
print("mini-runner listening on :8080", flush=True)
HTTPServer(("127.0.0.1",8080), H).serve_forever()
PY

# 5a — liveness: launch it from the SIF in the background and hit it:
apptainer exec /runner/sifs/py.sif python3 /runner/sifs/server.py &
APID=$!
sleep 2
curl -s http://127.0.0.1:8080/health; echo

# 5b — signal propagation: TERM the *apptainer* process (what the runner-manager will hold)
# and verify the INNER python actually dies with it:
kill -TERM ${APID}
sleep 3
pgrep -af "server.py" && echo "FAIL: inner process survived SIGTERM (orphan)" \
                      || echo "PASS: inner process exited with the launcher"

# 5c — zombie check (a runner-manager forking many of these must not accumulate zombies):
ps -eo pid,ppid,stat,comm | awk '$3 ~ /Z/' | grep -v awk || echo "no zombies"
```

**Pass:** curl returns `{"state":"READY","activeRequests":0}`, the inner process exits on
SIGTERM to the launcher, and no zombies remain.
**Fail 5a:** process won't stay up or port unreachable → note the error (localhost within
the Pod should always work; anything else points at the SIF's userland, not networking).
**Fail 5b:** the inner process orphans → record it. This is survivable (the runner-manager
can signal the process group instead: `kill -TERM -- -<pgid>`), but it must be a _known_
behavior before Phase 4 design, not a surprise in production.

---

### Gate 6 — Multiple versions in parallel + dynamic add (no Pod restart)

`# [POD]`

```bash
# Two "versions" side by side:
cp /runner/sifs/hello.sif /runner/sifs/vllm-0.20.sif
cp /runner/sifs/hello.sif /runner/sifs/vllm-0.25.sif
apptainer exec /runner/sifs/vllm-0.20.sif echo "v0.20 ok"
apptainer exec /runner/sifs/vllm-0.25.sif echo "v0.25 ok"

# Dynamic add: drop a NEW module onto the live volume and run it WITHOUT restarting the Pod:
apptainer pull /runner/sifs/mlserver.sif docker://busybox:latest
apptainer exec /runner/sifs/mlserver.sif echo "newly-added module ran, no Pod restart"

# Concurrency: two readers on the SAME SIF file at once (multiple workers will do exactly
# this against the shared FS — squashfuse readers must not serialize or corrupt):
apptainer exec /runner/sifs/vllm-0.20.sif sleep 5 &
apptainer exec /runner/sifs/vllm-0.20.sif echo "concurrent reader ok"
wait
```

**Pass:** all echo lines print, including the concurrent one. This is the operational win —
parallel versions, hot-add, and shared-file concurrency with no Pod recycle.

---

## 8. GPU gates (only on a GPU node)

Run these in a **separate** Deployment scheduled on a GPU node. Leave the `oc rsh` from §7
(type `exit`) or open a new `[LAPTOP]` terminal (re-run §2 to set variables there).

> Use the **same** SCC + securityContext + annotation as §5 (the `apptainer-spike-seccomp`
> SCC, seccomp `Unconfined`, the `io.kubernetes.cri-o.Devices: "/dev/fuse"` annotation, and
> **no** `hostUsers: false` — same network-RWX idmap reason as §5) — otherwise you're comparing
> gates run under different privileges and the scorecard is meaningless. The SCC is already
> granted to the `default` SA from §5.

`# [LAPTOP]`

```bash
cat <<EOF | oc apply -f -
apiVersion: apps/v1
kind: Deployment
metadata:
  name: spike-gpu
  namespace: ${PROJECT}
  labels: { app: apptainer-spike-gpu }
spec:
  replicas: 1
  selector:
    matchLabels: { app: apptainer-spike-gpu }
  template:
    metadata:
      labels: { app: apptainer-spike-gpu }
      annotations:
        io.kubernetes.cri-o.Devices: "/dev/fuse"   # same /dev/fuse annotation as §5
    spec:
      # NO hostUsers: false — same network-RWX idmap constraint as §5 (§9.3).
      containers:
        - name: worker
          image: ${IMAGE}
          command: ["sleep", "infinity"]
          securityContext:
            seccompProfile: { type: Unconfined }
            allowPrivilegeEscalation: false
          env:
            - { name: HOME,               value: /runner/home }
            - { name: APPTAINER_TMPDIR,   value: /scratch }          # node-local (see §5)
            - { name: APPTAINER_CACHEDIR, value: /scratch/cache }
          resources:
            # Reserve memory headroom. A worker with NO request competes for whatever RAM is
            # free and can be node-pressure-OOMKilled (137) mid-conversion — that happened once
            # here, then the identical retry succeeded at ~5 GB peak. Observed needs on an L4:
            # SIF conversion ~5 GB peak / ~14 min; two vLLM(opt-125m) engines ~8-12 GB host RAM.
            requests:
              memory: 8Gi
              cpu: "2"
            limits:
              nvidia.com/gpu: 1
              memory: 16Gi
          volumeMounts:
            - { name: runner,  mountPath: /runner }
            - { name: weights, mountPath: /weights }
            - { name: scratch, mountPath: /scratch }
            - { name: dshm,    mountPath: /dev/shm }
      volumes:
        - name: runner
          persistentVolumeClaim: { claimName: ${RUNNER_PVC} }
        - name: weights
          persistentVolumeClaim: { claimName: ${WEIGHTS_PVC} }
        - name: scratch
          emptyDir: { sizeLimit: 50Gi }   # node-local OCI->SIF conversion scratch (§5)
        - name: dshm
          emptyDir: { medium: Memory }
EOF
oc rollout status deployment/spike-gpu -n ${PROJECT} --timeout=300s
oc rsh -n ${PROJECT} deploy/spike-gpu
```

### Gate 7 — GPU visible inside the SIF via `--nv`

`# [POD]` (inside spike-gpu)

```bash
export HOME=/runner/home
# First confirm the GPU is visible to the container itself (injected by the GPU Operator):
nvidia-smi || echo "no nvidia-smi on the container PATH — check GPU Operator injection"

# Now the real test: GPU visible INSIDE the SIF namespace via --nv
apptainer pull /runner/sifs/cuda.sif docker://nvidia/cuda:12.4.1-base-ubi9
apptainer exec --nv /runner/sifs/cuda.sif nvidia-smi
```

**Pass (confirmed on OKD 4.21 / NVIDIA L4):** `nvidia-smi` prints the GPU table from inside
the SIF — worked with no `ldconfig`/`nvidia-container-cli` tweak.
**Two benign warnings you can ignore:** `WARNING: Could not remount /.singularity.d/libs
read-only: permission denied` (that's the `--nv` driver-lib bind dir; Apptainer's read-only
re-mount as hardening needs `CAP_SYS_ADMIN` we don't grant — cosmetic, libs still work); and
during `pull`, `rootless{newgidmap/newuidmap} … harmless EPERM on setxattr security.capability`
(can't set file-cap xattrs on the setuid id-map helpers — unused in single-UID mode).
**Fail:** `--nv` couldn't find driver libs → note it. The GPU Operator injects the driver
userland into the _outer_ container; `--nv` discovers libs via `ldconfig` and known paths,
so a miss is usually fixed by running `ldconfig` in the outer container first, or by
pointing Apptainer at `nvidia-container-cli` (`use nvidia-container-cli = yes` in
`apptainer.conf`) — record which was needed.

---

### Gate 8 — Namespace-sharing probe (kvcached precondition)

Sardeenz's packing model depends on kvcached coordinating GPU memory **across runner
processes** on the same node — CUDA IPC and shared-memory machinery that is sensitive to
PID/IPC namespace isolation. Apptainer's default is to isolate **only the mount (and user)
namespace** and _share_ PID, IPC, and network with the host — exactly what we need. This
gate proves that assumption holds under the SCC we landed on, before spending time on the
full kvcached test.

`# [POD]`

```bash
for ns in ipc pid net; do echo -n "pod  $ns: "; readlink /proc/self/ns/$ns; done
apptainer exec /runner/sifs/cuda.sif \
  sh -c 'for ns in ipc pid net; do echo -n "sif  $ns: "; readlink /proc/self/ns/$ns; done'
```

**Pass:** the `ipc`, `pid`, and `net` inode numbers are **identical** inside and outside the
SIF. (`mnt` — and `user`, in rootless mode — will differ; that's expected and fine.)
**Fail:** any of the three differ → something (SCC, `hostUsers`, or an apptainer.conf
default) is adding isolation kvcached can't cross. Find and remove it before Gate 9 —
**never** "fix" a later kvcached failure by adding `--ipc`/`--pid` flags without
re-running this probe.

---

### Gate 9 — Two runners share one GPU with kvcached (the Sardeenz gate)

This is the most architecture-specific risk in the whole spike and the one v1 skipped: even
if every mechanical gate passes, Phase 4 is dead on arrival if two SIF-launched vLLM
processes can't share GPU memory through kvcached. Budget real time here.

`# [POD]`

```bash
# 9a — Convert the real engine image. This is the big one (~5.8 GB compressed OCI → SIF); it
#      also produces the artifact Gate 10 measures. Time it — conversion cost is a Phase 4
#      provisioning metric in its own right. Uses the internal vetted RHAIV vLLM image; if
#      quay.io needs pull creds, export APPTAINER_DOCKER_USERNAME / APPTAINER_DOCKER_PASSWORD
#      first (or `apptainer remote login docker://quay.io`).
#      OBSERVED baseline (OKD 4.21, L4 node, EFS): ~5 GB peak host RAM, ~13m44s wall
#      (user 49m → mksquashfs uses all cores). Give the Pod a memory request (§8) so this
#      doesn't get node-pressure-OOMKilled (137). Remember /scratch is emptyDir → wiped on
#      Pod restart, so a restart re-downloads + re-converts (the librarian-build argument).
time apptainer pull /runner/sifs/vllm.sif docker://quay.io/vllm/vllm-cuda:0.21.0_rhaiv.8

# 9a-sanity — confirm vLLM imports from the SIF and see how this image exposes the server.
# RHAIV/vetted images may put vLLM in a venv (so the default `python3` matters) and/or ship
# the `vllm` CLI. If `python3 -m vllm...` below can't find the module, use `vllm serve` instead.
apptainer exec --nv /runner/sifs/vllm.sif python3 -c "import vllm; print(vllm.__version__)"
apptainer exec --nv /runner/sifs/vllm.sif sh -c 'command -v vllm && vllm --help | head -3' || true
# OBSERVED (0.21.0_rhaiv.8): SIF = 5.8 GB (≈ the compressed OCI size); `import vllm` →
# 0.21.0+rhaiv.8 from the default python3; `vllm` CLI at /opt/vllm/bin/vllm with a `serve`
# subcommand. Both launch forms work here — 9c/9d below use `vllm serve` (the native entrypoint).

# 9b — Fetch a small real model onto the weights volume (needs egress to huggingface.co).
#      Newer images ship the `hf` CLI (huggingface-cli is deprecated → errors out on RHAIV
#      0.21.0_rhaiv.8); fall back to `huggingface-cli download …` only on older images.
#      The RHAIV image bakes in HF_HUB_OFFLINE=1 (good hardening — runners don't phone home),
#      so override it JUST for this staging step with --env. In real Phase 4 the model is
#      pre-staged on the weights volume and the runner stays offline (leave HF_HUB_OFFLINE=1).
#      (Add --env TRANSFORMERS_OFFLINE=0 too if it complains about that one.)
apptainer exec --nv --bind /weights --env HF_HUB_OFFLINE=0 /runner/sifs/vllm.sif \
  hf download facebook/opt-125m --local-dir /weights/opt-125m

# 9c — Baseline (no kvcached): two engines, one GPU, static memory split.
#      Proves the SIF/GPU/serving mechanics before adding kvcached to the mix.
#      Uses `vllm serve` (confirmed native entrypoint on this image; `python3 -m
#      vllm.entrypoints.openai.api_server` also works if you prefer the module form).
#
#      FINDING: starting both engines CONCURRENTLY spikes host RAM (each cold start does
#      torch + CUDA init + CUDA-graph capture at once) and OOM-killed one engine against the
#      Pod's memory limit. STAGGER the starts — launch #2 only after #1 is serving. Peaks no
#      longer overlap; once both are up they still share the GPU concurrently, so the test is
#      unaffected. (This mirrors how the runner-manager should bring runners up: sequentially.)
apptainer exec --nv --bind /weights /runner/sifs/vllm.sif \
  vllm serve /weights/opt-125m --port 8001 --gpu-memory-utilization 0.30 &
until curl -sf http://127.0.0.1:8001/v1/models >/dev/null; do sleep 3; done   # wait until READY
apptainer exec --nv --bind /weights /runner/sifs/vllm.sif \
  vllm serve /weights/opt-125m --port 8002 --gpu-memory-utilization 0.30 &
until curl -sf http://127.0.0.1:8002/v1/models >/dev/null; do sleep 3; done
curl -s http://127.0.0.1:8001/v1/models | jq .
curl -s http://127.0.0.1:8002/v1/models | jq .
nvidia-smi   # two processes visible on the one GPU
kill %1 %2; wait

# 9d — The real thing: two engines with kvcached enabled → ELASTIC sharing.
#
#   IMPORTANT: the bare vllm.sif from 9a does NOT contain kvcached. kvcached is a separate
#   Python wheel (built from github.com/ovg-project/kvcached at a pinned commit, needs the CUDA
#   devel toolchain but no GPU — links against CUDA stubs) installed on top of the vLLM image;
#   at runtime it AUTOPATCHES vLLM at import (ENABLE_KVCACHED=true + KVCACHED_AUTOPATCH=1) — no
#   statically-patched vLLM. So 9d needs a SIF built from a kvcached-ENABLED image. This is
#   true whether you package as SIF OR as a plain container — a kvcached requirement, not a SIF
#   one (see the FINDING after this gate). Reference build: v1 docker/Containerfile.
#
#   Get a kvcached SIF (pick one):
#     (a) already have a built kvcached vLLM image in a registry (the Sardeenz runtime image)?
#           apptainer pull /runner/sifs/vllm-kvcached.sif docker://<registry>/<kvcached-image>:<tag>
#     (b) else build a slim base+kvcached image (multi-stage: FROM vllm-cuda:0.21.0_rhaiv.8;
#         add CUDA devel + git; `pip3.12 wheel .` the pinned kvcached commit --no-build-isolation;
#         pip install the wheel; ENV ENABLE_KVCACHED=true KVCACHED_AUTOPATCH=1) — condensed from
#         v1 docker/Containerfile. Run it as a LIBRARIAN build job (CUDA-devel image is multi-GB),
#         push it, then apptainer pull as in (a).
#
#   WRITABLE CACHES: if you use an *app* image (e.g. the Sardeenz runtime image), it likely
#   bakes cache dirs under a writable-in-a-container path like /opt/app-root/src
#   (XDG_CACHE_HOME / HF_HOME / FLASHINFER_WORKSPACE_DIR). Inside a SIF that path is READ-ONLY,
#   so vLLM/FlashInfer/torch compile caches fail — redirect them to node-local /scratch:
#     mkdir -p /scratch/cache/huggingface /scratch/cache/flashinfer
#     ...--env XDG_CACHE_HOME=/scratch/cache \
#        --env HF_HOME=/scratch/cache/huggingface \
#        --env FLASHINFER_WORKSPACE_DIR=/scratch/cache/flashinfer ...
#   (Do NOT pass --env HOME=... — Apptainer rejects it with a warning; HOME comes from the Pod
#    env (=/runner/home) already, or use `apptainer exec --home /runner/home` to override.)
#
#   Then launch BOTH (staggered, as in 9c) with kvcached env on:
#     apptainer exec --nv --bind /weights \
#       --env ENABLE_KVCACHED=true --env KVCACHED_AUTOPATCH=1 \
#       /runner/sifs/vllm-kvcached.sif vllm serve /weights/opt-125m --port 8001 &
#     until curl -sf http://127.0.0.1:8001/v1/models >/dev/null; do sleep 3; done
#     (…same on 8002…)
#   (env is baked into a properly-built image, but pass --env explicitly to be sure.)
#
# Then: curl both endpoints, send a few completions to each, and confirm via nvidia-smi /
# the kvcached telemetry you already use in the dashboard that memory is actually being
# SHARED (elastic), not statically partitioned like 9c.
```

**Pass:** 9c serves from both endpoints; 9d serves from both **and** shows kvcached's
elastic sharing behavior between the two SIF-launched processes.
**Fail 9c:** a plain engine won't run from the SIF (CUDA init, shm, or host-RAM OOM) → note
which. Common fixes: (a) **host-RAM OOM on concurrent start** (exit 137 / OOM-killed, no CUDA
error) → stagger the starts as above, or raise the Pod memory limit (§8); (b) vLLM wants
generous `/dev/shm` — check `df -h /dev/shm` (§5/§8 mount a `medium: Memory` emptyDir there);
(c) `CUDA out of memory` → lower `--gpu-memory-utilization` per engine.
**Fail 9d only:** first rule out the trivial cause — **did you use a kvcached SIF?** If both
engines still show a _static_ split like 9c, kvcached almost certainly isn't in the image (or
`ENABLE_KVCACHED`/`KVCACHED_AUTOPATCH` weren't set) — check `apptainer exec vllm-kvcached.sif
python3 -c "import kvcached"`. Only if kvcached is present and enabled but sharing still fails
is it a real SIF-boundary problem → **Red-level finding regardless of SCCs**. Re-run Gate 8,
then test the same two-process kvcached launch _without_ Apptainer (directly in the Pod) to
isolate whether SIF wrapping is the variable. Record everything — this single result reshapes
Phase 4 more than any SCC does.

> **FINDING — kvcached runners need a custom-built image (SIF-neutral).** The stock
> `vllm-cuda:0.21.0_rhaiv.8` base has no kvcached; it's a wheel (pinned
> `github.com/ovg-project/kvcached` commit) compiled with the CUDA devel toolchain and
> `pip install`ed on top, enabled at runtime via `ENABLE_KVCACHED=true` + `KVCACHED_AUTOPATCH=1`
> (kvcached autopatches vLLM at import — vLLM itself is not statically patched). Ref: v1
> `docker/Containerfile`. **This is required whether you deploy as a SIF or a plain OCI
> container**, so it is _not_ a strike against the SIF design — it just means the Phase 4
> pipeline builds a custom OCI image (base + kvcached wheel) in a librarian/CI job and converts
> that to SIF; you never `apptainer pull` an upstream vLLM for a kvcached runner. Engines that
> don't use kvcached still convert from stock images (Gates 2–9c).

---

### Gate 10 — Realistic cold start + fan-out (the economics gate)

> **What the economics actually are (reframed).** The one-time image→SIF **conversion** is a
> build-side, amortized cost — the librarian does it once, and a container-based approach pays
> the same pull to populate a node anyway — so "conversion time vs. image-pull time" is _not_
> the decision-relevant comparison. What matters is the **runtime, per-worker** behavior:
>
> - **No per-node image pull, ever.** The image is materialized once (centrally) → SIF on the
>   RWX volume; every worker — including brand-new nodes and every _additional_ engine version —
>   starts from the shared SIF with **no registry pull and no local image copy** (Gate 3). The
>   container approach pays a per-node, per-version pull (~150s-class for 5.8 GB) on first use.
> - **Cold spawn from the shared SIF** — the number to record (below): ~19s here, mostly the
>   unavoidable CPU-bound `import`.
> - Plus hot-add of versions with no pod recycle (Gate 6).
>
> The `crictl pull` baseline below is therefore **optional** — only useful to _quantify_ the
> per-node pull you're avoiding, not a gate.

The _argument_ for SIF-on-shared-storage is that a large runtime lazily pages in over the
network and — critically — is materialized **once** for the whole fleet. Measure the cold spawn
and (if you have the nodes) the fan-out.

> **Read these numbers as EFS/NFS-grade.** This spike ran on AWS EFS (§2), which Fable flagged
> as _weaker_ than CephFS/ODF for squashfuse-over-network. So treat the cold-start figures as a
> **solid data point for EFS** and a likely floor for other RWX backends — re-run per backend
> you intend to support (CephFS is the obvious next one) to characterize each.

`# [POD]`

```bash
# Cold import (run this as the FIRST vllm exec after the Pod starts — page cache empty).
# You cannot drop the page cache unprivileged, so "cold" = fresh Pod / fresh node.
time apptainer exec --nv /runner/sifs/vllm.sif python3 -c "import vllm; print(vllm.__version__)"

# Warm import (page cache primed) — the steady-state runner spawn cost:
time apptainer exec --nv /runner/sifs/vllm.sif python3 -c "import vllm"
```

`# [LAPTOP]` (fan-out: a second Pod on a **different** node, same SIF, same moment)

```bash
# Copy the §8 Deployment as spike-gpu-2 with a nodeSelector/antiAffinity pinning it to another
# GPU node, rsh in (oc rsh deploy/spike-gpu-2), and run the same cold-import 'time' command
# simultaneously with a fresh cold start on spike-gpu (force a fresh Pod with
# `oc rollout restart deployment/spike-gpu`, or use a node you haven't touched).
# Record: single-node cold time vs. N-node simultaneous cold time. Divergence = shared-FS read
# bandwidth contention (EFS throughput mode matters here), and it defines how many workers can
# cold-start a version at once.
```

**Record (don't pass/fail — this gate is a measurement):**

- SIF conversion time (from 9a) and final SIF size vs. OCI image size.
  _Observed (OKD 4.21, L4, EFS):_ conversion **~13m44s**, **SIF 5.8 GB ≈ compressed OCI 5.8 GB**
  (so on-volume footprint ≈ registry footprint; the SIF pages in lazily rather than pre-pulling).
- Cold import, warm import, and (if you have the nodes) 2-node simultaneous cold import.
  _Observed (EFS, freshly-restarted Pod = cold):_ cold `import vllm` **~19.1s**, warm **~10.2s**
  (CPU-bound — the python import cost any packaging pays); so ~9s is first-touch EFS page-in.
  (Caveat: if the fresh Pod reschedules to the _same_ node, node-level page cache may persist, so
  a truly cold node could be ≥ this.) NB: `import vllm` pages only the import path — a full
  `vllm serve` cold start touches much more, so this is a _lower bound_ on runner spawn cost.
- _Optional_ — the per-node `crictl pull` baseline, only to **quantify the per-node pull you
  avoid** (not a gate; the SIF is built once and never pulled per node). Measure with
  `oc debug node/<n> -- chroot /host time crictl pull …` if you want the number; at ~39 MiB/s
  the 5.8 GB image is ~150s just to download+unpack.

The decision-relevant economic facts (per the reframing above): the SIF is materialized **once**
for the whole fleet (no per-node pull, no local copy — Gate 3), cold spawn from shared storage
is ~19s (mostly CPU-bound import), and versions hot-add without a pod recycle (Gate 6).
(Measured on EFS; re-run per RWX backend you support for exact page-in numbers.)

`# [LAPTOP]`

```bash
exit   # leave the pod shell when done
```

---

## 9. Playbook — capability matrix, troubleshooting, and trimming

We deploy onto the network-FS-compatible path (§5), so this section is **not** a ladder you climb
from zero. It is: (1) the capability matrix that tells you what's a known-fail so you don't
test it, (2) how to fix a gate that fails, and (3) how to **trim** privileges afterward to
record the true minimum. **Record what was actually needed** — it is the headline result of
the spike.

### 9.0 Capability matrix (what each tier can and cannot do — don't test the ❌ cells)

The two rightmost columns describe our **in-container-userns** path (Apptainer's own userns,
no `hostUsers: false`) — the only one compatible with a network RWX PVC here (tested on EFS).
The `nested-container` + `hostUsers: false` "Kubernetes-native pod-userns" alternative would
give the same capabilities _in theory_ but is **blocked by the RWX FS lacking idmapped mounts**
(§9.3), so it's not a usable column for us.

| Capability                                 | `restricted-v2` (stock) | seccomp SCC (`Unconfined`), in-container userns | + `/dev/fuse` (CRI-O annotation)   |
| ------------------------------------------ | ----------------------- | ----------------------------------------------- | ---------------------------------- |
| SIF sandbox **extraction** (local copy)    | ✅                      | ✅                                              | ✅                                 |
| **Namespaced containers** (`--userns`)     | ❌                      | ✅ (Gate 1 confirmed)                           | ✅                                 |
| **Direct SIF mount** (squashfuse, no-copy) | ❌                      | ❌                                              | ✅ (verify at Gate 3)              |
| `--fakeroot`, overlays, `apptainer build`  | ❌                      | partial                                         | likely (may want unmasked `/proc`) |

Read this before running anything: the "no local copy" promise (Gate 3) lives in the
**rightmost** column — that's why §5 sets the `/dev/fuse` annotation from the start.
`restricted-v2` only ever gets you extraction, so we don't test userns/mount there.

> **Read the error first (troubleshooting).** Container won't create,
> `mount_setattr … idmap mounts` → a `hostUsers: false` is in the spec + the RWX FS can't idmap
> → §9.3 (remove it). `Operation not permitted` on `unshare` despite `Seccomp: 0` → §9.1 (verify
> the SCC bound). `newuidmap`/`newgidmap` errors → §9.2. Userns works but mounts fail / no
> `/dev/fuse` → §9.4. Runtime is `runc` not `crun` → §9.7. PVC `Permission denied` (not
> namespace-related) → fsGroup/UID, see §12 (and §9.6 for how to _diagnose_ it, not fix it).

### 9.1 The seccomp SCC (the path §5 uses — network-FS-compatible)

This is the SCC §5 already creates and binds; it's reproduced here as the canonical reference.
`restricted-v2` admits Pods with seccomp `RuntimeDefault`, which blocks unprivileged namespace
creation — **no capability grant fixes that**; the Pod must be allowed `seccompProfile:
Unconfined`. The SCC below is `restricted-v2` with exactly one change (the `seccompProfiles`
list) — no added capabilities, no `RunAsAny`, no privilege escalation, no `hostUsers`/
`procMount` — so it's the strongest "mild SCC" claim available _and_ it mounts network RWX PVCs
normally (unlike `nested-container`, which forces pod-level userns → §9.3):

`# [LAPTOP]`

```bash
cat <<'EOF' | oc apply -f -
apiVersion: security.openshift.io/v1
kind: SecurityContextConstraints
metadata:
  name: apptainer-spike-seccomp
allowHostDirVolumePlugin: false
allowHostIPC: false
allowHostNetwork: false
allowHostPID: false
allowHostPorts: false
allowPrivilegeEscalation: false
allowPrivilegedContainer: false
allowedCapabilities:
  - NET_BIND_SERVICE
defaultAddCapabilities: null
requiredDropCapabilities:
  - ALL
fsGroup:            { type: MustRunAs }
runAsUser:          { type: MustRunAsRange }
seLinuxContext:     { type: MustRunAs }
supplementalGroups: { type: RunAsAny }
seccompProfiles:
  - runtime/default
  - unconfined
readOnlyRootFilesystem: false
volumes: ["configMap","csi","downwardAPI","emptyDir","ephemeral","persistentVolumeClaim","projected","secret"]
users: []
groups: []
EOF

oc adm policy add-scc-to-user apptainer-spike-seccomp -z default -n ${PROJECT}
```

The SCC only _permits_ unconfined — the Deployment's Pod template also **requests** it
(§5's `seccompProfile: { type: Unconfined }`). If you ever find the Pod admitted under the
wrong SCC (`Seccomp: 2` in the Gate 0 fingerprint), confirm this SCC is bound to the SA and
re-roll:

`# [LAPTOP]`

```bash
oc rollout restart deployment/spike -n ${PROJECT}
# Then verify the admitted SCC is apptainer-spike-seccomp, and re-run Gate 1:
oc get pod -n ${PROJECT} -l app=apptainer-spike \
  -o jsonpath='{.items[0].metadata.annotations.openshift\.io/scc}{"\n"}'
```

> If your security review would rather not see blanket `Unconfined`, the refined endgame
> (post-spike, not spike scope) is a **custom seccomp profile** = RuntimeDefault + allow
> `unshare`/`clone`/`mount`/`setns`, shipped via the Security Profiles Operator. Record
> that as the productization path if this rung is what unblocks you.

### 9.2 Add SETUID/SETGID (only on explicit `newuidmap` errors)

With a single arbitrary UID and no `/etc/subuid` entries, Apptainer runs in single-UID
mapping mode and **never calls** `newuidmap`/`newgidmap` — so these capabilities are
usually unnecessary, and granting them preemptively muddies the "minimum SCC" result. Add
them **only** if the error text names `newuidmap`/`newgidmap`/subuid:

`# [LAPTOP]`

```bash
# Clone §9.1's SCC as apptainer-spike-idmap with these two deltas, then bind and recreate:
#   allowedCapabilities: [NET_BIND_SERVICE, SETUID, SETGID]
#   requiredDropCapabilities: []          # and add SETUID/SETGID to the container's
#                                         # securityContext.capabilities.add
```

### 9.3 Why we do NOT use `hostUsers: false` / `nested-container` (field finding)

`hostUsers: false` (and the `nested-container` SCC, which _requires_ it via
`userNamespaceLevel: RequirePodLevel`) puts the whole Pod in a **Kubernetes-level** user
namespace created by CRI-O. The kubelet then has to bring each volume into that namespace
using **idmapped mounts** — and the RWX filesystem must support them. Result, observed on a
live OKD 4.21 cluster **with an AWS EFS (NFSv4) RWX volume** at container create:

```
Error: container create failed: mount_setattr `/runner`
  (maybe the file system used doesn't support idmap mounts on this kernel?): Invalid argument
```

NFS/EFS does not support idmapped mounts, full stop. **Kernel CephFS** gained idmapped-mount
support in Linux 6.7, so on a _new enough_ kernel + CSI it _might_ work — but RHCOS on current
4.x ships ~5.14, so in practice CephFS-on-RHCOS won't either today. Treat this as a general
"the RWX backend can't idmap" constraint and **re-test on CephFS** if that path ever matters.

**The fix / design decision:** don't use pod-level userns for a PVC-backed workload. Let
_Apptainer_ create its own user namespace _inside_ the container (rootless nested), which
needs only the seccomp SCC (§9.1) and mounts the RWX volume normally. That's what §5 does, and
Gates 0 and 1 confirm it works.

- **When could you use `hostUsers: false`?** Only if your SIF/weights volumes live on a
  filesystem whose CSI driver advertises idmapped-mount support (some block/local classes do;
  EFS/NFS don't, and CephFS-on-RHCOS doesn't today). For our shared-RWX design that rules it
  out — record it as a platform constraint on Phase 4.
- **kvcached topology note (still relevant):** because the container shares the host's PID/IPC
  namespaces on this path, kvcached's cross-process machinery should work — but prove it at
  Gate 8 before Gate 9 regardless; never assume.

### 9.4 No FUSE (Gate 2/3 mount failures)

Apptainer needs `/dev/fuse` to mount squashfs SIFs read-only without copying. On 4.15+ this
requires **no device plugin** — §5/§8 set the `io.kubernetes.cri-o.Devices: "/dev/fuse"`
annotation on the Pod template and CRI-O exposes the device. This subsection is for when it's
**not** showing up (`# [POD] ls -l /dev/fuse` → not found).

**On 4.15+ (OKD 4.21):** confirm the annotation actually landed on the _Pod_ (not just the
Deployment) and re-roll:

`# [LAPTOP]`

```bash
oc get pod -n ${PROJECT} -l app=apptainer-spike \
  -o jsonpath='{.items[0].metadata.annotations.io\.kubernetes\.cri-o\.Devices}{"\n"}'
# Deployments propagate template annotations to Pods; if it's missing, fix the
# spec.template.metadata.annotations block in §5/§8 and re-roll:
oc rollout restart deployment/spike -n ${PROJECT}
```

Verify `/dev/fuse` appears in the Pod: `# [POD]  ls -l /dev/fuse`

**On clusters older than 4.15:** the annotation alone isn't honored — an admin must first
allow the device in CRI-O via a MachineConfig (this triggers a rolling node reboot, and is
**not** possible on Managed OpenShift / ROSA / ARO):

`# [LAPTOP]`

```bash
# MachineConfig drops /etc/crio/crio.conf.d/99-podman-fuse with:
#   [crio.runtime.workloads.podman-fuse]
#   activation_annotation = "io.openshift.podman-fuse"
#   allowed_annotations   = [ "io.kubernetes.cri-o.Devices" ]
#   [crio.runtime]
#   allowed_devices = ["/dev/fuse"]
# Then the Pod needs BOTH annotations:
#   io.openshift.podman-fuse: ""
#   io.kubernetes.cri-o.Devices: "/dev/fuse"
```

**Fallback — extract to sandbox (no FUSE, but local copy + metadata storm returns):**

`# [POD]`

```bash
apptainer build --sandbox /runner/sifs/hello.sandbox docker://busybox:latest
apptainer exec /runner/sifs/hello.sandbox echo "ran from sandbox dir (no FUSE)"
```

If you land here, mark Gate 3 **failed** on the scorecard even though things "work" — the
no-copy property is the point, and (per the §5 note) the sandbox is quietly living on your
PVC where `df /` never sees it.

### 9.5 Last resort — privileged

Add `securityContext: { privileged: true }` to the container. If _only_ this works, the
design is Amber (trusted clusters only). Record it and stop — and weigh §13 seriously.

### 9.6 `anyuid` — mostly a red herring for this spike

`# [LAPTOP]`

```bash
oc adm policy add-scc-to-user anyuid -z default -n ${PROJECT}
```

Running as UID 0 in the container grants **no capabilities and no seccomp relief** — it
will not unblock Gate 1, and testing it there wastes a Pod cycle. Its one legitimate use in
this spike is diagnosing PVC **permission** failures (fsGroup/arbitrary-UID write issues):
if a write works under `anyuid` but not `restricted-v2`, the fix is fsGroup/dir perms on
the volume (§12), not privileges.

### 9.7 Ensure `crun` is the runtime (userns support lives here)

`crun` is the default on modern 4.x, but if a node still runs `runc`, userns behavior can
differ. Verify, and if needed pin `crun` on the worker pool via a `ContainerRuntimeConfig`
(this triggers a rolling MachineConfig update of the pool — plan for the node reboots):

`# [LAPTOP]`

```bash
# Check the runtime a worker node is using:
oc get node <a-worker-node> -o jsonpath='{.status.nodeInfo.containerRuntimeVersion}{"\n"}'

# Only if it isn't crun — pin it (rolls the worker MachineConfigPool):
cat <<'EOF' | oc apply -f -
apiVersion: machineconfiguration.openshift.io/v1
kind: ContainerRuntimeConfig
metadata:
  name: crun-runtime
spec:
  machineConfigPoolSelector:
    matchLabels:
      pools.operator.machineconfiguration.openshift.io/worker: ""
  containerRuntimeConfig:
    defaultRuntime: crun
EOF
```

### 9.8 UID-range admission fix (only for the unused `hostUsers: false` path)

Our in-container-userns path (§5) does **not** need this — skip it unless you're experimenting
with `hostUsers: false` (§9.3), which requires the project's in-namespace UID range to be
**≤ 65535**. If a pod-userns Pod fails admission with a UID-range error, the project's
`openshift.io/sa.scc.uid-range` annotation is outside what userns allows.

`# [LAPTOP]`

```bash
# Inspect the current range:
oc get ns ${PROJECT} -o jsonpath='{.metadata.annotations.openshift\.io/sa\.scc\.uid-range}{"\n"}'
# If it starts above 65535 (e.g. 1000700000/10000), set a userns-compatible range and re-roll:
oc annotate ns ${PROJECT} openshift.io/sa.scc.uid-range=0/65536 --overwrite
oc rollout restart deployment/spike -n ${PROJECT}
```

> Double-check your specific 4.21.x release notes: the SCC names and the GA status of
> `procMount`/userns have been evolving release to release, and 4.21 may carry refinements
> beyond what's documented for 4.20.

---

## 10. Results scorecard (fill this in)

| Gate | What it proves                                   | Result (pass/fail)    | SCC / securityContext needed | Notes (backend, latency, errors)                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---- | ------------------------------------------------ | --------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Apptainer runs in Pod                            | ✅ (OKD 4.21)         | apptainer-spike-seccomp      | fingerprint: max_userns=506656, Seccomp=0, /dev/fuse=present                                                                                                                                                                                                                                                                                                                                                                                                     |
| 1    | User namespace allowed                           | ✅ (OKD 4.21)         | apptainer-spike-seccomp      | `unshare --user --map-root-user …` → uid=0(root); no hostUsers/procMount needed                                                                                                                                                                                                                                                                                                                                                                                  |
| 2    | Build + exec a SIF                               | ✅ (OKD 4.21)         | apptainer-spike-seccomp      | needed node-local scratch (network-FS tmp → `unpriv.link too many links`) + `tzdata`/`/etc/localtime` in image                                                                                                                                                                                                                                                                                                                                                   |
| 3    | Exec off shared FS, no copy                      | ✅ (OKD 4.21)         | apptainer-spike-seccomp      | `squashfuse_ll` serves SIF read-only via fd; root is a RO overlay over `session/rootfs`; zero scratch growth across 20 runs. NOTE: mount lives in session ns → not in parent OR container `/proc/mounts`; check the process. Test RWX = **AWS EFS (NFSv4)**, not CephFS                                                                                                                                                                                          |
| 4    | Read weights from SIF                            | ✅ (OKD 4.21)         | apptainer-spike-seccomp      | `--bind /weights` read OK from `python3` in SIF (3.12.14); strace ran (ptrace allowed → seccomp Unconfined); 5-module import = 433 openat/192 ENOENT, all served by squashfuse from the 1 SIF file (storm avoided)                                                                                                                                                                                                                                               |
| 5    | Long-lived runner + HTTP + SIGTERM/reap          | ✅ (OKD 4.21)         | apptainer-spike-seccomp      | `/health` OK from SIF-launched server; SIGTERM to launcher → inner python exits (NO orphan, no pgid workaround needed); no zombies; no squashfuse teardown warning on clean exit                                                                                                                                                                                                                                                                                 |
| 6    | Parallel versions + hot-add + concurrent readers | ✅ (OKD 4.21)         | apptainer-spike-seccomp      | v0.20 + v0.25 side by side; hot-added mlserver.sif onto live volume + ran (no Pod restart); 2 concurrent readers of same SIF OK. (pull success re-confirms node-local scratch in effect)                                                                                                                                                                                                                                                                         |
| 7    | GPU via `--nv`                                   | ✅ (OKD 4.21)         | apptainer-spike-seccomp      | `--nv nvidia-smi` shows L4 inside SIF (drv 580.126.20, CUDA 13.0); worked out of the box, NO ldconfig / nvidia-container-cli needed. Benign warnings: "could not remount /.singularity.d/libs read-only" (no CAP_SYS_ADMIN, cosmetic) + rootless newgidmap EPERM on setxattr during pull                                                                                                                                                                         |
| 8    | PID/IPC/net shared across SIF boundary           | ✅ (OKD 4.21)         | apptainer-spike-seccomp      | ipc/pid/net inodes identical inside vs outside SIF (4026533918/…653/…919); only mnt+user differ. kvcached's shared-ns precondition met                                                                                                                                                                                                                                                                                                                           |
| 9    | Two runners + kvcached on one GPU                | ✅ 9c + 9d (OKD 4.21) | apptainer-spike-seccomp      | 9c baseline: two EngineCore procs, static split ~6968 MiB each. **9d PASS**: with a kvcached-built image (base + wheel + ENABLE_KVCACHED/KVCACHED_AUTOPATCH), both SIF-launched engines load kvcached and share GPU memory elastically on one L4 — the Sardeenz-defining result. Needs writable cache dirs (redirect off the read-only SIF) + staggered start; benign warnings (libs remount, HOME-via-env rejected)                                             |
| 10   | Real-size cold start + fan-out                   | ✅ measured           | apptainer-spike-seccomp      | **cold `import vllm` ~19.1s** (fresh Pod), warm ~10.2s (CPU-bound), so ~9s first-touch EFS page-in. SIF 5.8 GB ≈ compressed OCI; conversion 13m44s (one-time, librarian). Economic win = materialized once for the whole fleet, **no per-node pull / no local copy** (Gate 3) + hot-add (Gate 6); one-time conversion is amortized so `crictl pull` baseline is optional. `import vllm` is a lower bound vs full `vllm serve` cold start. 2-node fan-out not run |

**Decision:**

- **Green (mild-SCC product default)** — gates 1–9 pass on the **network-FS-compatible path**
  (custom `apptainer-spike-seccomp` SCC — seccomp `Unconfined` only — + the `/dev/fuse` CRI-O
  annotation, in-container userns, **no device plugin, no added capabilities, no `hostUsers`,
  no privileged**), **and** Gate 10's cold-start numbers beat (or at least match) the
  image-pull baseline → build Phase 4 on Apptainer/SIF. Note this needs a **custom** SCC (the
  shipped `nested-container` can't be used with a network RWX volume, §9.3); the productization
  refinement is a scoped seccomp _profile_ via the Security Profiles Operator instead of blanket
  `Unconfined` (§9.1 note). **Caveat:** Gate 10 here is on EFS/NFS — re-check per RWX backend
  you plan to support (this is a real proof point, not a stand-in).
- **Amber** — needs added capabilities / `privileged`, **or** Gate 10 loses to image pulls →
  viable only on trusted or specially-configured clusters; run the §13 comparison before
  committing.
- **Red** — Gate 1 unrecoverable, **or Gate 9d fails** (kvcached can't cross the SIF boundary
  — no SCC fixes that) → pivot per §13.

> **VERDICT: GO** (live OKD 4.21, RWX = AWS EFS/NFSv4, GPU = NVIDIA L4). **All gates 0–10 pass**
> on the network-FS-compatible path with only a **mild custom SCC** (seccomp `Unconfined`) + the
> `/dev/fuse` CRI-O annotation — no privileged, no added caps, no `hostUsers`, no device plugin.
> The make-or-break gates cleared: unprivileged userns (Gate 1) and **kvcached elastic sharing
> across two SIF-launched engines on one GPU (Gate 9d)**. Cold spawn from the shared SIF ~19s.
> Build Phase 4 on Apptainer/SIF via the provisioning model above (publish Containerfiles →
> build/sign images in CI → convert to SIF in a librarian job → workers exec signed SIFs).
> **Named follow-ups (not blockers):** (1) re-run the perf-sensitive numbers on **CephFS** (this
> run is EFS-grade); (2) productionize the SCC as a **scoped seccomp profile** via the Security
> Profiles Operator instead of blanket `Unconfined`; (3) enforce **SIF signing/verification** +
> tight RBAC on the module PVC.
>
> **Progress detail (live OKD 4.21, RWX = AWS EFS/NFSv4, GPU = NVIDIA L4):** **Gates 0–8 are
> Green** on the network-FS-compatible path. Gate 1 (unprivileged userns) —
> the make-or-break gate — passes
> with only a mild custom SCC. Gate 2 needed two fixes now baked into the runbook: node-local
> conversion scratch (network FS breaks the OCI hardlink unpack) and `/etc/localtime` in the
> worker image. Gate 3 confirms the SIF runs **in place via squashfuse off the shared RWX
> volume with no per-run copy** (the core "no local copy" claim) — evidence is the live
> `squashfuse_ll` process serving the SIF read-only + zero scratch growth across 20 runs (the
> mount is namespaced, so `/proc/mounts` checks don't see it). Gate 4 reads model weights via
> `--bind` from a real interpreter in the SIF, with the import metadata-storm served by
> squashfuse from the single SIF file. Gate 5: a SIF-launched HTTP runner serves `/health`, and
> **SIGTERM to the launcher cleanly kills the inner process (no orphan, no pgid workaround) with
> no zombies** — the drain contract the runner-manager needs. Gate 6: parallel versions, hot-add
> of a new module onto the live volume without a Pod restart, and concurrent readers of the same
> SIF — the operational payoff. **Note:** goal is RWX-agnostic — this run proves it on AWS EFS
> (a real RWX class); re-check idmap/perf per additional backend (CephFS next, on another
> cluster) — see §2. Gate 7: GPU visible inside the SIF via `--nv` (L4, no ldconfig/
> nvidia-container-cli needed; two benign warnings noted). Gate 8: the SIF shares the pod's
> ipc/pid/net namespaces (kvcached precondition met). **Gate 9c** (baseline, no kvcached): two
> SIF-launched vLLM `EngineCore` processes serve `opt-125m` on one L4 with a static split
> (~6968 MiB each; staggered start to avoid concurrent-cold-start host-RAM OOM) — real-engine
> mechanics through the SIF proven. **Gate 9d ✅ — the make-or-break result:** with a
> kvcached-built image (base + wheel + `ENABLE_KVCACHED`/`KVCACHED_AUTOPATCH`, writable cache
> dirs redirected off the read-only SIF), both SIF-launched engines load kvcached and share GPU
> memory **elastically** on one L4. That was the one gate that could have killed the design
> regardless of SCCs — it passes. **Gate 10** (economics): cold spawn from the shared SIF ~19s
> (fresh Pod), and the SIF is materialized once for the whole fleet with no per-node pull / no
> local copy — the one-time conversion is amortized (a container node would pull the image once
> anyway), so it's not a decision driver. All gates green → **GO** (see the verdict at the top
> of §10); perf to be re-characterized on CephFS.

### Phase 4 provisioning model (decided — implied by the findings)

The gates prove the _runtime_; the findings (custom image for kvcached, node-local build
scratch, supply-chain gap) settle the _provisioning_ side. Sardeenz owns the build pipeline:

1. **Publish a `Containerfile` per runner** in-repo (e.g. `containers/runner-vllm/`,
   `containers/runner-triton/`, …) — versioned and reviewed. vLLM+kvcached is base vLLM + the
   compiled kvcached wheel + `ENABLE_KVCACHED`/`KVCACHED_AUTOPATCH` (see Gate 9d finding).
2. **Build the OCI images in CI** (with the CUDA devel toolchain where a runner needs it) and
   push to a registry — the normal, scanned, signed image pipeline.
3. **Convert image → SIF once in a librarian/CI job** (node-local scratch + the memory headroom
   from Gate 9a), **`apptainer sign`** it, and place it on the shared RWX module volume.
4. **Workers only `apptainer exec`** the signed SIF (`readOnly` mount) — no pull, no mksquashfs,
   minimal RAM/scratch; verify the signature at exec (`apptainer.conf`).

This closes the supply-chain gap (§12) — because Sardeenz builds and signs the SIFs — and makes
the "custom image for kvcached" a first-class, reproducible deliverable rather than a per-user
chore. Cache-dir env baked into an app image (e.g. under `/opt/app-root/src`) must be
redirected to writable paths at exec, since the SIF root is read-only (Gate 9d note).

---

## 11. Cleanup

`# [LAPTOP]`

```bash
# Deleting the project removes the Deployments (spike, spike-gpu[-2]), PVCs, and the
# namespace-scoped SCC binding in one shot:
oc delete project ${PROJECT}

# The custom SCCs are cluster-scoped — remove them separately:
oc delete scc apptainer-spike-seccomp apptainer-spike-idmap --ignore-not-found

# The §9.7 crun ContainerRuntimeConfig is cluster-wide and NOT tied to the project — only
# remove it if you added it for the spike and no other workload depends on crun being pinned:
# oc delete containerruntimeconfig crun-runtime
```

---

## 12. Notes & gotchas

- **Test substrate = AWS EFS (NFSv4); goal is RWX-agnostic.** The aim is to run on any RWX
  volume; this spike ran on EFS (efs-csi, mounts as `127.0.0.1:/… nfs4` via TLS `stunnel`) as a
  first-class proof point. The idmap, hardlink, and perf findings below are all consistent with
  NFS semantics and network-FS-general. Re-check idmap and Gate 10 perf **per additional backend
  you plan to support** (CephFS is the priority follow-up, on another cluster) — not a blocker
  for the general result (see §2 storage-goal note).
- **Network RWX + `hostUsers: false` = broken (the big one).** Pod-level user namespaces
  (`hostUsers: false`, and therefore the `nested-container` SCC) need idmapped volume mounts,
  which NFS/EFS can't do (nor CephFS on current RHCOS kernels) — container create fails with
  `mount_setattr … doesn't support idmap mounts`. Use the in-container-userns path (§5) instead.
  Full write-up and the fix in **§9.3**.
- **Arbitrary UID:** OpenShift assigns a random high UID (gid 0) — on our path (no pod-level
  userns) that's the UID the RWX FS actually sees. Keeping `HOME` on the RWX PVC (§5) avoids
  "permission denied" on Apptainer's config/keys dir. If PVC writes fail, check `ls -ld
/runner` — it should be group-writable (gid 0); EFS/CephFS honor `fsGroup`, so a missing/odd
  fsGroup on the Pod is the usual cause.
- **`worker-base` must ship `/etc/localtime` (and `/etc/hosts`).** Apptainer bind-mounts both
  into every container by default; the stock UBI9 base has neither, so `apptainer exec` fails
  with `mount source /etc/localtime doesn't exist`. §4 installs `tzdata` and symlinks
  `/etc/localtime`. A quick unblock without a rebuild is `apptainer exec --no-mount bind-paths`
  (skips those default binds), but real runners want them, so fix the image.
- **Make SIFs world-readable in production.** Because the userns UID that reads a SIF isn't
  the UID that wrote it, the robust pattern is: SIFs `chmod 644` (world-read) on the module
  PVC, written by a **librarian** job/CI that mounts the PVC read-write, while consumer
  workers mount it `readOnly: true` and only need read. (The _spike_ mounts `/runner` RW
  because it builds SIFs in-pod with `apptainer pull` — that's a spike convenience, not the
  Phase 4 shape.)
- **Conversion scratch MUST be node-local — not the RWX volume (field finding, not just perf).**
  `apptainer pull`/`build` unpacks the OCI rootfs into `APPTAINER_TMPDIR` using rootless
  hardlinks, and on a network-FS tmp that fails with `unpriv.link … too many links` (EMLINK,
  observed on EFS/NFSv4) — BusyBox alone (hundreds of hardlinked applets) trips it. §5 puts
  `APPTAINER_TMPDIR`/`CACHEDIR` on a node-local `emptyDir` (`/scratch`) sized to hold one
  uncompressed engine image; the finished SIF still lands on the RWX store. Execution
  (squashfuse) unpacks nothing, so exec-only pods need little scratch — which is why heavy
  builds belong in a librarian job, not the worker.
- **SELinux / volume labels:** depending on the storage class (NFS/EFS especially), the RWX
  volume may arrive with labels that block reads from the container context — "permission
  denied" despite correct POSIX perms. Check the CSI driver's relabeling behavior and the
  SCC `seLinuxContext`. CephFS/ODF handles this more gracefully than plain NFS/EFS.
- **First-touch latency + optional prefetch:** squashfuse reads the SIF over the network on
  demand, so the first access to a big Python env can be slow; page cache absorbs repeats.
  For latency-critical cold starts, an `initContainer` that `cp`s the SIF to a local
  `emptyDir` is trivial (a SIF is one file) — measure this against Gate 10's numbers before
  deciding.
- **Never replace a SIF in place while it may be running.** A mounted SIF held open by a
  running pod cannot be overwritten safely — I/O errors result. Use **versioned filenames**
  (`vllm-0.20.sif`, not `vllm-latest.sif`) and a **write-new-then-symlink** update pattern,
  garbage-collecting old versions once no pod holds them open.
- **Sign the library:** the librarian job can `apptainer sign` SIFs and consumers
  `apptainer verify` them (`apptainer.conf` can _require_ verification) — a governance win for
  a shared, admission-bypassing store (see the supply-chain note below).
- **`apptainer` vs `apptainer-suid`:** we install the rootless package on purpose. The setuid
  variant won't help under a restricted SCC and muddies the result.
- **CephFS metadata storm:** SIF (single squashfs file) is what avoids it. If you end up in
  sandbox/extract mode (§9.4), the storm returns — that's the main reason FUSE matters here,
  and why Gate 3's evidence standard is the mount table, not disk usage.
- **`/dev/shm`:** real engines (vLLM especially) want a large `/dev/shm`; the Kubernetes
  default is 64 MB. §5/§8 already mount a `medium: Memory` `emptyDir` at `/dev/shm` for this
  reason — record it as part of the "worker Pod shape" for Phase 4. If Gate 9 still complains
  about shm, the `emptyDir` may need a `sizeLimit` or the node may be short on RAM.
- **Supply chain (record this even in a spike):** SIFs executed off an RWX volume bypass the
  cluster's entire image admission surface — no signature policy, no scanner coverage, no
  `ClusterImagePolicy`. Whatever writes `/runner/sifs` becomes a code-injection path into
  every worker. Apptainer has native answers — `apptainer key newpair` / `apptainer sign` /
  `apptainer verify`, with `apptainer.conf` able to require verification — and Phase 4 must
  adopt them (plus tight RBAC on the module PVC) if this design proceeds. A security
  reviewer will raise this on day one; get ahead of it in the spike write-up.
- **Disconnected clusters:** every `apptainer pull docker://…` and the Gate 9 HF download
  assume egress. Mirror first, or pre-build SIFs in CI and copy them onto the PVC — which,
  incidentally, is closer to the real Phase 4 provisioning flow anyway.
- **This is a throwaway spike.** Nothing here is production config; it exists only to answer
  "can we, and at what privilege cost?" before committing Phase 4 to this design.

---

## 13. The comparison the decision actually needs (pivots & competitors)

A "no-go" needs a pivot, but even a "go" should beat the alternatives — and on OpenShift
two of them attack the same pain **with zero SCC changes and no container runtime inside
the Pod**. Fill this table alongside the scorecard; §10's decision references it.

| Approach                                                                   | Cold start story                                                   | No per-host copy                              | Side-by-side versions        | Hot-add w/o Pod restart           | Privilege cost                                                                                                                    | Supply chain                                          |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------- | ---------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **Apptainer SIF on shared RWX** (this spike; target CephFS, tested on EFS) | lazy page-in off the shared FS (Gate 10; EFS-grade here)           | yes (Gate 3)                                  | yes                          | **yes** (Gate 6)                  | custom seccomp SCC (`Unconfined`) + `/dev/fuse` annotation, in-container userns (no device plugin, no `hostUsers`, no privileged) | bypasses cluster policy; needs SIF signing            |
| **OCI images + `zstd:chunked`** (CRI-O partial/lazy pulls)                 | partial pull of only-needed chunks; local cache persists           | no (per-node cache — but only touched chunks) | yes (two Deployments)        | no (rollout)                      | **none** — stock `restricted-v2`                                                                                                  | full existing pipeline (signing, scanning, admission) |
| **Kubernetes ImageVolumes** (mount an OCI image as a read-only volume)     | image pulled as a volume; runtimes decoupled from the worker image | per-node cache                                | yes (one volume per version) | no (Pod re-admit to add a volume) | none beyond the feature gate/version requirement                                                                                  | full existing pipeline                                |
| **bubblewrap + squashfuse (hand-rolled)**                                  | same as SIF                                                        | yes                                           | yes                          | yes                               | similar userns/seccomp needs, minus Apptainer's tooling                                                                           | roll your own                                         |
| **EasyBuild/Lmod modules on CephFS** (original plan)                       | metadata-storm risk                                                | yes                                           | yes                          | yes                               | none                                                                                                                              | roll your own; heavy authoring cost                   |

How to read it: Apptainer/SIF's unique cell is **hot-add without Pod restart**. If Phase 4
truly requires that (runner-manager dynamically launching engine versions the worker Pod
has never seen), the SCC cost may be worth paying. If a Pod rollout per new _engine
version_ (not per model — model hot-load stays as-is) is acceptable, `zstd:chunked` or
ImageVolumes deliver most of the same wins at zero privilege cost, inside the existing
supply chain. Whichever way the gates land, the Phase 4 write-up should answer _that_
question explicitly, not just "did Apptainer run."
