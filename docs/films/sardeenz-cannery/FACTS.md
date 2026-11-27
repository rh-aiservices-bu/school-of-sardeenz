# Every Gigabyte — what the film claims, and where the metaphor simplifies

| On screen / in the voice | What is true in Sardeenz | Source |
|---|---|---|
| A 22 GB model on a 24 GB GPU leaves 2 GB unused | Arithmetic; the example comes from the project author. Spoken as "the last two sit empty" (2 / 24 is about 8 %) | author's brief |
| "Slices come in fixed sizes" (press tries 4 × 6, 2 × 12, 1 × 24) | Simplified. Real MIG profiles depend on the GPU model and include mixed layouts; the point shown is only that slice sizes are fixed in advance | simplification |
| Sardeenz "keeps a memory ledger and packs each GPU by size" | The control plane tracks a per-device allocation ledger built from each runner's configured `requiredMemory`, and filters workers by free device memory at placement | `docs/architecture/overview.md` (Control Plane; Workload Placement) |
| Generative, predictive and embedding models side by side on one GPU | Runners of different engine types and versions coexist on a worker (vLLM, MLServer). **Inferred, not verified:** that a vLLM model and an MLServer model share the same physical GPU today | `docs/architecture/overview.md` (Engine Runners), `docs/usage/mlserver-models.md` |
| Memory drawn as a length on a 0–24 GB ruler | Placement uses the configured memory requirement; measured VRAM (NVML) is telemetry only | `CLAUDE.md` key design facts |
| "One proxy routes every request to the right model" | The Rust proxy resolves the target from the routing map in Redis/Valkey and forwards directly; several stateless replicas in production | overview, Routing Proxy |
| Idle models "sleep in host RAM" | Sleep level L1 offloads to host RAM. Models can also be stopped, and not every engine supports sleep | overview, Eviction Under Memory Pressure; runner contract |
| A request for a sleeping model is parked; bell rings once | Connection parking and thundering-herd prevention: only the first request triggers the wake | overview, Routing Proxy |
| The least recently used model is swapped out | Eviction strategy is LRU behind a pluggable interface. The film swaps one 8 GB model for another; real eviction frees whatever the incoming model needs | overview, Control Plane |
| "To Kubernetes, nothing moved" | Kubernetes sees static, warm worker Pods that hold the GPUs; scheduling happens at the application layer | ADR-001 |

Not shown: runner packaging as Apptainer SIF files, the admin dashboard, multiple instances per model,
control-plane leader/standby, PostgreSQL and Prometheus.
