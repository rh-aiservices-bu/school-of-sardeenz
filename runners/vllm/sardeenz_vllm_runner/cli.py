"""Argument parsing for the vLLM runner shim (pure, unit-testable)."""

from __future__ import annotations

import argparse
from dataclasses import dataclass, field


@dataclass
class RunnerArgs:
    model: str
    port: int
    engine_port: int
    host: str
    device_type: str
    tensor_parallel: int
    # Extra args passed through to `vllm serve` (everything after `--`). The worker forwards
    # `--served-model-name <routing-name>` here so vLLM registers the model under the routing name
    # (not its weights path) and client `model` fields resolve — see ApptainerLauncher.
    engine_args: list[str] = field(default_factory=list)


def parse_args(argv: list[str]) -> RunnerArgs:
    """Parse the shim's CLI.

    The worker agent invokes: ``<entrypoint> --model /weights/<m> --port <PORT> [--engine-port N]``.
    Anything after a literal ``--`` is forwarded verbatim to ``vllm serve``.
    """
    forwarded: list[str] = []
    if "--" in argv:
        idx = argv.index("--")
        forwarded = argv[idx + 1 :]
        argv = argv[:idx]

    parser = argparse.ArgumentParser(prog="sardeenz-vllm-runner", add_help=True)
    parser.add_argument("--model", required=True, help="Path to model weights (e.g. /weights/llama).")
    parser.add_argument(
        "--port", type=int, required=True, help="Port for the runner-contract HTTP server."
    )
    parser.add_argument(
        "--engine-port",
        type=int,
        default=None,
        help="Port for vLLM's OpenAI server (defaults to --port + 1).",
    )
    parser.add_argument("--host", default="0.0.0.0", help="Bind host for the contract server.")
    parser.add_argument("--device-type", default="CUDA", help="Device type for capabilities.")
    parser.add_argument(
        "--tensor-parallel", type=int, default=1, help="Tensor-parallel degree passed to vLLM."
    )
    ns = parser.parse_args(argv)

    engine_port = ns.engine_port if ns.engine_port is not None else ns.port + 1
    if engine_port == ns.port:
        raise ValueError("--engine-port must differ from --port")

    return RunnerArgs(
        model=ns.model,
        port=ns.port,
        engine_port=engine_port,
        host=ns.host,
        device_type=ns.device_type,
        tensor_parallel=ns.tensor_parallel,
        engine_args=forwarded,
    )


def build_vllm_command(args: RunnerArgs) -> list[str]:
    """Construct the `vllm serve` command the shim launches as a subprocess.

    ``--enable-sleep-mode`` is required for vLLM's /sleep + /wake_up dev endpoints, which back the
    runner contract's sleep/wake. Tensor parallelism and any forwarded engine args are appended.
    """
    cmd = [
        "vllm",
        "serve",
        args.model,
        "--host",
        "127.0.0.1",
        "--port",
        str(args.engine_port),
        "--enable-sleep-mode",
    ]
    if args.tensor_parallel > 1:
        cmd += ["--tensor-parallel-size", str(args.tensor_parallel)]
    cmd += args.engine_args
    return cmd
