# deployment/sif-runner

The cluster-side security posture and workload for the SIF runner runtime (Phase 4 Task 8,
[ADR-016](../../docs/architecture/adrs/adr-016-sif-worker-security-posture.md)). Materializes the
spike's §5/§8 manifests as a reusable Kustomize base.

## Contents

| File | What it is |
|---|---|
| `scc.yaml` | `sardeenz-sif-runner` SCC — restricted-v2 + seccomp `Unconfined` (the userns unlock). No privilege, no added caps. |
| `rbac.yaml` | `sardeenz-worker` ServiceAccount + Role/RoleBinding granting `use` on the SCC. |
| `pvcs.yaml` | RWX `sardeenz-modules` (module store) + `sardeenz-weights` claims. Set `storageClassName` per cluster. |
| `worker-deployment.yaml` | The worker Pod: `/dev/fuse` annotation, seccomp `Unconfined`, no `hostUsers:false`, GPU limit, mem req/limit, `fsGroup:0`, `HOME=/scratch/home`, module (readOnly)/weights/scratch/`/dev/shm` mounts. Runs the agent `--mode=apptainer`. |
| `module-pvc-write-protection.yaml` | ValidatingAdmissionPolicy denying non-librarian pods that mount the module PVC read-write (chosen mechanism; fallbacks documented inline). |
| `containerruntimeconfig.yaml` | *Opt-in* — force `crun` if a node pool defaults to `runc`. Not in the default kustomization (triggers a MachineConfig roll). |

## Apply

```bash
oc apply -k deployment/sif-runner/
# Activate module write-protection in the namespace:
oc label namespace sardeenz sardeenz.io/module-guard=enforce
```

The `sardeenz-worker` image is `worker-base` (Apptainer + Node) with the built TypeScript worker
agent layered on top at `/opt/sardeenz/worker-agent` (running `node dist/index.js --mode=apptainer`).

## SIF signing public key

The worker imports the SIF signing **public** key so `apptainer verify` trusts SIFs at exec. The
Deployment mounts an optional ConfigMap `sardeenz-sif-signing-pubkey` at
`/etc/sardeenz/keys/sardeenz-sif-signing.pub`. That ConfigMap is produced by the librarian key
setup — see [`../librarian/`](../librarian/) (Task 7). Until it exists the mount is skipped
(`optional: true`).

The container's entrypoint **fails fast** instead of silently running unverified: with
`SARDEENZ_VERIFY_SIF=true` (the default), after attempting the key import it checks
`apptainer key list` for at least one key and exits 1 with a clear error if the keyring is empty
— a Pod that would otherwise start serving with `apptainer verify` disabled by omission never
comes up. Distribute the ConfigMap before serving real modules, or set `SARDEENZ_VERIFY_SIF=false`
for environments (e.g. dev) that intentionally run unsigned SIFs.

## Prerequisites & caveats

- OpenShift/OKD **4.15+** (4.21 tested), `crun`, a shared RWX StorageClass, rights to create an SCC.
- **SELinux / volume labels** (spike §12): on some CSI drivers (NFS/EFS) the RWX volume can arrive
  with labels that block reads despite correct POSIX perms. If a worker gets "permission denied"
  reading a world-readable SIF, check the CSI relabeling behavior and the SCC `seLinuxContext`.
  CephFS/ODF handles this more gracefully — verify on the target backend (Task 10).
- Pre-4.15 **Managed** OpenShift (ROSA/ARO) is unsupported: the `/dev/fuse` path there needs a
  CRI-O MachineConfig that Managed OpenShift forbids (phase4.md platform caveat).
