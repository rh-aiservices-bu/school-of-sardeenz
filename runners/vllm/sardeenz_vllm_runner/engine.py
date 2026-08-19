"""vLLM subprocess lifecycle + dev-endpoint client for the runner shim.

The shim launches `vllm serve` (the OpenAI server) as a child process on an internal port and
drives its sleep/wake dev endpoints. Inference traffic goes straight to that OpenAI port via the
proxy; this shim only implements the Sardeenz runner-contract management API.
"""

from __future__ import annotations

import os
import signal
import subprocess
from typing import Optional

import httpx

from .cli import RunnerArgs, build_vllm_command


class VllmEngine:
    def __init__(self, args: RunnerArgs) -> None:
        self._args = args
        self._proc: Optional[subprocess.Popen[bytes]] = None
        self._base_url = f"http://127.0.0.1:{args.engine_port}"

    @property
    def base_url(self) -> str:
        return self._base_url

    def start(self) -> None:
        env = os.environ.copy()
        # kvcached enablement is baked into the image; set it here too so a plain SIF still enables
        # it, and turn on vLLM's dev endpoints (/sleep, /wake_up) which back the runner contract.
        env.setdefault("ENABLE_KVCACHED", "true")
        env.setdefault("KVCACHED_AUTOPATCH", "1")
        env["VLLM_SERVER_DEV_MODE"] = "1"
        cmd = build_vllm_command(self._args)
        # New process group so we can signal the whole vLLM tree on stop.
        self._proc = subprocess.Popen(cmd, env=env, start_new_session=True)

    def is_alive(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    async def poll_ready(self, client: httpx.AsyncClient) -> bool:
        """Return True once vLLM's OpenAI server reports healthy."""
        try:
            resp = await client.get(f"{self._base_url}/health", timeout=2.0)
            return resp.status_code == 200
        except httpx.HTTPError:
            return False

    async def sleep(self, client: httpx.AsyncClient, vllm_level: int) -> None:
        resp = await client.post(
            f"{self._base_url}/sleep", params={"level": vllm_level}, timeout=120.0
        )
        resp.raise_for_status()

    async def wake(self, client: httpx.AsyncClient) -> None:
        resp = await client.post(f"{self._base_url}/wake_up", timeout=120.0)
        resp.raise_for_status()

    def stop(self, grace_seconds: float = 15.0) -> None:
        """SIGTERM the vLLM process group, then SIGKILL after the grace period."""
        proc = self._proc
        if proc is None or proc.poll() is not None:
            return
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        except ProcessLookupError:
            return
        try:
            proc.wait(timeout=grace_seconds)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except ProcessLookupError:
                pass
