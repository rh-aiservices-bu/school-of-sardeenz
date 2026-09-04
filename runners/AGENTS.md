# Runners — AGENTS.md

Everything that runs _on a worker_: the worker agent, the engine-runner shims that live inside
SIFs, and the shared contract-conformance suite.

**Contract:** [`packages/contracts/specs/engine-runner.yaml`](../packages/contracts/specs/engine-runner.yaml)

- [`docs/architecture/components/runner-contract.md`](../docs/architecture/components/runner-contract.md)
  (state model, ports, sleep levels, capabilities, how to add a runner type).
  **Worker agent API:** `packages/contracts/specs/worker-agent.yaml`. **Design:** ADR-010 (runners),
  ADR-011 (capabilities/placement), ADR-015 (SIF delivery), ADR-016 (worker security).
  **Runtime delivery and images:** [`containers/`](../containers/README.md), [`deployment/AGENTS.md`](../deployment/AGENTS.md).

## Layout

| Directory      | Language   | What it is                                                                                                                                                                                                                                          |
| -------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dev-worker/`  | TypeScript | The worker agent (registration, heartbeat, NVML sampling, runner lifecycle). `SARDEENZ_WORKER_MODE=stub` launches in-process runner stubs for containerless dev; `apptainer` mode execs SIFs via `ApptainerLauncher`. Same code path in production. |
| `vllm/`        | Python     | vLLM runner shim (`sardeenz_vllm_runner`) — wraps `vllm serve` + kvcached, serves the contract on the management port. [README](vllm/README.md)                                                                                                     |
| `mlserver/`    | Python     | MLServer runner shim (`sardeenz_mlserver_runner`) — KServe V2 / OIP. [README](mlserver/README.md)                                                                                                                                                   |
| `conformance/` | Python     | Shared pytest suite run against every shim's real FastAPI app via `sardeenz_<engine>_runner.testing`. [README](conformance/README.md)                                                                                                               |

## Rules

- **One argv tail for all shims:** `python3 -m sardeenz_<engine>_runner --model … --port … -- …`.
  The worker does not know engine specifics; keep the CLI byte-compatible across shims.
- **Ports:** each runner gets a 4-port block from `SARDEENZ_RUNNER_PORT_START` (management,
  engine, gRPC, metrics). Never hard-code ports in a shim.
- **Adding a runner type:** Containerfile in `containers/runner-<engine>/`, shim package here with
  a `testing.py` adapter, register it in `conformance/conftest.py` `_BUILDERS`, catalog entry in
  `runners.yaml`, then follow "Adding a New Runner Type" in the contract doc.
- **Measured memory:** the worker reports NVML-measured bytes with per-instance attribution
  (`measured-sample.ts`, `nvml.ts`). Do not fabricate memory figures in stubs beyond the
  contract-valid canned report.
- **Security posture (ADR-016):** the launch path is `apptainer exec --nv` with binds limited
  to weights + scratch (override via `SARDEENZ_APPTAINER_BINDS`). Do not widen it without an
  ADR update.

## Build & Test

```bash
npm run typecheck -w @sardeenz/dev-worker && npm run test -w @sardeenz/dev-worker
make test-python-deps   # once, inside a venv: installs vllm[test] + mlserver[test] (no torch/vLLM)
make test-python        # shim unit tests + conformance suite (also a required CI job)
```

Local worker: `make dev-worker` (stub mode) — config in `dev-worker/src/config.ts`.
