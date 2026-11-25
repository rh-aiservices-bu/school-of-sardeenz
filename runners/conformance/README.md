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
# A set of behaviours the suite may parametrise on (never a shim name).
CONFORMANCE_FEATURES: frozenset[str]

# The shim's app module and the globals build_conformance_app() replaces. The suite records each
# as an undo target before building, so no double outlives a case (see below).
APP_MODULE: types.ModuleType
PATCHED_SEAMS: tuple[str, ...]

def build_conformance_app(*, ready: bool = True, alive: bool = True) -> fastapi.FastAPI: ...
#   ready=False → the poller never reports readiness: the runner stays STARTING
#   alive=False → the poller's first check sees a dead process: the runner flips ERROR
```

The adapter patches the shim's module-global engine/memory seams (e.g. `VllmEngine`/`MLServerEngine`,
`memory_report`) with a fake engine and a canned, contract-valid memory report, then calls the
shim's real `create_app(args)` — no vLLM/MLServer/torch/GPU required. Because those seams live in
the app module, each client fixture registers every `PATCHED_SEAMS` entry as undo targets *before*
building and restores them once the app's lifespan has shut down: in the combined `pytest`
invocation (`make test-python`, CI) the shims' own unit suites, which read the real seams off the
app module, must never see this suite's doubles. This is a one-way dependency:
the shared suite here depends only on the adapter contract, never on shim-internal class or
function names.

The zero-argument call is the happy path: every pre-#252 fixture and both shims' `tests/test_app.py`
harnesses use it, and its behaviour is unchanged. An adapter declaring
`"sleep-active-request-guard"` must additionally accept `active_requests=<int | None>` — the
in-flight count its scrape seam reports.

Adding a new runner to this suite: implement `sardeenz_<engine>_runner/testing.py` following the
existing two adapters, then add it to `_BUILDERS` in `conftest.py`.

## What it checks

The 13 named cases in `test_engine_runner_contract.py` cover `/health`, `/capabilities`,
`/memory-report`, `/progress`, `/sleep-status`, `/sleep` (bad level, bad/missing body, `409` while
`STARTING`, the in-flight-request guard), `/wake` from a non-sleeping runner, `ERROR` surfaced in
`/health` after the engine dies, and the `/sleep` → `/sleep-status` → `/wake` → `/sleep-status`
state-machine transition — the same transition both shims' `state.py` response builders must
produce identically. 12 of them run against every shim (25 tests today: the 8 original cases + 4
conflict/error cases × 2 shims, plus 1 capability-gated). The `/memory-report` shape case also
asserts that every **current emitter declares** a memory `attribution` scope (`runner` or `device`,
#244) — the field stays optional in the contract for legacy images, but the shims under this suite
must declare one.

## Capability-gated cases

A few runner behaviours differ by *what a shim can do*, not by who wrote it. Those cases are
parametrised over adapters that declare the behaviour in `CONFORMANCE_FEATURES`, never over a
shim name: `test_sleep_409_with_active_requests` runs only for adapters declaring
`sleep-active-request-guard` (today: the vLLM shim — MLServer observes the in-flight gauge but
cannot block a sleep on it). A new shim joins the case by declaring the flag and accepting
`active_requests=` on its builder, with no edit here.

The `409 NOT_READY` it asserts fits the spec's `409` for `/sleep` — "Runner cannot sleep from its
current state (only valid from `READY`), or sleep is not supported by this runner type", with
`code` free-form in `ErrorResponse`: the declared guard reads "current state" as covering in-flight
work, i.e. a `READY` runner mid-inference cannot sleep. In-spec, not a second divergence, even
though the reported state is `READY` rather than `STARTING`.

Rejected alternatives: a `skip` marker needs the case to know which shim to skip — the suite
would encode runner identity and turn a real behavioural difference into a green skip; and
adding a runtime flag to `/capabilities.features` would change shim behaviour (this issue is
tests + test adapters only) and export a field the control plane has no use for.

## Known divergences from the contract

The suite is the executable forcing function for `engine-runner.yaml`, so a case that pins
behaviour the spec does not describe is called out here instead of being asserted silently.

### `/wake` from a non-sleeping runner returns `200` (#252, decided 2026-11-25)

`engine-runner.yaml` documents `409 — Runner is not sleeping` for `/wake`. Neither shim checks its
state: both call the engine's wake (`POST /wake_up` for vLLM, repository `load` for MLServer) and
answer `200 {"state": "READY"}`. `test_wake_from_non_sleeping_returns_200` pins that `200`; no
shim runtime behaviour changes in #252. The control plane wakes whatever instance it is handed
(its sleep/wake path only conditionally claims `SLEEPING → STARTING`), so adopting the contract's
`409` would turn a spuriously-woken READY runner into an error transition there. Aligning contract
and behaviour — including that consumer consequence — is tracked as follow-up
[#323](https://github.com/rh-aiservices-bu/school-of-sardeenz/issues/323): #252 pins the `200`,
#323 owns the alignment. The same missing guard also lets `/wake` succeed from `STARTING` and
`ERROR` (flipping the runner to `READY`), which #323 must decide alongside the `409`.

Observed but not asserted here (out of scope for #252): `/health` answers `200` in `STARTING`
(with a `progress` block) where the spec's summary lists `503` for "alive but not yet
initialized".

## Run

Needs `fastapi` + `httpx` + `pytest` (installing the two shims with their `[test]` extra pulls
all three — no vLLM/MLServer/torch/GPU):

```bash
pip install -e "runners/vllm[test]" -e "runners/mlserver[test]"
python -m pytest runners/conformance
```

Runs in CI as the dedicated `python` job (`.github/workflows/ci.yml`) and locally via
`make test-python` (after `make test-python-deps`), which runs this suite together with both shims'
unit suites in one `pytest` invocation. Can also be run directly in a dev venv or inside a runner SIF.
