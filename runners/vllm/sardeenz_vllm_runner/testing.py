"""Test-only adapter: build the vLLM runner's real FastAPI app with a fake engine so the shared
engine-runner conformance suite (runners/conformance/) can drive it in-process, no vLLM/torch/GPU.

Patches the module-global seams `app.py`'s ``lifespan``/handlers reference at call time
(``VllmEngine``, ``memory_report``, ``_scrape_active_requests``) — the same seam
``runners/vllm/tests/test_core.py`` uses for its own fakes. Nothing here alters ``create_app``'s
signature or behavior; it only substitutes what the real engine/torch would have provided.
"""

from __future__ import annotations

from typing import Any

from . import app as _app
from .cli import parse_args


class _FakeEngine:  # mirrors the VllmEngine surface create_app()/_health_poller() use
    def __init__(self, args: Any) -> None:  # noqa: ANN401 - mirrors VllmEngine(args)
        del args
        self.base_url = "http://127.0.0.1:0"

    def start(self) -> None: ...

    def is_alive(self) -> bool:
        return True

    async def poll_ready(self, client: Any) -> bool:  # noqa: ANN401 - poller flips READY immediately
        del client
        return True

    async def sleep(self, client: Any, vllm_level: int) -> None:  # noqa: ANN401
        del client, vllm_level

    async def wake(self, client: Any) -> None:  # noqa: ANN401
        del client

    def stop(self, grace_seconds: float = 15.0) -> None:
        del grace_seconds


def _fake_memory_report(device_type: str = "CUDA") -> dict[str, Any]:
    # Only the fields the contract actually requires (engine-runner.yaml DeviceMemoryUsage) —
    # matches what the real vLLM memory.py emits (no memoryFreeBytes; that field does not exist
    # in the contract).
    return {
        "devices": [
            {
                "deviceIndex": 0,
                "deviceType": device_type,
                "memoryUsedBytes": 2_000,
                "memoryTotalBytes": 10_000,
            }
        ]
    }


async def _fake_scrape(client: Any, base_url: str) -> None:  # noqa: ANN401
    # /health and /sleep then see "unknown" active-request count (None) — the same behavior as a
    # real vLLM instance whose /metrics scrape fails, which app.py already handles.
    del client, base_url
    return None


def build_conformance_app():
    _app.VllmEngine = _FakeEngine  # module-global referenced by lifespan at call time
    _app.memory_report = _fake_memory_report
    _app._scrape_active_requests = _fake_scrape
    args = parse_args(
        ["--model", "/tmp/conformance", "--port", "9101", "--", "--served-model-name", "conformance-model"]
    )
    return _app.create_app(args)
