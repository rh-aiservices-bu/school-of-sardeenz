# Phase 4 — SIF runtime performance record

Perf record for the SIF runtime, kept as the target-backend evidence for Phase 4 Task 10. Fill the
CephFS/ODF columns by running `tests/gates/run-gates.sh --gpu` on the target cluster (Gate 10
prints the spawn timings). The EFS column is the spike's floor.

> **Backends:** the [spike](phase4-apptainer-spike.md) ran on **AWS EFS (NFSv4)** — a first-class
> but NFS-grade proof point. **CephFS/ODF is the production target** and may do better on the
> no-copy exec and cold-start economics. Treat EFS as a solid-but-not-best-case floor.

## Spawn timings (Gate 10)

`apptainer exec` of the vLLM SIF off the shared RWX volume. "Cold" = first exec on a node (SIF not
yet paged in); "warm" = repeat exec.

| Metric                                         | EFS (NFSv4) — spike floor          | CephFS/ODF — target | Notes                       |
| ---------------------------------------------- | ---------------------------------- | ------------------- | --------------------------- |
| Cold `apptainer exec` (trivial cmd)            | _TBD (GPU gate deferred in spike)_ | _record_            | squashfuse page-in          |
| Warm `apptainer exec` (trivial cmd)            | _TBD_                              | _record_            | cached                      |
| Cold engine cold-start to READY (real weights) | _TBD_                              | _record_            | Gate 9c substrate           |
| Image-pull baseline (for comparison)           | n/a                                | _record_            | the thing SIF-exec replaces |

## kvcached co-tenancy (Gate 9)

| Check                                                              | EFS                      | CephFS/ODF |
| ------------------------------------------------------------------ | ------------------------ | ---------- |
| Two runners share one GPU via kvcached (elastic, not static split) | _TBD_                    | _record_   |
| Concurrent cold-start OOM avoided by serialization (Gate 9c)       | passed (spike, host-RAM) | _confirm_  |

## Backend behaviour re-check (spike §12)

The in-container-userns path is FS-agnostic; confirm it is unchanged on CephFS:

| Property                                                         | EFS (spike)                          | CephFS/ODF                                                     |
| ---------------------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------- |
| Unprivileged userns works                                        | yes                                  | _confirm_                                                      |
| `hostUsers: false` unusable (no idmapped mounts)                 | yes                                  | _confirm (expected yes on current RHCOS)_                      |
| OCI→SIF unpack needs node-local scratch                          | yes (`unpriv.link … too many links`) | _confirm_                                                      |
| squashfuse runs the SIF in place (no extraction)                 | yes                                  | _confirm_                                                      |
| World-readable SIF readable under arbitrary UID (SELinux/labels) | yes                                  | _confirm — CephFS handles labels more gracefully than NFS/EFS_ |

## How to record

```bash
oc cp tests/gates/run-gates.sh <worker-pod>:/tmp/run-gates.sh -n sardeenz
oc exec -it <worker-pod> -n sardeenz -- bash /tmp/run-gates.sh --gpu   # prints MEASURE: lines
```

Paste the `MEASURE:` outputs into the tables above and note the cluster + StorageClass + date.
