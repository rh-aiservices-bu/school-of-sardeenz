"""FastAPI app exposing the engine-runner contract on top of a vLLM subprocess."""

from __future__ import annotations

import asyncio
import contextlib
from typing import Any

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from . import state as st
from .cli import RunnerArgs
from .engine import VllmEngine
from .memory import memory_report


def _engine_version() -> str:
    try:
        import vllm  # type: ignore

        return str(getattr(vllm, "__version__", "unknown"))
    except Exception:
        return "unknown"


def _kvcached_enabled() -> bool:
    import os

    return os.environ.get("ENABLE_KVCACHED", "true").lower() in ("1", "true", "yes", "on")


async def _health_poller(app: FastAPI) -> None:
    """Flip STARTING → READY once vLLM serves, then keep watching: flip → ERROR if the subprocess
    dies at any point (a post-startup crash must not leave the runner reporting READY forever)."""
    engine: VllmEngine = app.state.engine
    status: st.RunnerStatus = app.state.status
    client: httpx.AsyncClient = app.state.client

    # Startup phase.
    status.set_progress(st.PHASE_LOADING_WEIGHTS, 10, "Starting vLLM engine")
    while status.state == st.STARTING:
        if not engine.is_alive():
            status.mark_error("vLLM engine process exited during startup")
            return
        if await engine.poll_ready(client):
            status.mark_ready()
            break
        await asyncio.sleep(1.0)

    # Liveness phase — a crash while READY/BUSY/SLEEPING (process alive during sleep) must surface.
    while True:
        await asyncio.sleep(2.0)
        if not engine.is_alive():
            if status.state in (st.READY, st.BUSY, st.SLEEPING):
                status.mark_error("vLLM engine process exited")
            return


def create_app(args: RunnerArgs) -> FastAPI:
    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI):  # type: ignore[no-untyped-def]
        app.state.status = st.RunnerStatus()
        app.state.engine = VllmEngine(args)
        app.state.client = httpx.AsyncClient()
        app.state.engine.start()
        poller = asyncio.create_task(_health_poller(app))
        try:
            yield
        finally:
            poller.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await poller
            app.state.engine.stop()
            await app.state.client.aclose()

    app = FastAPI(title="Sardeenz vLLM Runner", lifespan=lifespan)

    def status() -> st.RunnerStatus:
        return app.state.status

    @app.get("/health")
    async def get_health() -> JSONResponse:
        return JSONResponse(status().health(active_requests=0))

    @app.get("/capabilities")
    async def get_capabilities() -> JSONResponse:
        return JSONResponse(
            st.capabilities(
                _engine_version(),
                device_type=args.device_type,
                max_tensor_parallelism=max(1, args.tensor_parallel),
                kvcached_enabled=_kvcached_enabled(),
            )
        )

    @app.get("/memory-report")
    async def get_memory_report() -> JSONResponse:
        if status().state == st.STARTING:
            return _error(409, "MEMORY_UNAVAILABLE", "Runner is still starting")
        report = memory_report(args.device_type)
        # MemoryReport.devices is minItems:1 — if no device could be introspected, fail closed
        # rather than emit a contract-invalid empty array.
        if not report["devices"]:
            return _error(409, "MEMORY_UNAVAILABLE", "No device memory could be introspected")
        return JSONResponse(report)

    @app.get("/progress")
    async def get_progress() -> JSONResponse:
        return JSONResponse(status().progress())

    @app.get("/sleep-status")
    async def get_sleep_status() -> JSONResponse:
        return JSONResponse(status().sleep_status())

    @app.post("/sleep")
    async def post_sleep(request: Request) -> JSONResponse:
        body: dict[str, Any] = await _json(request)
        level = body.get("level")
        if level != st.L1_HOST_RAM:
            return _error(400, "BAD_REQUEST", f"Unsupported sleep level: {level!r}")
        if status().state == st.STARTING:
            return _error(409, "NOT_READY", "Runner is still starting")

        freed = sum(d["memoryUsedBytes"] for d in memory_report(args.device_type)["devices"])
        try:
            await app.state.engine.sleep(app.state.client, st.vllm_sleep_level(level))
        except httpx.HTTPError as exc:
            return _error(500, "SLEEP_FAILED", f"vLLM sleep failed: {exc}")
        status().mark_sleeping(level)
        return JSONResponse(st.sleep_response(level, device_memory_freed_bytes=freed))

    @app.post("/wake")
    async def post_wake() -> JSONResponse:
        try:
            await app.state.engine.wake(app.state.client)
        except httpx.HTTPError as exc:
            return _error(500, "WAKE_FAILED", f"vLLM wake failed: {exc}")
        status().mark_awake()
        return JSONResponse(st.wake_response())

    return app


async def _json(request: Request) -> dict[str, Any]:
    try:
        return await request.json()
    except Exception:
        return {}


def _error(http_status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse({"error": message, "code": code}, status_code=http_status)
