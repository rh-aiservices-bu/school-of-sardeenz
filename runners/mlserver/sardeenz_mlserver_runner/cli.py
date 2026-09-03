"""Argument parsing for the MLServer runner shim (pure, unit-testable)."""

from __future__ import annotations

import argparse
import logging
import os
from dataclasses import dataclass, field

_log = logging.getLogger("sardeenz_mlserver_runner.cli")

# Default offsets from --engine-port for MLServer's gRPC and metrics servers (both bind even in
# REST-only deployments — see MLSERVER_GRPC_PORT/MLSERVER_METRICS_PORT below). Overridable via env
# so an operator can steer them off a busy range on a host running multiple oip runners.
_DEFAULT_GRPC_OFFSET = 10_000
_DEFAULT_METRICS_OFFSET = 20_000
_MAX_PORT = 65_535


@dataclass
class RunnerArgs:
    model: str  # source model-repository dir (read-only weights volume)
    port: int  # management (runner-contract) server port
    engine_port: int  # MLServer HTTP port
    host: str  # management-server bind host (default 0.0.0.0)
    engine_host: str  # MLServer HTTP bind host (default 0.0.0.0 — NOT loopback; #159)
    device_type: str  # "CUDA" | "CPU" | ... for capabilities/memory
    tensor_parallel: int  # accepted for CLI parity; MLServer v1 uses 1
    served_name: str  # first --served-model-name value (the model identity for model-settings.json)
    config_name: str  # last --served-model-name value (== modelName); == served_name when only one given
    grpc_port: int  # MLSERVER_GRPC_PORT (default engine_port + 10000; env override)
    metrics_port: int  # MLSERVER_METRICS_PORT (default engine_port + 20000; env override)
    extra_engine_args: list[str] = field(default_factory=list)  # post-`--` leftovers (ignored in v1)


def parse_args(argv: list[str]) -> RunnerArgs:
    """Parse the shim's CLI.

    The worker agent invokes: ``<entrypoint> --model /weights/<m> --port <PORT> [--engine-port N]
    -- --served-model-name <served> [<config>]``. This is byte-identical to the vLLM shim's CLI
    (ApptainerLauncher's argv tail is shared across runners) — the MLServer shim just extracts its
    model identity out of the ``--served-model-name`` passthrough instead of forwarding it verbatim
    to the engine, since MLServer has no argv pass-through.
    """
    forwarded: list[str] = []
    if "--" in argv:
        idx = argv.index("--")
        forwarded = argv[idx + 1 :]
        argv = argv[:idx]

    parser = argparse.ArgumentParser(prog="sardeenz-mlserver-runner", add_help=True)
    parser.add_argument("--model", required=True, help="Path to the model-repository dir (e.g. /weights/iris).")
    parser.add_argument(
        "--port", type=int, required=True, help="Port for the runner-contract HTTP server."
    )
    parser.add_argument(
        "--engine-port",
        type=int,
        default=None,
        help="Port for MLServer's HTTP server (defaults to --port + 1).",
    )
    parser.add_argument("--host", default="0.0.0.0", help="Bind host for the contract server.")
    parser.add_argument(
        "--engine-host", default="0.0.0.0", help="Bind host for MLServer's HTTP server."
    )
    parser.add_argument("--device-type", default="CUDA", help="Device type for capabilities.")
    parser.add_argument(
        "--tensor-parallel", type=int, default=1, help="Accepted for CLI parity; MLServer v1 uses 1."
    )
    ns = parser.parse_args(argv)

    engine_port = ns.engine_port if ns.engine_port is not None else ns.port + 1
    if engine_port == ns.port:
        raise ValueError("--engine-port must differ from --port")

    served_name, config_name, leftovers = _extract_served_names(forwarded)
    grpc_env = os.environ.get("SARDEENZ_MLSERVER_GRPC_PORT")
    metrics_env = os.environ.get("SARDEENZ_MLSERVER_METRICS_PORT")
    grpc_port, metrics_port = aux_ports(engine_port, grpc_env, metrics_env)
    if grpc_env or metrics_env:
        _log.info(
            "MLServer aux ports from worker env override: grpc=%d metrics=%d", grpc_port, metrics_port
        )
    else:
        _log.warning(
            "MLServer aux ports derived from +%d/+%d offsets of engine_port=%d (grpc=%d metrics=%d) "
            "— standalone/fallback path; the worker normally supplies SARDEENZ_MLSERVER_GRPC_PORT/"
            "SARDEENZ_MLSERVER_METRICS_PORT (#160)",
            _DEFAULT_GRPC_OFFSET,
            _DEFAULT_METRICS_OFFSET,
            engine_port,
            grpc_port,
            metrics_port,
        )

    return RunnerArgs(
        model=ns.model,
        port=ns.port,
        engine_port=engine_port,
        host=ns.host,
        engine_host=ns.engine_host,
        device_type=ns.device_type,
        tensor_parallel=ns.tensor_parallel,
        served_name=served_name,
        config_name=config_name,
        grpc_port=grpc_port,
        metrics_port=metrics_port,
        extra_engine_args=leftovers,
    )


def _extract_served_names(forwarded: list[str]) -> tuple[str, str, list[str]]:
    """Pull ``--served-model-name a [b …]`` out of the forwarded tokens.

    Returns ``(served, config, leftovers)`` where ``served`` is the first value and ``config`` is
    the last (equal when only one is given). The launcher always emits this flag
    (apptainer-launcher.ts) with the served name first, per ADR-020 — so its absence means a
    direct/malformed invocation and is a hard error, not a silent fallback.
    """
    if "--served-model-name" not in forwarded:
        raise ValueError("Missing required '--served-model-name' in forwarded engine args")

    idx = forwarded.index("--served-model-name")
    values: list[str] = []
    j = idx + 1
    while j < len(forwarded) and not forwarded[j].startswith("--"):
        values.append(forwarded[j])
        j += 1
    if not values:
        raise ValueError("'--served-model-name' requires at least one value")

    leftovers = forwarded[:idx] + forwarded[j:]
    return values[0], values[-1], leftovers


def aux_ports(engine_port: int, grpc_env: str | None, metrics_env: str | None) -> tuple[int, int]:
    """Derive MLServer's gRPC/metrics ports from the HTTP engine port.

    Pure: ``grpc_env``/``metrics_env`` are the already-read env var values (or ``None``), not env
    var names — kept out of ``os.environ`` here so this stays a pure, unit-testable function. Env
    overrides win; otherwise the ports default to ``engine_port + 10000`` / ``+ 20000``.

    As of #160 the worker's port allocator reserves an explicit gRPC/metrics port per runner and
    passes them via ``SARDEENZ_MLSERVER_GRPC_PORT``/``SARDEENZ_MLSERVER_METRICS_PORT`` (env
    override, above) on every worker-launched runner; the offset arithmetic here is a fallback for
    standalone/direct SIF invocation, where the ceiling guard below still applies.
    """
    grpc_port = int(grpc_env) if grpc_env else engine_port + _DEFAULT_GRPC_OFFSET
    metrics_port = int(metrics_env) if metrics_env else engine_port + _DEFAULT_METRICS_OFFSET

    for name, value in (("grpc", grpc_port), ("metrics", metrics_port)):
        if not (0 < value <= _MAX_PORT):
            raise ValueError(f"{name} port {value} is out of range (1-{_MAX_PORT})")

    if grpc_port == engine_port or metrics_port == engine_port:
        raise ValueError("gRPC/metrics port must differ from --engine-port")
    if grpc_port == metrics_port:
        raise ValueError("gRPC and metrics ports must differ from each other")

    return grpc_port, metrics_port
