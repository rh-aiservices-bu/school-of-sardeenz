# runners/mlserver — MLServer runner shim

The production MLServer runner. It runs **inside the MLServer SIF** and serves the
[engine-runner contract](../../packages/contracts/specs/engine-runner.yaml) while driving [Seldon
MLServer](https://mlserver.readthedocs.io/) over the KServe V2 Open Inference Protocol. The worker
agent's `ApptainerLauncher` execs it:

```bash
apptainer exec --nv --bind /weights --bind /scratch <sif> \
  python3 -m sardeenz_mlserver_runner --model /weights/<model> --port <PORT> \
  -- --served-model-name <served-name> [<config-name>]
```

The shim lives in the SIF (co-versioned with the engine) so the `worker-base` image stays
engine-agnostic (ADR-010, [phase4.md](../../docs/project/phase4.md) Task 5). Its CLI is
byte-identical to the [vLLM shim's](../vllm/sardeenz_vllm_runner/cli.py) — the worker's argv tail
is shared across runners — but MLServer has no argv pass-through, so the shim extracts the model
identity out of the `--served-model-name` passthrough instead of forwarding it.

## What it does

- Generates (or rewrites) a writable MLServer **model repository** under scratch containing a
  single `model-settings.json`. If the source `--model` dir already ships a `model-settings.json`,
  it is copied with only `name` overridden (and `parameters.uri` rebased to an absolute path);
  otherwise one is generated, inferring the runtime `implementation` from the dir's contents
  (sklearn/xgboost artifacts → `mlserver_sklearn.SKLearnModel`; a HuggingFace repo →
  `mlserver_huggingface.HuggingFaceRuntime`). This enforces the served identity regardless of what
  name the weights happen to carry (#77 lesson).
- Launches `mlserver start <generated-repo-dir>` as a child process — the KServe V2 HTTP server.
  Inference traffic flows straight to that port via the proxy (`/oip/v2/...`, stripped to `/v2/...`
  before forwarding) — it is **not** part of this contract.
- Serves the runner-contract management API on `--port`:

  | Endpoint                             | Behaviour                                                                             |
  | ------------------------------------ | -------------------------------------------------------------------------------------- |
  | `GET /health`                        | `STARTING` (with loading `progress`) → `READY` once MLServer serves; `ERROR` if it dies |
  | `GET /capabilities`                  | Static declaration (`PREDICTIVE`, `LLM`, `EMBEDDING`; `kvCacheElasticSharing: false`)  |
  | `GET /memory-report`                 | Best-effort per-device memory (409 while `STARTING`; 409 for CPU-only sklearn models)  |
  | `POST /sleep`                        | `L1_HOST_RAM` → KServe V2 `POST /v2/repository/models/{name}/unload`                   |
  | `POST /wake`                         | KServe V2 `POST /v2/repository/models/{name}/load`                                     |
  | `GET /sleep-status`, `GET /progress` | State introspection                                                                     |

- On SIGTERM (uvicorn → lifespan shutdown) it SIGTERMs the MLServer process group, then SIGKILLs
  after a grace period — the whole tree drains on one signal (mirrors the vLLM shim / spike Gate 5).

## Sleep/wake semantic difference (read before relying on `L1_HOST_RAM`)

Unlike vLLM's `/sleep`, which explicitly offloads weights to host RAM, MLServer's repository
`/unload` simply stops serving the model; on `/load` it re-reads the model artifact from the model
repository. In practice the OS page cache keeps that artifact warm (≈ host RAM) for the small
models this runtime targets, but it is not a guaranteed offload the way vLLM's is. The shim still
advertises `supportedSleepLevels: ["L1_HOST_RAM"]` for v1 (it is the best available approximation);
`L2_DISK` is intentionally not added.

## MLServer bind address, ports, and the extra-`engineArgs` caveat

- `MLSERVER_HOST=0.0.0.0` (matching the vLLM shim's `--engine-host` default since #159) and
  `MLSERVER_HTTP_PORT=<engine-port>` configure MLServer's bind via env, the documented
  `MLSERVER_`-prefixed override mechanism.
- MLServer also binds a gRPC server and a Prometheus metrics server even in this REST-only
  deployment. The shim derives `MLSERVER_GRPC_PORT`/`MLSERVER_METRICS_PORT` from the engine port
  (`+10000`/`+20000` by default, overridable via `SARDEENZ_MLSERVER_GRPC_PORT`/
  `SARDEENZ_MLSERVER_METRICS_PORT`). **These offset defaults are cluster-validated, not yet
  proven**: the real fix (the worker reserving a 4-port block per oip runner) is a follow-up on the
  worker's port allocator, out of this shim's scope.
- **v1 limitation:** any `engineArgs` forwarded after `--served-model-name` are parsed off and
  **ignored** (with a startup warning) — MLServer's configuration is file/env-based, so there is no
  argv pass-through equivalent to vLLM's.

## Layout

```
sardeenz_mlserver_runner/
├── __main__.py   # `python3 -m sardeenz_mlserver_runner` entrypoint (uvicorn)
├── app.py        # FastAPI wiring + STARTING→READY health poller
├── cli.py        # arg parsing + served-name extraction + aux-port derivation (pure)
├── settings.py   # writable model-repository generation/rewrite (pure + filesystem)
├── engine.py     # MLServer subprocess lifecycle + KServe V2 repository client
├── memory.py     # best-effort device memory report (verbatim from the vLLM shim)
└── state.py      # RunnerState machine + contract-shape response builders + V2 path builders (pure)
```

## Notes

- **Sleep level:** the contract defines only `L1_HOST_RAM` (v0.1) — see the semantic-difference
  note above.
- **Memory attribution** is best-effort, identical to the vLLM shim's `memory.py`. CPU-only
  sklearn models introspect no CUDA device, so `/memory-report` answers 409.
- **Dependencies** (`fastapi`, `uvicorn`, `httpx`, `mlserver`, `mlserver-sklearn`,
  `mlserver-huggingface`, `torch`) come from the `runner-mlserver` image; `pyproject.toml` lists
  them for dev installs but does not pin them.

## Tests

`cli.py`/`settings.py`/`state.py`/`memory.py` are pure (or filesystem-only) and unit-tested without
MLServer/torch/httpx/FastAPI:

```bash
cd runners/mlserver && python3 -m pytest
```

The engine + HTTP layers are exercised by the Phase 4-style cluster integration gates (Unit D).
