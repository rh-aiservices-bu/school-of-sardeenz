# runners/conformance — shared engine-runner contract-conformance suite

Executable forcing-function for the engine-runner contract
([`packages/contracts/specs/engine-runner.yaml`](../../packages/contracts/specs/engine-runner.yaml),
[`docs/architecture/components/runner-contract.md`](../../docs/architecture/components/runner-contract.md)):
one shared pytest suite, parametrized over every runner shim, asserting the same contract shapes
and state transitions against each shim's **real** FastAPI app — not a reimplementation of the
contract per shim.

## Fixture contract

Each shim provides a test-only adapter module, `sardeenz_<engine>_runner.testing`, exposing:

```python
def build_conformance_app() -> fastapi.FastAPI: ...
```

The adapter patches the shim's module-global engine/memory seams (e.g. `VllmEngine`/`MLServerEngine`,
`memory_report`) with a fake engine and a canned, contract-valid memory report, then calls the
shim's real `create_app(args)` — no vLLM/MLServer/torch/GPU required. This is a one-way dependency:
the shared suite here depends only on the adapter contract, never on shim-internal class or
function names.

Adding a new runner to this suite: implement `sardeenz_<engine>_runner/testing.py` following the
existing two adapters, then add it to `_BUILDERS` in `conftest.py`.

## What it checks

The 8 named cases in `test_engine_runner_contract.py` cover `/health`, `/capabilities`,
`/memory-report`, `/progress`, `/sleep-status`, `/sleep` (bad level, bad/missing body), and the
`/sleep` → `/sleep-status` → `/wake` → `/sleep-status` state-machine transition — the same
transition both shims' `state.py` response builders must produce identically.

## Run

Needs `fastapi` + `httpx` (from the two shims' own dependencies — installed editable alongside):

```bash
pip install -e runners/vllm -e runners/mlserver
python -m pytest runners/conformance
```

Not part of `make test` / CI (CI runs `tsc`/`eslint`/`redocly`/`clippy`/`vitest`/`cargo test` — no
pytest), matching the shims' own unit suites. Run it in a dev venv or inside a runner SIF.
