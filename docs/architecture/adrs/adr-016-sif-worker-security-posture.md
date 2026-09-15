# ADR-016: Worker Security Posture for SIF Execution

## Status

Accepted. Implements the security half of [ADR-015](adr-015-sif-runtime-packaging.md).

## Context

Running an Apptainer SIF unprivileged inside an OpenShift Pod needs two things the default
security posture denies:

1. **Unprivileged user namespaces.** Apptainer creates its own user + mount namespace to mount
   the SIF. OpenShift's default `restricted-v2` SCC admits Pods with seccomp `RuntimeDefault`,
   whose profile blocks `unshare`/`clone` with new-namespace flags for unprivileged processes.
   This is the primary blocker — **no capability grant fixes it**; the Pod must be allowed to
   run with `seccompProfile: Unconfined`.
2. **`/dev/fuse`.** Direct (no-copy) SIF mounting uses `squashfuse`, which needs `/dev/fuse`.

OpenShift/OKD 4.21 ships a "Kubernetes-native" path for this — the `nested-container` SCC with
pod-level user namespaces (`hostUsers: false`, `userNamespaceLevel: RequirePodLevel`). The Phase
4 spike found it **unusable for our design**: `hostUsers: false` makes the kubelet bring every
volume into the Pod's user namespace via **idmapped mounts**, which the shared RWX filesystems
do not support — AWS EFS/NFSv4 cannot, and CephFS only gained kernel idmapped-mount support in
Linux 6.7 (RHCOS on current 4.x ships ~5.14). The result is a hard failure at container create:
`mount_setattr … doesn't support idmap mounts on this kernel`. Since the whole design is built
on a shared RWX volume, the pod-level-userns path is a dead end today.

## Decision

Workers run SIFs via **in-container user namespaces** (Apptainer creates its own userns _inside_
the container, which stays in the host user namespace so RWX volumes mount normally). The
worker Pod's security posture is:

- **A mild custom SCC** — `restricted-v2` with exactly one change: `seccompProfiles` permits
  `unconfined`. **No added capabilities, no `RunAsAny`, no `allowPrivilegeEscalation`, no
  `hostUsers`/`procMount`, not privileged.** The Pod requests `seccompProfile: { type:
Unconfined }`.
- **`/dev/fuse` via the CRI-O pod annotation** `io.kubernetes.cri-o.Devices: "/dev/fuse"` — no
  device plugin, no MachineConfig on OpenShift/OKD 4.15+ (available by default on recent
  releases).
- **`crun` as the container runtime** (the default on modern 4.x; it is the runtime with
  user-namespace support).
- **Explicitly NOT** `hostUsers: false` and **NOT** the `nested-container`/`restricted-v3` SCC,
  for the idmapped-mount reason above.

This posture was verified on a live OKD 4.21 cluster: `Seccomp: 0`, `max_user_namespaces > 0`,
`/dev/fuse` present, and `unshare --user --map-root-user` succeeds inside the container.

## Consequences

- **Mild but custom.** A pass here is the strongest "mild SCC" claim available — no privileged,
  no capabilities — but it is a _custom_ SCC, not a stock/shipped one (the shipped
  `nested-container` can't be used with network RWX volumes). A security reviewer will ask about
  blanket `Unconfined`; the productization endgame is a **scoped seccomp profile**
  (`RuntimeDefault` + allow `unshare`/`clone`/`mount`/`setns`) shipped via the Security Profiles
  Operator, which removes the blanket-`Unconfined` concern. That is post-Phase-4 hardening, not
  a blocker.
- **RWX-agnostic, storage-limited on the pod-userns path.** The in-container path works on any
  RWX backend. The `hostUsers: false` path could only be reconsidered on a backend whose CSI
  advertises idmapped-mount support (some block/local classes do; EFS/NFS and CephFS-on-RHCOS
  do not today) — re-test on a newer-kernel CephFS if that ever matters.
- **No UID-range tuning needed.** Apptainer uses single-UID mapping on this path, so the
  `openshift.io/sa.scc.uid-range ≤ 65535` caveat that applies to pod-level userns does not
  apply here.
- **Two benign warnings are expected** and documented in the spike: `Could not remount
/.singularity.d/libs read-only` (the `--nv` driver-lib bind; the read-only re-mount needs
  `CAP_SYS_ADMIN` we don't grant — cosmetic), and rootless `newgidmap`/`newuidmap` EPERM on
  `setxattr` during `apptainer pull` (unused in single-UID mode).
- **Cluster prerequisites** for a runner-hosting worker: OpenShift/OKD 4.15+ (for the `/dev/fuse`
  annotation), rights to create + bind the custom SCC, and `crun` on the worker nodes.
- **`/dev/fuse` on Managed OpenShift:** on **4.15+** the annotation needs no MachineConfig, so it
  works on ROSA/ARO too. On clusters **older than 4.15** it requires a CRI-O MachineConfig, which
  Managed OpenShift forbids — so pre-4.15 Managed OpenShift is unsupported for this design (spike
  §9.4). Sardeenz targets self-managed 4.15+, so this is a documented constraint.
- **Writable HOME must be node-local.** Under the arbitrary OpenShift UID, Apptainer needs a
  writable config/keys dir. Since the module store is mounted **read-only** (ADR-017) and the
  weights volume is model data, `HOME` points at a node-local writable path (`/scratch/home`),
  created group-writable (gid 0) so the assigned UID can write it. `HOME` is set as a container
  env var, **not** via `apptainer --env` (Apptainer rejects overriding HOME that way).
- **SELinux / volume labels can still block reads.** On some storage classes (NFS/EFS especially)
  the RWX volume may arrive with labels that deny reads from the container context despite correct
  POSIX perms. If that happens, check the CSI driver's relabeling behavior and the SCC
  `seLinuxContext`; CephFS/ODF handles this more gracefully than plain NFS/EFS. Verify on the
  target backend.
