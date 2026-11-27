"""Weights-format refusal policy (#336): refuse pickle-based weights unless explicitly opted in.

Enforcement point for the model-weights trust boundary (docs/usage/deployment-security.md).
Pure policy + one env read; wired by the shim's startup path (MLServer: build_model_settings;
vLLM: app lifespan). Standard library only — installed atop the engine SIF.
"""

from __future__ import annotations

import os
from typing import Mapping

ALLOW_UNSAFE_ENV = "SARDEENZ_ALLOW_UNSAFE_WEIGHTS"

# Set-equal to the control plane's REFUSED_WEIGHT_SUFFIXES (pinned by a vitest drift test there)
# and to the other shim's copy (pinned by runners/conformance/test_weights_policy.py).
# .bst (XGBoost binary) is NOT a pickle and is deliberately absent.
REFUSED_SUFFIXES: tuple[str, ...] = (
    ".bin",
    ".pt",
    ".pth",
    ".ckpt",
    ".pkl",
    ".pickle",
    ".joblib",
)


class WeightsRefusedError(ValueError):
    """A model directory contains pickle-based weights and the opt-in is absent."""


def allow_unsafe_from_env(environ: Mapping[str, str] | None = None) -> bool:
    """True only for '1' or 'true' (case-insensitive, whitespace-stripped).

    'yes', 'on', '' and unset are False — fail-closed by construction. Pure: takes the
    already-read mapping (or None for os.environ), mirroring cli.aux_ports' env split.
    """
    source = os.environ if environ is None else environ
    value = source.get(ALLOW_UNSAFE_ENV, "").strip().lower()
    return value in ("1", "true")


def refused_weight_files(source_dir: str) -> list[str]:
    """Sorted relative POSIX paths of refused weight files under source_dir, recursively.

    Walks every entry below source_dir — dot-directories (.cache, .w, ...), caches such as
    __pycache__ and ordinary subdirectories alike. HF subfolder= and a model-settings.json
    parameters.uri can point at any contained directory (settings.py refuses only escapes), so
    pruning any of them would leave a reachable load path unscanned. Metadata-only — the walk
    lists names, it never opens a file. Symlinked directories are not followed (os.walk
    default); for MLServer, a link whose target lies outside the model directory is refused by
    the parameters.uri containment check (realpath), but vLLM load paths not governed by that
    check (a weight_map entry in a *.bin.index.json, or --subfolder through engineArgs) would
    follow an outside-pointing link, so write access to the weights volume stays
    code-execution-equivalent. An unreadable or missing directory returns [] so the engine's own
    startup error is not masked.
    """
    refused: list[str] = []
    root = os.fsdecode(source_dir)
    try:
        for dirpath, _dirnames, filenames in os.walk(root):
            for name in filenames:
                if any(name.lower().endswith(s) for s in REFUSED_SUFFIXES):
                    refused.append(os.path.relpath(os.path.join(dirpath, name), root))
    except OSError:
        return []
    return sorted(refused)


def check_weights(source_dir: str, *, allow_unsafe: bool | None = None) -> None:
    """Raise WeightsRefusedError naming every offending file unless opted in.

    allow_unsafe=None reads the environment (allow_unsafe_from_env()).
    """
    if allow_unsafe is None:
        allow_unsafe = allow_unsafe_from_env()
    if allow_unsafe:
        return
    refused = refused_weight_files(source_dir)
    if refused:
        raise WeightsRefusedError(
            f"Refusing to load pickle-based weights in {source_dir}: "
            f"{', '.join(refused)}. These formats deserialize with pickle and can execute "
            "arbitrary code on this worker. Convert the weights to safetensors, or deploy "
            "with allowUnsafeWeights (SARDEENZ_ALLOW_UNSAFE_WEIGHTS=1) if you trust their source."
        )
