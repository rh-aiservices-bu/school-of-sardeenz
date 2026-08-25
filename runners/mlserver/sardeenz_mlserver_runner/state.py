"""Pure state model and response builders for the Sardeenz MLServer runner shim.

This module has no heavy imports (no MLServer, no FastAPI) so it can be unit-tested on any
Python. It builds the exact JSON shapes defined by the engine-runner contract
(packages/contracts/specs/engine-runner.yaml).
"""

from __future__ import annotations

import threading
from typing import Any, Optional

# RunnerState enum (engine-runner.yaml RunnerState)
STARTING = "STARTING"
READY = "READY"
BUSY = "BUSY"
SLEEPING = "SLEEPING"
ERROR = "ERROR"

# SleepLevel enum — v0.1 defines only L1_HOST_RAM. MLServer's unload drops weights back to the
# model repository (page cache ≈ host RAM for the small models this runtime serves) rather than
# literally to host RAM — see README. No L2_DISK for v1.
L1_HOST_RAM = "L1_HOST_RAM"

# LoadingPhase enum (engine-runner.yaml LoadingPhase)
PHASE_INITIALIZING = "INITIALIZING"
PHASE_LOADING_WEIGHTS = "LOADING_WEIGHTS"
PHASE_ALLOCATING_MEMORY = "ALLOCATING_MEMORY"
PHASE_CAPTURING_GRAPHS = "CAPTURING_GRAPHS"
PHASE_WARMING_UP = "WARMING_UP"
PHASE_READY = "READY"


class RunnerStatus:
    """Thread-safe holder for the runner's lifecycle state.

    The FastAPI handlers read from it; the background health poller and sleep/wake
    handlers write to it.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._state = STARTING
        self._phase = PHASE_INITIALIZING
        self._percent = 0
        self._message: Optional[str] = None
        self._sleep_level: Optional[str] = None

    @property
    def state(self) -> str:
        with self._lock:
            return self._state

    def set_progress(self, phase: str, percent: int, message: Optional[str] = None) -> None:
        with self._lock:
            self._phase = phase
            self._percent = max(0, min(100, percent))
            if message is not None:
                self._message = message

    def mark_ready(self) -> None:
        with self._lock:
            self._state = READY
            self._phase = PHASE_READY
            self._percent = 100
            self._sleep_level = None
            self._message = None

    def mark_error(self, message: str) -> None:
        with self._lock:
            self._state = ERROR
            self._message = message

    def mark_sleeping(self, level: str) -> None:
        with self._lock:
            self._state = SLEEPING
            self._sleep_level = level

    def mark_awake(self) -> None:
        with self._lock:
            self._state = READY
            self._sleep_level = None

    def health(self, active_requests: int | None = 0) -> dict[str, Any]:
        with self._lock:
            body: dict[str, Any] = {"state": self._state}
            if active_requests is not None:
                body["activeRequests"] = active_requests
            if self._message:
                body["message"] = self._message
            if self._state == STARTING:
                body["progress"] = {
                    "phase": self._phase,
                    "percentComplete": self._percent,
                }
                if self._message:
                    body["progress"]["message"] = self._message
            return body

    def progress(self) -> dict[str, Any]:
        with self._lock:
            body: dict[str, Any] = {"phase": self._phase, "percentComplete": self._percent}
            if self._message:
                body["message"] = self._message
            return body

    def sleep_status(self) -> dict[str, Any]:
        with self._lock:
            body: dict[str, Any] = {"isSleeping": self._state == SLEEPING}
            if self._sleep_level is not None:
                body["level"] = self._sleep_level
            return body


def capabilities(
    engine_version: str,
    *,
    runner_type: str = "mlserver",
    device_type: str = "CUDA",
    max_tensor_parallelism: int = 1,
) -> dict[str, Any]:
    """Build the RunnerCapabilities body.

    MLServer has no elastic KV-cache sharing (kvCacheElasticSharing is always False, unlike the
    vLLM shim's kvcached-gated flag).
    """
    return {
        "runnerType": runner_type,
        "engineName": "MLServer",
        "engineVersion": engine_version,
        "supportedModelTypes": ["PREDICTIVE", "LLM", "EMBEDDING"],
        "supportedDeviceTypes": [device_type],
        "supportedSleepLevels": [L1_HOST_RAM],
        "maxTensorParallelism": max_tensor_parallelism,
        "kvCacheElasticSharing": False,
        "features": {"streamingInference": False},
    }


def sleep_response(level: str, device_memory_freed_bytes: Optional[int] = None) -> dict[str, Any]:
    body: dict[str, Any] = {"state": SLEEPING, "level": level}
    if device_memory_freed_bytes is not None:
        body["deviceMemoryFreedBytes"] = max(0, device_memory_freed_bytes)
    return body


def wake_response() -> dict[str, Any]:
    return {"state": READY}


# --- KServe V2 repository/inference path builders (pure — so engine.py's URLs are testable
# without httpx; see app.py's MLServerEngine, which hits these against its base_url). ---


def repository_load_path(name: str) -> str:
    return f"/v2/repository/models/{name}/load"


def repository_unload_path(name: str) -> str:
    return f"/v2/repository/models/{name}/unload"


def model_ready_path(name: str) -> str:
    return f"/v2/models/{name}/ready"


def health_ready_path() -> str:
    return "/v2/health/ready"
