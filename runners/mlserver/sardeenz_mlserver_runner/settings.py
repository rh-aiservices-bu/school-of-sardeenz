"""Writable MLServer model-repository generation for the runner shim.

The weights volume the worker mounts ``--model`` from is read-only inside a SIF, and MLServer
needs to read a ``model-settings.json`` naming the model it serves. This module generates a fresh,
writable model repository under scratch containing that file — enforcing the served-name identity
(#77 lesson) whether or not the source directory already ships its own settings.
"""

from __future__ import annotations

import json
import os
import tempfile
from typing import Any

SKLEARN_IMPL = "mlserver_sklearn.SKLearnModel"
HUGGINGFACE_IMPL = "mlserver_huggingface.HuggingFaceRuntime"

_SKLEARN_MARKERS = (".joblib", ".pkl", ".bst")
_HUGGINGFACE_WEIGHT_MARKERS = (".safetensors", "pytorch_model.bin", "tokenizer.json")


def infer_implementation(source_dir: str) -> str:
    """Infer the MLServer ``implementation`` string from the source dir's contents.

    Raises ``ValueError`` (loud, fail-fast — mirrors the shim's general philosophy, cli.py) when
    nothing recognizable is found, so a bad model dir fails at startup rather than surfacing as an
    opaque MLServer load error.
    """
    try:
        entries = os.listdir(source_dir)
    except OSError as exc:
        raise ValueError(f"Cannot list model directory {source_dir!r}: {exc}") from None

    if "model.json" in entries or any(name.endswith(_SKLEARN_MARKERS) for name in entries):
        return SKLEARN_IMPL

    if "config.json" in entries and any(name.endswith(_HUGGINGFACE_WEIGHT_MARKERS) for name in entries):
        return HUGGINGFACE_IMPL

    raise ValueError(
        f"Could not infer an MLServer runtime for {source_dir!r}: expected sklearn/xgboost "
        "artifacts (*.joblib, *.pkl, *.bst, model.json) or a HuggingFace repo (config.json + "
        "*.safetensors/pytorch_model.bin/tokenizer.json)."
    )


def load_source_model_settings(source_dir: str) -> dict[str, Any] | None:
    """Return the parsed ``source_dir/model-settings.json`` if present, else ``None``."""
    path = os.path.join(source_dir, "model-settings.json")
    if not os.path.isfile(path):
        return None
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def _require_contained(uri: str, source_dir: str) -> None:
    """Reject ``uri`` if it does not resolve to ``source_dir`` itself or strictly inside it.

    Mirrors the containment semantics of the control plane's ``isContainedIn`` (TS side): resolve
    both paths (``os.path.realpath``, so symlinks can't be used to escape) and require the uri to
    equal the resolved source dir or sit strictly under it (prefix match on ``source_dir + os.sep``).
    Re-enforces the #113 containment invariant the launcher applies to ``--model`` — a source
    directory's own ``model-settings.json`` must not be able to point MLServer outside itself.
    """
    real_source = os.path.realpath(source_dir)
    real_uri = os.path.realpath(uri)
    if real_uri != real_source and not real_uri.startswith(real_source + os.sep):
        raise ValueError(
            f"model-settings.json parameters.uri escapes the model directory: {uri!r} "
            f"resolves to {real_uri!r}, outside {real_source!r}"
        )


def build_model_settings(source_dir: str, model_name: str) -> dict[str, Any]:
    """Build the ``model-settings.json`` body enforcing ``model_name`` as the served identity.

    If the source dir already ships a ``model-settings.json``, it is deep-copied with only
    ``name`` overridden and (when relative) ``parameters.uri`` rebased to an absolute path under
    ``source_dir``. Otherwise a fresh settings body is generated, inferring ``implementation`` from
    the dir's contents. Either way, the resulting ``parameters.uri`` is re-validated to resolve to
    ``source_dir`` itself or somewhere strictly inside it (see ``_require_contained``) — a
    crafted absolute or ``../``-relative uri in a source-supplied model-settings.json must not be
    able to make MLServer load from an arbitrary path reachable inside the SIF mounts.
    """
    source_settings = load_source_model_settings(source_dir)
    if source_settings is not None:
        settings = json.loads(json.dumps(source_settings))  # deep copy
        settings["name"] = model_name
        parameters = settings.setdefault("parameters", {})
        uri = parameters.get("uri")
        if uri and not os.path.isabs(uri):
            resolved_uri = os.path.normpath(os.path.join(source_dir, uri))
        elif not uri:
            resolved_uri = source_dir
        else:
            resolved_uri = uri
        _require_contained(resolved_uri, source_dir)
        parameters["uri"] = resolved_uri
        return settings

    return {
        "name": model_name,
        "implementation": infer_implementation(source_dir),
        "parameters": {"uri": source_dir},
    }


def write_model_repository(model_settings: dict[str, Any], repo_root: str | None = None) -> str:
    """Write ``model_settings`` into a fresh writable repo dir; return the dir path.

    This is the directory passed to ``mlserver start``. ``repo_root`` defaults to ``$HOME`` (the
    worker redirects HOME to node-local /scratch — apptainer-launcher.ts) or the platform temp dir.
    """
    base = repo_root or os.environ.get("HOME") or tempfile.gettempdir()
    repo_dir = tempfile.mkdtemp(prefix="sardeenz-mlserver-", dir=base)
    with open(os.path.join(repo_dir, "model-settings.json"), "w", encoding="utf-8") as fh:
        json.dump(model_settings, fh)
    return repo_dir
