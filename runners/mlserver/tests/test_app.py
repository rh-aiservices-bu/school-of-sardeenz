"""App-level tests for the MLServer runner shim's HTTP handlers (issue #253).

``test_core.py`` never touches FastAPI or ``create_app``. App-level coverage already exists in
``runners/conformance/`` (the same doubles under ``TestClient``); what this harness adds is
thread observability. It builds the real ``create_app`` through
``sardeenz_mlserver_runner.testing.build_conformance_app`` (the conformance doubles) and drives
it over ``httpx.ASGITransport`` — the app then shares the test's event loop *and thread*, which
is what makes the thread-identity assertions meaningful. No ``pytest-asyncio`` needed: each test
is a plain ``asyncio.run`` inside a sync function.

The ``memory_report`` doubles below are synchronous functions: the production call sites await
``run_in_executor(...)`` (not ``memory_report`` itself), so the executor invokes a sync callable —
an ``async`` double would make the handler index a coroutine object instead of the report dict.
"""

from __future__ import annotations

import asyncio
import threading
import time
import types
from typing import Any, Awaitable, Callable, Iterator

import httpx
import pytest

from sardeenz_mlserver_runner import app as app_module
from sardeenz_mlserver_runner import state as st
from sardeenz_mlserver_runner.testing import PATCHED_SEAMS, build_conformance_app


@pytest.fixture()
def conformance_app() -> Iterator[Any]:
    """Build the shim app with the conformance doubles, restoring the app-module seams after.

    ``build_conformance_app()`` patches app-module globals without restoring them. Registering
    each seam on the ``MonkeyPatch`` *before* the build records the pre-fixture values as undo
    targets, so even a build that fails mid-patch is rolled back in ``finally`` — which matters
    because this file collects before ``test_core.py`` in the same session and that suite reads
    the real ``memory_report`` / engine seams off the app module. The seam list itself is the
    adapter's ``PATCHED_SEAMS``, declared next to the patching in ``testing`` so it cannot drift
    from what ``build_conformance_app()`` replaces.
    """
    mp = pytest.MonkeyPatch()
    try:
        for name in PATCHED_SEAMS:
            mp.setattr(app_module, name, getattr(app_module, name))
        app = build_conformance_app()
        yield app
    finally:
        mp.undo()


def _memory_report(device_type: str = "CUDA") -> dict[str, Any]:
    """Contract-valid single-device report (the same shape testing.py's fake emits, #244)."""
    return {
        "devices": [
            {
                "deviceIndex": 0,
                "deviceType": device_type,
                "memoryUsedBytes": 2_000,
                "memoryTotalBytes": 10_000,
                "attribution": "device",
            }
        ]
    }


def _never_called(device_type: str = "CUDA") -> dict[str, Any]:
    raise AssertionError(f"memory_report must not be called here (device_type={device_type!r})")


async def _wait_ready(client: httpx.AsyncClient) -> None:
    """Poll /health until the in-app _health_poller flips STARTING → READY (its first tick)."""
    deadline = time.monotonic() + 10.0
    while time.monotonic() < deadline:
        resp = await client.get("/health")
        if resp.json()["state"] == st.READY:
            return
        await asyncio.sleep(0.05)
    raise AssertionError("runner did not reach READY within 10s")


def _drive(
    app: Any, scenario: Callable[[Any, httpx.AsyncClient], Awaitable[None]]
) -> None:
    """Run ``scenario(app, client)`` with the app's lifespan active, on the test's own loop."""

    async def runner() -> None:
        async with app.router.lifespan_context(app):
            transport = httpx.ASGITransport(app=app)
            async with httpx.AsyncClient(transport=transport, base_url="http://shim") as client:
                await _wait_ready(client)
                await scenario(app, client)

    asyncio.run(runner())


def test_memory_report_runs_off_event_loop(conformance_app: Any) -> None:
    threads: list[threading.Thread] = []

    def _recorder(device_type: str = "CUDA") -> dict[str, Any]:
        threads.append(threading.current_thread())
        return _memory_report(device_type)

    async def scenario(_app: Any, client: httpx.AsyncClient) -> None:
        resp = await client.get("/memory-report")
        assert resp.status_code == 200
        assert resp.json()["devices"][0]["memoryUsedBytes"] == 2_000

    # The handlers resolve memory_report from the app module's globals (the seam testing.py
    # patches too); the memory module's global is not what they read.
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(app_module, "memory_report", _recorder)
        _drive(conformance_app, scenario)

    assert len(threads) == 1
    assert threads[0] is not threading.main_thread()  # the loop thread == the test's thread


def test_sleep_runs_memory_report_off_event_loop_exactly_once(conformance_app: Any) -> None:
    threads: list[threading.Thread] = []

    def _recorder(device_type: str = "CUDA") -> dict[str, Any]:
        threads.append(threading.current_thread())
        return _memory_report(device_type)

    async def scenario(_app: Any, client: httpx.AsyncClient) -> None:
        resp = await client.post("/sleep", json={"level": st.L1_HOST_RAM})
        assert resp.status_code == 200
        # The freed figure is the single off-loop read's consumer.
        assert resp.json()["deviceMemoryFreedBytes"] == 2_000

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(app_module, "memory_report", _recorder)
        _drive(conformance_app, scenario)

    # One read per /sleep — the freed computation only (engine.sleep is not a memory read).
    assert len(threads) == 1
    assert threads[0] is not threading.main_thread()


def test_health_responds_while_memory_report_blocks(conformance_app: Any) -> None:
    def _slow_report(device_type: str = "CUDA") -> dict[str, Any]:
        time.sleep(0.150)
        return _memory_report(device_type)

    async def scenario(_app: Any, client: httpx.AsyncClient) -> None:
        async def attempt() -> None:
            started = time.monotonic()
            report_task = asyncio.create_task(client.get("/memory-report"))
            # Head start: post-fix the report handler is inside its blocking read on the
            # executor thread; pre-fix it is freezing this very loop, so the sleep only fires
            # once the read returns — which is what the latency assertion below discriminates.
            await asyncio.sleep(0.010)
            health = await client.get("/health")
            health_arrival_ms = (time.monotonic() - started) * 1000.0
            assert health.status_code == 200
            assert health_arrival_ms < 75.0, (
                f"/health took {health_arrival_ms:.1f} ms while the report read was in flight"
            )
            report = await report_task
            assert report.status_code == 200
            assert (time.monotonic() - started) * 1000.0 >= 150.0  # the read still did its block

        # A single retry absorbs a loaded CI box that starves this process for >65 ms right
        # after the 10 ms head start (the only wall-clock-sensitive assertion in the file):
        # the retry re-head-starts and re-times the same window, while the >= 150 ms block
        # assertion keeps the discrimination (~10-15 ms post-fix vs ~150 ms pre-fix).
        try:
            await attempt()
        except AssertionError:
            await attempt()

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(app_module, "memory_report", _slow_report)
        _drive(conformance_app, scenario)


def test_memory_report_409_when_starting(conformance_app: Any) -> None:
    async def scenario(app: Any, client: httpx.AsyncClient) -> None:
        # Fresh STARTING status: the poller keeps flipping the original object it captured.
        app.state.status = st.RunnerStatus()
        resp = await client.get("/memory-report")
        assert resp.status_code == 409
        assert resp.json() == {
            "error": "Runner is still starting",
            "code": "MEMORY_UNAVAILABLE",
        }

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(app_module, "memory_report", _never_called)
        _drive(conformance_app, scenario)


def test_sleep_bad_level_400(conformance_app: Any) -> None:
    async def scenario(_app: Any, client: httpx.AsyncClient) -> None:
        resp = await client.post("/sleep", json={"level": "L2_DISK"})
        assert resp.status_code == 400
        assert resp.json() == {
            "error": "Unsupported sleep level: 'L2_DISK'",
            "code": "BAD_REQUEST",
        }

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(app_module, "memory_report", _never_called)
        _drive(conformance_app, scenario)


# --- _health_poller crash paths (#252) -----------------------------------------------------


class _DeadEngine:
    """The engine surface the poller touches on a dead process.

    ``poll_ready`` must never be reached in these phases (a dead process fails ``is_alive``
    first), so reaching it is a test failure rather than a silent pass — and ``client`` is
    ``None`` because these paths never use it.
    """

    def is_alive(self) -> bool:
        return False

    async def poll_ready(self, client: object) -> bool:
        raise AssertionError("poller must not poll readiness for a dead process")


def _run_poller(monkeypatch: pytest.MonkeyPatch, status: st.RunnerStatus) -> None:
    """Drive the real ``_health_poller`` with its ticks elided (#252 / S3).

    The poller's only ``asyncio`` use on these paths is ``asyncio.sleep`` (1 s startup poll,
    2 s liveness tick), so the *app module's* ``asyncio`` name is swapped for a stub whose
    sleep returns at once — the global asyncio module and this test's ``asyncio.run`` are
    untouched, and each case costs ~0 ms instead of 2 s (CI's python job is 10 min,
    ci.yml:181). The stub fails after 10 ticks so a fake engine that never died would fail
    fast instead of spinning a zero-length loop forever. No lifespan/portal, so no
    pytest-asyncio (not installed in .venv).
    """
    ticks = 0

    async def _tick(_delay: float) -> None:
        nonlocal ticks
        ticks += 1
        assert ticks <= 10, "poller is spinning: the fake engine never died"

    app = types.SimpleNamespace(
        state=types.SimpleNamespace(engine=_DeadEngine(), status=status, client=None)
    )
    monkeypatch.setattr(app_module, "asyncio", types.SimpleNamespace(sleep=_tick))
    asyncio.run(app_module._health_poller(app))


def test_poller_marks_error_when_engine_dies_during_startup(monkeypatch: pytest.MonkeyPatch) -> None:
    status = st.RunnerStatus()  # STARTING
    _run_poller(monkeypatch, status)
    assert status.health(active_requests=None) == {
        "state": st.ERROR,
        "message": "MLServer engine process exited during startup",
    }


def test_poller_marks_error_when_engine_dies_after_ready(monkeypatch: pytest.MonkeyPatch) -> None:
    status = st.RunnerStatus()
    status.mark_ready()
    _run_poller(monkeypatch, status)
    assert status.health(active_requests=None) == {
        "state": st.ERROR,
        "message": "MLServer engine process exited",
    }


def test_poller_marks_error_when_engine_dies_while_sleeping(monkeypatch: pytest.MonkeyPatch) -> None:
    status = st.RunnerStatus()
    status.mark_ready()
    status.mark_sleeping(st.L1_HOST_RAM)  # process alive while sleeping — the case the guard is for
    _run_poller(monkeypatch, status)
    assert status.health(active_requests=None) == {
        "state": st.ERROR,
        "message": "MLServer engine process exited",
    }
    assert status.sleep_status()["isSleeping"] is False
