"""Pure helpers behind the ONNX runtime (``onnx_runtime.py``).

Kept free of ``mlserver``/``onnxruntime`` imports so they stay unit-testable in the shim's
dependency-light test suite (``tests/``); only ``numpy`` is required, and only at call time.
"""

from __future__ import annotations

import json
import os
from typing import Any, Mapping, Sequence

CUDA_PROVIDER = "CUDAExecutionProvider"
CPU_PROVIDER = "CPUExecutionProvider"

# Providers tried in order when model-settings.json does not pin ``parameters.extra.providers``.
DEFAULT_PROVIDER_PREFERENCE: tuple[str, ...] = (CUDA_PROVIDER, CPU_PROVIDER)

# Searched inside a directory ``parameters.uri`` before falling back to "the only *.onnx file".
WELLKNOWN_ONNX_FILENAMES: tuple[str, ...] = ("model.onnx",)

ONNX_SUFFIX = ".onnx"

# onnxruntime tensor type strings → numpy dtype names. Non-tensor types (sequences, maps,
# optional, sparse) are absent on purpose: they are not coerced on input and are JSON-encoded
# on output (see ``coerce_output``).
_ORT_TO_NUMPY: Mapping[str, str] = {
    "tensor(float)": "float32",
    "tensor(float16)": "float16",
    "tensor(double)": "float64",
    "tensor(bfloat16)": "uint16",  # no native numpy bfloat16; raw bits, left to the caller
    "tensor(int8)": "int8",
    "tensor(int16)": "int16",
    "tensor(int32)": "int32",
    "tensor(int64)": "int64",
    "tensor(uint8)": "uint8",
    "tensor(uint16)": "uint16",
    "tensor(uint32)": "uint32",
    "tensor(uint64)": "uint64",
    "tensor(bool)": "bool",
    "tensor(string)": "object",
}

# numpy dtype name → KServe V2 ``datatype`` for the model-metadata endpoint.
_NUMPY_TO_V2: Mapping[str, str] = {
    "float16": "FP16",
    "float32": "FP32",
    "float64": "FP64",
    "int8": "INT8",
    "int16": "INT16",
    "int32": "INT32",
    "int64": "INT64",
    "uint8": "UINT8",
    "uint16": "UINT16",
    "uint32": "UINT32",
    "uint64": "UINT64",
    "bool": "BOOL",
    "object": "BYTES",
}


def resolve_onnx_artifact(uri: str) -> str:
    """Return the ``.onnx`` file to load from ``uri`` (a file, or a directory holding one).

    ``mlserver.utils.get_model_uri`` already resolves a directory to ``model.onnx`` when that
    well-known file exists; this handles the remaining directory case by accepting a single
    top-level ``*.onnx`` file. Zero or several candidates fail loudly (fail-fast, like
    ``settings.infer_implementation``) so the operator pins ``parameters.uri`` instead of MLServer
    surfacing an opaque load error.
    """
    if os.path.isfile(uri):
        return uri
    if not os.path.isdir(uri):
        raise ValueError(f"ONNX model uri {uri!r} is neither a file nor a directory")

    for name in WELLKNOWN_ONNX_FILENAMES:
        candidate = os.path.join(uri, name)
        if os.path.isfile(candidate):
            return candidate

    candidates = sorted(
        name
        for name in os.listdir(uri)
        if name.endswith(ONNX_SUFFIX) and os.path.isfile(os.path.join(uri, name))
    )
    if len(candidates) == 1:
        return os.path.join(uri, candidates[0])
    if not candidates:
        raise ValueError(
            f"No *.onnx artifact found in {uri!r}: add one (e.g. model.onnx) or point "
            "model-settings.json parameters.uri at the exact file."
        )
    raise ValueError(
        f"Several *.onnx artifacts in {uri!r} ({', '.join(candidates)}): point "
        "model-settings.json parameters.uri at the one to serve."
    )


def select_providers(requested: Sequence[str] | None, available: Sequence[str]) -> list[str]:
    """Pick the onnxruntime execution providers to construct the session with.

    An explicit ``requested`` list (``parameters.extra.providers``) is honoured verbatim but each
    entry must be present in ``available`` (``onnxruntime.get_available_providers()``), so a
    settings file asking for CUDA on a CPU-only build fails at load rather than silently running
    on CPU. Without a request, CUDA is preferred and CPU is always kept as the fallback.
    """
    available_set = set(available)
    if requested:
        unknown = [p for p in requested if p not in available_set]
        if unknown:
            raise ValueError(
                f"Requested onnxruntime providers not available in this build: {unknown} "
                f"(available: {sorted(available_set)})"
            )
        return list(requested)

    chosen = [p for p in DEFAULT_PROVIDER_PREFERENCE if p in available_set]
    if not chosen:
        raise ValueError(f"No usable onnxruntime execution provider (available: {sorted(available_set)})")
    return chosen


def missing_providers(chosen: Sequence[str], active: Sequence[str]) -> list[str]:
    """Return the providers the session was asked for but did not end up with, in order.

    onnxruntime never fails ``InferenceSession`` when a provider cannot initialise (missing
    cuDNN, no visible GPU, driver too old): it logs a warning and runs on the remaining ones,
    typically CPU. The runtime compares ``session.get_providers()`` against what it requested and
    fails the load (explicit ``parameters.extra.providers``) or warns (default preference).
    """
    active_set = set(active)
    return [p for p in chosen if p not in active_set]


def ort_type_to_numpy_dtype(ort_type: str) -> str | None:
    """Map an onnxruntime type string (``tensor(float)``) to a numpy dtype name, or ``None``."""
    return _ORT_TO_NUMPY.get(ort_type)


def ort_type_to_v2_datatype(ort_type: str) -> str:
    """Map an onnxruntime type string to a KServe V2 ``datatype`` (``BYTES`` when unknown)."""
    dtype_name = _ORT_TO_NUMPY.get(ort_type)
    if dtype_name is None:
        return "BYTES"
    return _NUMPY_TO_V2.get(dtype_name, "BYTES")


def normalize_shape(shape: Sequence[Any] | None) -> list[int]:
    """Replace symbolic/unknown onnxruntime dims (``'batch'``, ``None``) with ``-1``."""
    if shape is None:
        return []
    return [dim if isinstance(dim, int) and not isinstance(dim, bool) else -1 for dim in shape]


def map_request_inputs(
    request_names: Sequence[str], model_input_names: Sequence[str]
) -> dict[str, str]:
    """Return ``{request input name: model input name}``.

    Names match verbatim. As the one convenience, a single-input model fed a single request input
    under a different name is mapped positionally — KServe V2 clients frequently send
    ``"input"``/``"input-0"`` for the sole tensor. Anything else is an error so that typos do not
    silently become missing feeds.
    """
    model_set = set(model_input_names)
    mapping = {name: name for name in request_names if name in model_set}
    if len(mapping) == len(request_names):
        return mapping

    if len(request_names) == 1 and len(model_input_names) == 1:
        return {request_names[0]: model_input_names[0]}

    unknown = sorted(set(request_names) - model_set)
    raise ValueError(
        f"Request inputs {unknown} do not match the model's inputs {list(model_input_names)}"
    )


def coerce_input(array: Any, ort_type: str, expected_shape: Sequence[Any] | None = None) -> Any:
    """Fit ``array`` to the dtype and rank the model declares for that input.

    - dtype: cast when the onnxruntime type maps to numpy (a V2 ``FP64`` payload feeding a
      ``tensor(float)`` input becomes float32).
    - rank: MLServer's ``NumpyCodec``/``NumpyRequestCodec`` encode 1-D data as ``[N, 1]``; when
      the model declares exactly one rank less and the trailing dim is 1, that dim is squeezed.
      No other reshaping is attempted — onnxruntime reports genuine mismatches.
    """
    import numpy as np

    target = ort_type_to_numpy_dtype(ort_type)
    if target is not None and array.dtype != np.dtype(target):
        array = array.astype(np.dtype(target), copy=False)

    if (
        expected_shape is not None
        and array.ndim == len(expected_shape) + 1
        and array.ndim > 0
        and array.shape[-1] == 1
    ):
        array = array.reshape(array.shape[:-1])
    return array


def coerce_output(value: Any) -> Any:
    """Normalise one ``session.run`` output to something a KServe V2 codec can encode.

    Returns a ``numpy.ndarray`` for tensor-shaped outputs, or a ``list[str]`` of JSON documents
    for structured outputs (e.g. the ``sequence(map(...))`` a sklearn-onnx classifier's ZipMap
    node emits), which the caller encodes as ``BYTES``.
    """
    import numpy as np

    if isinstance(value, np.ndarray):
        return value
    try:
        array = np.asarray(value)
    except (ValueError, TypeError):
        array = np.asarray(value, dtype=object)
    if array.dtype != np.dtype(object):
        return array
    items = value if isinstance(value, (list, tuple)) else array.tolist()
    return [json.dumps(item, default=_json_default) for item in items]


def _json_default(obj: Any) -> Any:
    import numpy as np

    if isinstance(obj, np.generic):
        return obj.item()
    if isinstance(obj, np.ndarray):
        return obj.tolist()
    raise TypeError(f"Object of type {type(obj).__name__} is not JSON serializable")
