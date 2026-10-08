"""MLServer subprocess lifecycle + KServe V2 repository client for the runner shim.

The shim launches `mlserver start <repo-dir>` (the KServe V2 HTTP server) as a child process on an
internal port and drives its repository load/unload endpoints for sleep/wake. Inference traffic
goes straight to that HTTP port via the proxy; this shim only implements the Sardeenz
runner-contract management API.
"""

from __future__ import annotations

import os
import signal
import subprocess
from typing import Optional

import httpx

from . import state as st
from .cli import RunnerArgs


async def scrape_active_requests(
    client: httpx.AsyncClient, metrics_base_url: str, rest_metrics_prefix: str
) -> int | None:
    """Scrape MLServer's metrics listener for the REST server's in-flight request count.

    MLServer's REST server instruments every request with starlette_exporter's
    ``<prefix>_requests_in_progress`` gauge (prefix = ``metrics_rest_server_prefix``,
    default ``rest_server``). Summing the gauge's samples gives the number of requests
    currently in flight against the engine — including in-flight ``/v2/models/{name}/infer``
    calls — which is the drain-progress signal the control plane needs (#206).

    Returns None (unknown) rather than 0 when the metric can't be read, so callers don't
    mistake "couldn't scrape" for "drained" — a false 0 would short-circuit the drain loop.
    """
    try:
        resp = await client.get(f"{metrics_base_url}/metrics", timeout=2.0)
        if resp.status_code != 200:
            return None
        in_progress = 0
        found = False
        for line in resp.text.splitlines():
            gauge = f"{rest_metrics_prefix}_requests_in_progress"
            if not line.startswith(gauge) or line.startswith(gauge + "_"):
                continue
            found = True
            try:
                in_progress += int(float(line.split()[-1]))
            except ValueError:
                return None
        if not found:
            # Metrics listener reachable but no in-progress gauge (e.g. metrics disabled via
            # MLSERVER_METRICS_ENDPOINT=""): unknown, not drained.
            return None
        return in_progress
    except (httpx.HTTPError, ValueError):
        return None


class MLServerEngine:
    def __init__(self, args: RunnerArgs, repo_dir: str) -> None:
        self._args = args
        self._repo_dir = repo_dir
        self._proc: Optional[subprocess.Popen[bytes]] = None
        # shim→engine control calls stay loopback-local within the SIF; the engine's
        # externally-reachable *bind* host is set via MLSERVER_HOST below (#159).
        self._base_url = f"http://127.0.0.1:{args.engine_port}"
        # MLServer's Prometheus metrics listener (its own port — see cli.py aux_ports) exposes
        # the REST server's in-progress gauge (#206), the drain-progress signal the control
        # plane reads off this shim's /health.
        self._metrics_url = f"http://127.0.0.1:{args.metrics_port}"
        # metrics_rest_server_prefix default (MLServer settings); overridable via MLSERVER_ env.
        self._rest_metrics_prefix = os.environ.get(
            "MLSERVER_METRICS_REST_SERVER_PREFIX", "rest_server"
        )
        self._model_name = args.served_name

    @property
    def base_url(self) -> str:
        return self._base_url

    @property
    def metrics_url(self) -> str:
        return self._metrics_url

    @property
    def rest_metrics_prefix(self) -> str:
        return self._rest_metrics_prefix

    def start(self) -> None:
        env = os.environ.copy()
        env["MLSERVER_HOST"] = self._args.engine_host  # 0.0.0.0 (#159) — not vLLM's loopback
        env["MLSERVER_HTTP_PORT"] = str(self._args.engine_port)
        env["MLSERVER_GRPC_PORT"] = str(self._args.grpc_port)
        env["MLSERVER_METRICS_PORT"] = str(self._args.metrics_port)
        # MLServer defaults to `.metrics` below the process cwd. Inside a SIF that cwd may be part
        # of the immutable image, so direct launches and older workers need a writable fallback.
        # New workers inject a unique /scratch path and take precedence over this setdefault.
        env.setdefault("MLSERVER_METRICS_DIR", os.path.join(self._repo_dir, ".metrics"))
        env.setdefault("MLSERVER_ENVIRONMENTS_DIR", os.path.join(self._repo_dir, ".envs"))
        # A Sardeenz runner already isolates one model in its own process. Disable MLServer 1.7.1's
        # redundant child inference pool by default: under Python 3.12 + uvloop its child calls
        # asyncio.get_event_loop() without installing a loop and enters an endless restart cycle.
        env.setdefault("MLSERVER_PARALLEL_WORKERS", "0")
        env.setdefault("HF_HUB_OFFLINE", "1")  # never phone home at runtime (parity w/ vLLM image)
        # New process group so we can signal the whole MLServer tree on stop. Use the generated
        # writable repository as cwd too: MLServer settings and third-party runtimes may interpret
        # relative paths against cwd, which must never be the immutable SIF application directory.
        self._proc = subprocess.Popen(
            ["mlserver", "start", self._repo_dir],
            env=env,
            cwd=self._repo_dir,
            start_new_session=True,
        )

    def is_alive(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    async def poll_ready(self, client: httpx.AsyncClient) -> bool:
        """Return True once MLServer reports the model ready."""
        try:
            resp = await client.get(
                f"{self._base_url}{st.model_ready_path(self._model_name)}", timeout=2.0
            )
            return resp.status_code == 200
        except httpx.HTTPError:
            return False

    async def sleep(self, client: httpx.AsyncClient) -> None:
        resp = await client.post(
            f"{self._base_url}{st.repository_unload_path(self._model_name)}", timeout=120.0
        )
        resp.raise_for_status()

    async def wake(self, client: httpx.AsyncClient) -> None:
        resp = await client.post(
            f"{self._base_url}{st.repository_load_path(self._model_name)}", timeout=120.0
        )
        resp.raise_for_status()

    def stop(self, grace_seconds: float = 15.0) -> None:
        """SIGTERM the MLServer process group, then SIGKILL after the grace period."""
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
