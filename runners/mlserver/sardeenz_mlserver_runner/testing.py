"""Test-only adapter: build the MLServer runner's real FastAPI app with a fake engine so the
shared engine-runner conformance suite (runners/conformance/) can drive it in-process, no
MLServer/torch/GPU/model-repository generation.

Patches the module-global seams `app.py`'s ``lifespan``/handlers reference at call time
(``MLServerEngine``, ``memory_report``, ``build_model_settings``, ``write_model_repository``).
Nothing here alters ``create_app``'s signature or behavior; it only substitutes what the real
engine/torch/model-repository writer would have provided.
"""

from __future__ import annotations

from typing import Any

from . import app as _app
from .cli import parse_args


class _FakeEngine:  # mirrors the MLServerEngine(args, repo_dir) surface app.py uses
    def __init__(self, args: Any, repo_dir: str) -> None:  # noqa: ANN401
        del args, repo_dir
        self.base_url = "http://127.0.0.1:0"

    def start(self) -> None: ...

    def is_alive(self) -> bool:
        return True

    async def poll_ready(self, client: Any) -> bool:  # noqa: ANN401 - poller flips READY immediately
        del client
        return True

    async def sleep(self, client: Any) -> None:  # noqa: ANN401 - MLServer sleep(client), no level arg
        del client

    async def wake(self, client: Any) -> None:  # noqa: ANN401
        del client

    def stop(self, grace_seconds: float = 15.0) -> None:
        del grace_seconds


def _fake_memory_report(device_type: str = "CUDA") -> dict[str, Any]:
    # Only the fields the contract actually requires (engine-runner.yaml DeviceMemoryUsage) —
    # matches what the real MLServer memory.py emits (no memoryFreeBytes; that field does not
    # exist in the contract).
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


def _fake_build_model_settings(source_dir: str, model_name: str) -> dict[str, Any]:
    return {"name": model_name, "implementation": "x", "parameters": {"uri": source_dir}}


def _fake_write_model_repository(model_settings: dict[str, Any], repo_root: str | None = None) -> str:
    del model_settings, repo_root
    return "/tmp/conformance-repo"


def build_conformance_app():
    _app.MLServerEngine = _FakeEngine  # module-global referenced by lifespan at call time
    _app.memory_report = _fake_memory_report
    _app.build_model_settings = _fake_build_model_settings
    _app.write_model_repository = _fake_write_model_repository
    args = parse_args(
        ["--model", "/tmp/conformance", "--port", "9101", "--", "--served-model-name", "conformance-model"]
    )
    return _app.create_app(args)
