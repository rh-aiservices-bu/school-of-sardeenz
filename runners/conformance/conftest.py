"""Fixtures for the shared engine-runner conformance suite.

One adapter per shim (`sardeenz_<engine>_runner.testing.build_conformance_app`); the fixtures
select the fake engine's starting state — ready, never ready (STARTING), dead (ERROR) — so the
suite can assert the contract's conflict and failure paths without a real engine.
"""

import contextlib

import pytest
from fastapi.testclient import TestClient
from sardeenz_mlserver_runner import testing as _mlserver
from sardeenz_vllm_runner import testing as _vllm

# Shim name → its `sardeenz_<engine>_runner.testing` adapter module. The module (not just its
# builder) is what the suite holds: the module carries `CONFORMANCE_FEATURES` and the builder.
_BUILDERS = {"vllm": _vllm, "mlserver": _mlserver}
_SHIM_IDS = list(_BUILDERS)

# Adapter-declared capability (#252): a shim whose /sleep refuses while requests are in flight
# declares it, and its builder accepts ``active_requests=``. A case is never keyed on a shim name
# — see README "Capability-gated cases".
SLEEP_ACTIVE_REQUEST_GUARD = "sleep-active-request-guard"


def _declaring(feature: str) -> tuple[str, ...]:
    # Direct attribute access on purpose: README mandates CONFORMANCE_FEATURES on every adapter,
    # so an adapter missing it must fail loud (AttributeError names the module) instead of
    # silently dropping out of every capability-gated case.
    return tuple(
        name for name, adapter in _BUILDERS.items() if feature in adapter.CONFORMANCE_FEATURES
    )


@contextlib.contextmanager
def _conformance_client(shim: str, **build_kwargs):
    """A `TestClient` over the shim's conformance app, its patched seams restored afterwards.

    `build_conformance_app()` replaces app-module globals and restores nothing. Registering each
    adapter-declared seam on a `MonkeyPatch` *before* the build records the pre-build values as
    undo targets, so in a combined pytest invocation (this suite + both shims' unit suites, as in
    `make test-python` and CI) the doubles never outlive a case — the vLLM unit tests read the
    real `_scrape_active_requests` / `memory_report` off their app module.
    """
    adapter = _BUILDERS[shim]
    mp = pytest.MonkeyPatch()
    try:
        for seam in adapter.PATCHED_SEAMS:
            mp.setattr(adapter.APP_MODULE, seam, getattr(adapter.APP_MODULE, seam))
        with TestClient(adapter.build_conformance_app(**build_kwargs)) as client:
            yield client
    finally:
        mp.undo()


@pytest.fixture(params=_SHIM_IDS, ids=_SHIM_IDS)
def shim_client(request):
    with _conformance_client(request.param) as client:  # runs lifespan → poller flips READY
        _wait_state(client, "READY")
        yield request.param, client


@pytest.fixture(params=_SHIM_IDS, ids=_SHIM_IDS)
def starting_client(request):
    """A runner that never finishes loading (poll_ready → False forever, process alive)."""
    with _conformance_client(request.param, ready=False) as client:
        # Pin the state before yielding: the conflict cases are vacuous against a READY runner,
        # so a broken `ready=False` knob must fail here, not as a puzzling 409 mismatch.
        health = client.get("/health").json()
        assert health.get("state") == "STARTING", health
        yield request.param, client


@pytest.fixture(params=_SHIM_IDS, ids=_SHIM_IDS)
def dying_client(request):
    """A runner whose engine is already dead: the real poller's first check marks ERROR.

    Driving the *post-READY*/*SLEEPING* deaths through the app would cost the poller's 2 s
    liveness tick per shim; those phases are unit-tested in each shim's tests/test_app.py.
    """
    with _conformance_client(request.param, alive=False) as client:
        _wait_state(client, "ERROR")
        yield request.param, client


_ACTIVE_REQUEST_GUARD_SHIMS = _declaring(SLEEP_ACTIVE_REQUEST_GUARD)


@pytest.fixture(params=_ACTIVE_REQUEST_GUARD_SHIMS, ids=_ACTIVE_REQUEST_GUARD_SHIMS)
def active_requests_client(request):
    """READY runner reporting 2 in-flight requests — only shims declaring the guard join."""
    with _conformance_client(request.param, active_requests=2) as client:
        _wait_state(client, "READY")
        yield request.param, client


def _wait_state(client, want: str, attempts: int = 100):
    for _ in range(attempts):
        r = client.get("/health")
        if r.status_code == 200 and r.json().get("state") == want:
            return
    raise AssertionError(f"shim never reached {want}: last={client.get('/health').json()}")
