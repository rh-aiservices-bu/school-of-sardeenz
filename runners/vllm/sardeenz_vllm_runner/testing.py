"""Test-only adapter: build the vLLM runner's real FastAPI app with a fake engine so the shared
engine-runner conformance suite (runners/conformance/) can drive it in-process, no vLLM/torch/GPU.

Patches the module-global seams `app.py`'s ``lifespan``/handlers reference at call time
(``VllmEngine``, ``memory_report``, ``_scrape_active_requests``) — the same seam
``runners/vllm/tests/test_core.py`` uses for its own fakes. Nothing here alters ``create_app``'s
signature or behavior; it only substitutes what the real engine/torch would have provided.

The builder is parameterised (``ready`` / ``alive`` / ``active_requests``) so the conformance
suite can stand the shim in its wrong states — still STARTING, engine dead, requests in flight
(#252); the zero-argument call is unchanged.
"""

from __future__ import annotations

from typing import Any

from . import app as _app
from . import weights as WEIGHTS_POLICY
from .cli import parse_args

# Capabilities this adapter declares to the shared conformance suite (runners/conformance/README.md
# "Capability-gated cases"). Never keyed on shim name: a future shim whose /sleep refuses while
# requests are in flight joins that case by declaring the same flag.
CONFORMANCE_FEATURES: frozenset[str] = frozenset({"sleep-active-request-guard"})

# The shim's app module and the globals `build_conformance_app()` replaces. The shared suite
# registers each seam as an undo target *before* building (runners/conformance/conftest.py), so
# the doubles never outlive a case into the shim's own unit suites.
APP_MODULE = _app
PATCHED_SEAMS: tuple[str, ...] = (
    "VllmEngine",
    "memory_report",
    "_scrape_active_requests",
    "check_weights",
)


class _FakeEngine:  # mirrors the VllmEngine surface create_app()/_health_poller() use
    def __init__(self, args: Any, *, ready: bool = True, alive: bool = True) -> None:
        del args
        self.base_url = "http://127.0.0.1:0"
        self._ready = ready
        self._alive = alive

    def start(self) -> None: ...

    def is_alive(self) -> bool:
        return self._alive

    async def poll_ready(self, client: Any) -> bool:  # noqa: ANN401 - poller flips READY immediately
        del client
        return self._ready

    async def sleep(self, client: Any, vllm_level: int) -> None:  # noqa: ANN401
        del client, vllm_level

    async def wake(self, client: Any) -> None:  # noqa: ANN401
        del client

    def stop(self, grace_seconds: float = 15.0) -> None:
        del grace_seconds


def _fake_memory_report(device_type: str = "CUDA") -> dict[str, Any]:
    # The contract-required fields (engine-runner.yaml DeviceMemoryUsage) plus the
    # optional kvcached pool block (#165) and the attribution scope (#244 — device:
    # the fake mirrors what the real memory.py emits) so the conformance suite also
    # exercises the kvCache shape. No memoryFreeBytes — that field does not exist in
    # the contract.
    return {
        "devices": [
            {
                "deviceIndex": 0,
                "deviceType": device_type,
                "memoryUsedBytes": 2_000,
                "memoryTotalBytes": 10_000,
                "attribution": "device",
                "kvCache": {
                    "totalBytes": 4_000,
                    "usedBytes": 1_500,
                    "preallocBytes": 500,
                    "freeBytes": 2_000,
                },
            }
        ]
    }


def _scrape_returning(value: int | None):
    """A /metrics scrape double. ``value`` is the active-request count; ``None`` means unknown —
    the same behaviour as a real vLLM instance whose /metrics scrape fails, which app.py handles."""

    async def _scrape(client: Any, base_url: str) -> int | None:  # noqa: ANN401
        del client, base_url
        return value

    return _scrape


def build_conformance_app(
    *, ready: bool = True, alive: bool = True, active_requests: int | None = None
):
    """Build the shim's real app with the fake engine.

    ``ready=False``   → the poller never reports readiness: the runner stays STARTING (the
                        409-while-STARTING fixture).
    ``alive=False``   → the fake process is already dead, so the poller's first check
                        (``is_alive``) marks ERROR — no tick is waited for. The post-READY and
                        SLEEPING death phases are driven directly in tests/test_app.py.
    ``active_requests=n`` → /health and /sleep see n in-flight requests (vLLM's sleep guard).

    The zero-argument call — the happy-path fixtures and both tests/test_app.py harnesses — is
    unchanged: live engine, ready immediately, unknown scrape.
    """
    _app.VllmEngine = lambda args: _FakeEngine(args, ready=ready, alive=alive)
    _app.memory_report = _fake_memory_report
    _app._scrape_active_requests = _scrape_returning(active_requests)
    # The shared suite builds a real app against a nonexistent /tmp/conformance model dir; the
    # gate's []-on-missing-directory rule keeps that harmless, but a no-op keeps a future fixture
    # that creates a fake pickle from breaking unrelated cases (#336).
    _app.check_weights = lambda *args, **kwargs: None
    args = parse_args(
        ["--model", "/tmp/conformance", "--port", "9101", "--", "--served-model-name", "conformance-model"]
    )
    return _app.create_app(args)
