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
- **Adding a runner type:** Containerfile in `containers/runners/<engine>/<version>/`, shim package here with
  a `testing.py` adapter, register it in `conformance/conftest.py` `_BUILDERS`, catalog entry in
  `runners.yaml`, then follow "Adding a New Runner Type" in the contract doc.
- **Measured memory:** the worker reports NVML-measured bytes with per-instance attribution
  (`measured-sample.ts`, `nvml.ts`). Do not fabricate memory figures in stubs beyond the
  contract-valid canned report.
- **Shim memory scope (#244):** a shim without an NVML binding cannot attribute device memory to
  its own process (the engine is a child), so shims report the whole-device used figure with
  `attribution: "device"`; a runtime that can introspect no CUDA device fails closed with `409`.
  Never re-sum device-scope rows across runners on the consumer side — the per-runner display
  rule belongs to the consumer layers (Phase 5 owns it). Declare the scope on every device entry
  (`runner` only for genuinely process-attributed figures, like the in-repo runner-stub).
  Consumers treat an absent `attribution` as unknown scope.
- **Drain signal convention (#239):** a shim derives `activeRequests` by scraping its engine's
  Prometheus `/metrics` and reporting `None`/absent when the scrape fails or half-parses —
  unknown is never reported as `0`, because the control plane's drain loop treats `0` as
  "drained" but a missing field as "keep waiting". A half-parsed scrape (one of the expected
  series absent, any non-finite sample) is unknown, not drained.
- **Security posture (ADR-016):** the launch path is `apptainer exec --nv` with binds limited
  to weights + scratch (override via `SARDEENZ_APPTAINER_BINDS`). Do not widen it without an
  ADR update.
- **Entrypoint allowlist (#238):** the worker rejects `POST /runners` `entrypoint` argv that is
  not its configured `SARDEENZ_RUNNER_ENTRYPOINT` verbatim (or a `<exec> -m <known-shim-module>`
  invocation when that vector has the 3-token `-m` shape). A new shim module needs either the
  catalog entry to carry a vector the worker accepts or a worker release adding it to
  `KNOWN_SHIM_MODULES` (`dev-worker/src/entrypoint-allowlist.ts`); an unusable configured vector
  fails worker startup in `loadConfig`.

## Build & Test

```bash
npm run typecheck -w @sardeenz/dev-worker && npm run test -w @sardeenz/dev-worker
make test-python-deps   # once, inside a venv: installs vllm[test] + mlserver[test] (no torch/vLLM)
make test-python        # shim unit tests (incl. the tests/test_app.py app-level harnesses) + conformance suite (also a required CI job)
```

Local worker: `make dev-worker` (stub mode) — config in `dev-worker/src/config.ts`.
