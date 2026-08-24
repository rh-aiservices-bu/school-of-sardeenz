# runners/vllm — vLLM runner shim

The production vLLM runner. It runs **inside the vLLM SIF** and serves the [engine-runner
contract](../../packages/contracts/specs/engine-runner.yaml) while driving vLLM + kvcached. The
worker agent's `ApptainerLauncher` execs it:

```bash
apptainer exec --nv --bind /weights --bind /scratch <sif> \
  python3 -m sardeenz_vllm_runner --model /weights/<model> --port <PORT>
```

The shim lives in the SIF (co-versioned with the engine) so the `worker-base` image stays
engine-agnostic (ADR-010, [phase4.md](../../docs/project/phase4.md) Task 5).

## What it does

- Launches `vllm serve <model> --host 127.0.0.1 --port <engine-port> --enable-sleep-mode` as a
  child process (the OpenAI-compatible inference server). Inference traffic flows straight to that
  port via the proxy — it is **not** part of this contract.
- Serves the runner-contract management API on `--port`:

  | Endpoint                             | Behaviour                                                                           |
  | ------------------------------------ | ----------------------------------------------------------------------------------- |
  | `GET /health`                        | `STARTING` (with loading `progress`) → `READY` once vLLM serves; `ERROR` if it dies |
  | `GET /capabilities`                  | Static declaration; sets `features.kvCacheElasticSharing` when kvcached is on       |
  | `GET /memory-report`                 | Best-effort per-device memory (409 while `STARTING`)                                |
  | `POST /sleep`                        | Maps `L1_HOST_RAM` → vLLM `/sleep?level=1` (weights → host RAM)                     |
  | `POST /wake`                         | vLLM `/wake_up`                                                                     |
  | `GET /sleep-status`, `GET /progress` | State introspection                                                                 |

- On SIGTERM (uvicorn → lifespan shutdown) it SIGTERMs the vLLM process group, then SIGKILLs after
  a grace period — the whole tree drains on one signal (spike Gate 5).

## Layout

```
sardeenz_vllm_runner/
├── __main__.py   # `python3 -m sardeenz_vllm_runner` entrypoint (uvicorn)
├── app.py        # FastAPI wiring + STARTING→READY health poller
├── cli.py        # arg parsing + `vllm serve` command construction (pure)
├── engine.py     # vLLM subprocess lifecycle + dev-endpoint (/sleep, /wake_up) client
├── memory.py     # best-effort device memory report
└── state.py      # RunnerState machine + contract-shape response builders (pure)
```

## Notes

- **kvcached sleep levels:** the contract defines only `L1_HOST_RAM` (v0.1) → vLLM sleep level 1.
- **Memory attribution** is best-effort: under kvcached co-tenancy two runners share a device pool
  elastically, so exact per-runner bytes aren't recoverable. The shim reports this process's
  reserved CUDA memory.
- **Dependencies** (`fastapi`, `uvicorn`, `httpx`, `vllm`, `torch`, `kvcached`) come from the
  `runner-vllm` image; `pyproject.toml` lists them for dev installs but does not pin them.

## Tests

`cli.py`/`state.py` are pure and unit-tested without vLLM/torch:

```bash
cd runners/vllm && python3 -m pytest
```

The engine + HTTP layers are exercised by the Phase 4 cluster integration gates (Task 9).
