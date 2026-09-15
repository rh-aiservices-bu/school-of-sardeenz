# tests/gates — Phase 4 SIF runtime gate suite

`run-gates.sh` automates the [Phase 4 Apptainer spike](../../docs/project/phase4-apptainer-spike.md)
gates against a real cluster, so the spike's manual runbook becomes a repeatable check (Task 9).

## What it checks

| Gate | Checks                                                                              | Requires                      |
| ---- | ----------------------------------------------------------------------------------- | ----------------------------- |
| 0    | Fingerprint: `apptainer` present, `max_user_namespaces>0`, `Seccomp:0`, `/dev/fuse` | 4.15+ Pod                     |
| 1    | In-container userns: `unshare --user --map-root-user` → uid 0                       | 4.15+ Pod                     |
| 2    | Build + exec a SIF (node-local `APPTAINER_TMPDIR`)                                  | egress to a registry          |
| 3    | No-copy: `squashfuse` serves the SIF + near-zero scratch growth                     | —                             |
| 4    | Weights via `--bind`                                                                | writable/readable weights vol |
| 5    | Long-lived runner + clean SIGTERM, no orphan/zombie                                 | —                             |
| 6    | Two SIFs side by side; a new SIF hot-adds with no restart                           | —                             |
| 7    | GPU visible via `--nv`                                                              | GPU + NVIDIA GPU Operator     |
| 8    | ipc/pid/net namespace sharing across the SIF                                        | GPU node                      |
| 9    | **Two runners share one GPU via kvcached**, driven through the worker agent         | GPU + vLLM SIF + agent        |
| 10   | Cold/warm spawn measurement on the target RWX backend                               | vLLM SIF                      |
| 11   | **MLServer runner launch → READY → stop**, driven through the worker agent          | GPU + MLServer SIF + agent    |

Gates 0–6 are the **CPU gates** — they run on any 4.15+ worker Pod. Gates 7–11 and the Gate 10
measurement are the **`cluster-gpu`** set — skipped unless `--gpu` is passed or a GPU is detected.
Gate 11 additionally degrades to `skip` when no `MLSERVER_SIF` is present, independent of `--gpu`.

## Run

Copy it into a worker Pod and run it there (it uses the Pod's Apptainer/userns/`/dev/fuse`):

```bash
oc cp tests/gates/run-gates.sh <worker-pod>:/tmp/run-gates.sh -n sardeenz
oc exec -it <worker-pod> -n sardeenz -- bash /tmp/run-gates.sh          # CPU gates
oc exec -it <worker-pod> -n sardeenz -- bash /tmp/run-gates.sh --gpu    # + GPU gates
```

Overridable via env: `MODULES_DIR` (`/modules`), `SCRATCH_DIR` (`/scratch`), `WEIGHTS_DIR`
(`/weights`), `VLLM_SIF` (`/modules/vllm-0.21.sif`), `MLSERVER_SIF` (`/modules/mlserver-1.6.sif`),
`AGENT_URL` (`http://127.0.0.1:9100`).

Exit code is non-zero if any non-skipped gate fails, so it can gate CI on a cluster with a runner.
Gate 9 is decisive (the kvcached co-tenancy claim); Gate 10 records perf for the Task 10 CephFS
comparison against the spike's EFS floor; Gate 11 is the MLServer launch/stop/health check for
issue #125, run alongside Gate 9/10 in the GPU/agent block since MLServer's real (non-CPU-sklearn)
runtimes are GPU-backed — it skips cleanly without `MLSERVER_SIF`.
