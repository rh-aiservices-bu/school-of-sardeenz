"""Test-only adapter: build the MLServer runner's real FastAPI app with a fake engine so the
shared engine-runner conformance suite (runners/conformance/) can drive it in-process, no
MLServer/torch/GPU/model-repository generation.

Patches the module-global seams `app.py`'s ``lifespan``/handlers reference at call time
(``MLServerEngine``, ``memory_report``, ``build_model_settings``, ``write_model_repository``).
Nothing here alters ``create_app``'s signature or behavior; it only substitutes what the real
engine/torch/model-repository writer would have provided.

The builder is parameterised (``ready`` / ``alive``) so the conformance suite can stand the shim
in its wrong states — still STARTING, engine dead (#252); the zero-argument call is unchanged.
"""

from __future__ import annotations

from typing import Any

from . import app as _app
from .cli import parse_args

# No /sleep in-flight-request guard: MLServer reports the REST in-progress gauge but cannot
# block a sleep on it (mlserver/app.py post_sleep). Declared explicitly so the suite has an
# answer for every adapter.
CONFORMANCE_FEATURES: frozenset[str] = frozenset()

# The shim's app module and the globals `build_conformance_app()` replaces. The shared suite
# registers each seam as an undo target *before* building (runners/conformance/conftest.py), so
# the doubles never outlive a case into the shim's own unit suites.
APP_MODULE = _app
PATCHED_SEAMS: tuple[str, ...] = (
    "MLServerEngine",
    "memory_report",
    "build_model_settings",
    "write_model_repository",
)


class _FakeEngine:  # mirrors the MLServerEngine(args, repo_dir) surface app.py uses
    def __init__(self, args: Any, repo_dir: str, *, ready: bool = True, alive: bool = True) -> None:
        del args, repo_dir
        self.base_url = "http://127.0.0.1:0"
        self.metrics_url = "http://127.0.0.1:0"
        self.rest_metrics_prefix = "rest_server"
        self._ready = ready
        self._alive = alive

    def start(self) -> None: ...

    def is_alive(self) -> bool:
        return self._alive

    async def poll_ready(self, client: Any) -> bool:  # noqa: ANN401 - poller flips READY immediately
        del client
        return self._ready

    async def sleep(self, client: Any) -> None:  # noqa: ANN401 - MLServer sleep(client), no level arg
        del client

    async def wake(self, client: Any) -> None:  # noqa: ANN401
        del client

    def stop(self, grace_seconds: float = 15.0) -> None:
        del grace_seconds


def _fake_memory_report(device_type: str = "CUDA") -> dict[str, Any]:
    # The contract's four required fields (engine-runner.yaml DeviceMemoryUsage) plus the
    # optional attribution scope (#244 — device: the fake mirrors what the real MLServer
    # memory.py emits). No memoryFreeBytes — that field does not exist in the contract.
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


def _fake_build_model_settings(source_dir: str, model_name: str) -> dict[str, Any]:
    return {"name": model_name, "implementation": "x", "parameters": {"uri": source_dir}}


def _fake_write_model_repository(model_settings: dict[str, Any], repo_root: str | None = None) -> str:
    del model_settings, repo_root
    return "/tmp/conformance-repo"


def build_conformance_app(*, ready: bool = True, alive: bool = True):
    """Build the shim's real app with the fake engine.

    ``ready=False``   → the poller never reports readiness: the runner stays STARTING (the
                        409-while-STARTING fixture).
    ``alive=False``   → the fake process is already dead, so the poller's first check
                        (``is_alive``) marks ERROR — no tick is waited for. The post-READY and
                        SLEEPING death phases are driven directly in tests/test_app.py.

    The zero-argument call — the happy-path fixtures and both tests/test_app.py harnesses — is
    unchanged: live engine, ready immediately.
    """
    _app.MLServerEngine = lambda args, repo_dir: _FakeEngine(
        args, repo_dir, ready=ready, alive=alive
    )
    _app.memory_report = _fake_memory_report
    _app.build_model_settings = _fake_build_model_settings
    _app.write_model_repository = _fake_write_model_repository
    args = parse_args(
        ["--model", "/tmp/conformance", "--port", "9101", "--", "--served-model-name", "conformance-model"]
    )
    return _app.create_app(args)
