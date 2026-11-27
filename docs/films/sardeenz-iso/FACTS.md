# Facts and simplifications

What the film claims, where it comes from, and where the picture simplifies.

| Claim in the film | Basis |
|---|---|
| Sardeenz tracks device memory at the application layer and places models by memory budget, instead of letting Kubernetes allocate a GPU per workload | `docs/architecture/overview.md` (Introduction; Control Plane, "Device memory budget tracking", "Workload placement"); ADR-001 |
| Generative, embedding and predictive models are served by different engines (runners) on the same workers | `docs/architecture/overview.md` (Engine Runners; "Why runners are separate processes"); `docs/usage/mlserver-models.md` |
| One proxy routes every inference request using a routing map | `docs/architecture/overview.md` (Routing Proxy; "Inference Request — Model is Active") |
| A request for a sleeping model is held at the proxy while the model wakes; eviction picks the least recently used model and can offload it to host RAM | `docs/architecture/overview.md` ("Connection parking", "Eviction", "Eviction Under Memory Pressure": "Sleep command (L1: offload to host RAM)"); ADR-014 |
| Kubernetes sees static, allocated GPUs | `docs/architecture/overview.md` (Introduction); ADR-001 |
| A 22 GB model on a 24 GB GPU leaves 2 GB that fixed slicing cannot hand to another workload | The project owner's description of the customer problem (session brief), not a measurement |

## Simplifications

- **Memory as 24 equal cubes.** Real placement compares each model's configured `requiredMemory`
  with the device budget; measured usage is telemetry only.
- **MIG.** Shown as three schemes of equal slices on a 24 GB card (4 × 6, 2 × 12, 1 × 24). Real MIG
  profiles depend on the GPU model and include mixed layouts. The film only relies on the point
  that slice sizes are fixed, so a 22 GB model needs the largest slice and the remainder is not
  offered.
- **Mixed engines on one GPU.** The film puts an LLM and a predictive model on the same GPU. This
  was inferred from the architecture overview (several runners of different engine types per
  worker, capacity-based placement per device); it was not tested for this film.
- **The swap.** One 8 GB model leaves and one 8 GB model arrives. Real eviction frees whatever the
  incoming model needs and may sleep or stop more than one model; not every engine supports sleep.
- **Host RAM** is drawn as a lower step of the board.
- **Requests** are shown one way only; responses are not drawn.
- **Numbers.** 6 models, 2 GPUs, 48 / 48 GB are an illustration, not a benchmark.
