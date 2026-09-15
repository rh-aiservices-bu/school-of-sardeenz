"""Entrypoint: `python3 -m sardeenz_vllm_runner --model … --port …`.

Invoked inside the SIF by the worker agent's ApptainerLauncher.
"""

from __future__ import annotations

import sys

import uvicorn

from .app import create_app
from .cli import parse_args


def main(argv: list[str] | None = None) -> None:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    app = create_app(args)
    # uvicorn installs SIGTERM/SIGINT handlers that trigger the FastAPI lifespan shutdown, which
    # SIGTERMs the vLLM subprocess (engine.stop) — so the whole tree drains on a single SIGTERM.
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
