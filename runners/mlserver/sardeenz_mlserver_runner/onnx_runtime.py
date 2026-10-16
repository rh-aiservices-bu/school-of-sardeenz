"""MLServer runtime for plain ONNX models, served by onnxruntime.

Seldon publishes no ``mlserver-onnx`` runtime, so the shim ships this one and references it as
``implementation: sardeenz_mlserver_runner.onnx_runtime.ONNXRuntimeModel`` in the generated
``model-settings.json`` (``settings.ONNX_IMPL``). It is loaded by ``mlserver start`` inside the
SIF, which is why ``mlserver``/``onnxruntime`` are imported here and not in the shim's
management-API modules.

Tensor inputs follow the KServe V2 dataplane one-to-one: each request input feeds the model
input of the same name (single-input models also accept any one name), each model output comes
back under its own name. Structured (non-tensor) outputs such as a ZipMap classifier's
``sequence(map)`` are returned as ``BYTES`` JSON documents.

``parameters.extra`` keys understood from ``model-settings.json``:

- ``providers``: list of onnxruntime execution providers, in priority order. Default: CUDA when
  the build has it, then CPU. onnxruntime silently drops a provider that fails to initialise
  (missing CUDA libraries, no visible GPU); with an explicit list that is a load error, with the
  default preference it is logged as a warning and the model serves on CPU.
- ``provider_options``: ``{provider name: {option: value}}`` passed to the session (e.g.
  ``{"CUDAExecutionProvider": {"device_id": 0}}``).
- ``session_options``: ``{option: value}`` applied as attributes on
  ``onnxruntime.SessionOptions`` (e.g. ``intra_op_num_threads``).
"""

from __future__ import annotations

import asyncio
from typing import Any

from mlserver.codecs import NumpyCodec, StringCodec
from mlserver.errors import InferenceError, MLServerError
from mlserver.logging import logger
from mlserver.model import MLModel
from mlserver.types import InferenceRequest, InferenceResponse, MetadataTensor, ResponseOutput
from mlserver.utils import get_model_uri

from . import onnx_support as support


class ONNXRuntimeModel(MLModel):
    """Serve one ONNX graph through an ``onnxruntime.InferenceSession``."""

    async def load(self) -> bool:
        import onnxruntime as ort

        extra: dict[str, Any] = {}
        if self._settings.parameters and self._settings.parameters.extra:
            extra = dict(self._settings.parameters.extra)

        model_uri = await get_model_uri(
            self._settings, wellknown_filenames=list(support.WELLKNOWN_ONNX_FILENAMES)
        )
        requested = extra.get("providers")
        try:
            artifact = support.resolve_onnx_artifact(model_uri)
            providers = support.select_providers(requested, ort.get_available_providers())
        except ValueError as exc:
            raise MLServerError(str(exc)) from exc

        if support.CUDA_PROVIDER in providers:
            _preload_cuda_libraries(ort)

        session_options = ort.SessionOptions()
        for key, value in (extra.get("session_options") or {}).items():
            if not hasattr(session_options, key):
                raise MLServerError(f"Unknown onnxruntime session option {key!r}")
            setattr(session_options, key, value)

        provider_options = extra.get("provider_options") or {}
        provider_args: list[Any] = [
            (name, provider_options[name]) if name in provider_options else name
            for name in providers
        ]

        logger.info("Loading ONNX model %s with providers %s", artifact, providers)
        self._session = await asyncio.get_running_loop().run_in_executor(
            None,
            lambda: ort.InferenceSession(
                artifact, sess_options=session_options, providers=provider_args
            ),
        )
        active = list(self._session.get_providers())
        missing = support.missing_providers(providers, active)
        if missing and requested:
            self._session = None
            raise MLServerError(
                f"onnxruntime could not initialise the requested providers {missing} for model "
                f"{self.name} (session runs on {active}); see the onnxruntime warnings above "
                "(missing CUDA/cuDNN libraries, no visible GPU, or driver too old)."
            )
        if missing:
            logger.warning(
                "ONNX model %s: providers %s failed to initialise, falling back to %s — the "
                "model is NOT on the GPU; see the onnxruntime warnings above.",
                self.name,
                missing,
                active,
            )

        self._model_inputs = {node.name: node for node in self._session.get_inputs()}
        self._model_outputs = [node.name for node in self._session.get_outputs()]
        self._publish_metadata()
        logger.info(
            "ONNX model %s ready: providers=%s inputs=%s outputs=%s",
            self.name,
            active,
            list(self._model_inputs),
            self._model_outputs,
        )
        return True

    async def unload(self) -> bool:
        self._session = None
        return True

    async def predict(self, payload: InferenceRequest) -> InferenceResponse:
        session = getattr(self, "_session", None)
        if session is None:
            raise InferenceError(f"Model {self.name} is not loaded")

        try:
            mapping = support.map_request_inputs(
                [inp.name for inp in payload.inputs], list(self._model_inputs)
            )
        except ValueError as exc:
            raise InferenceError(str(exc)) from exc

        feeds: dict[str, Any] = {}
        for request_input in payload.inputs:
            model_name = mapping[request_input.name]
            array = NumpyCodec.decode_input(request_input)
            node = self._model_inputs[model_name]
            feeds[model_name] = support.coerce_input(array, node.type, node.shape)

        output_names: list[str] | None = None
        if payload.outputs:
            output_names = [out.name for out in payload.outputs]
            unknown = [name for name in output_names if name not in self._model_outputs]
            if unknown:
                raise InferenceError(
                    f"Requested outputs {unknown} are not model outputs {self._model_outputs}"
                )

        try:
            # onnxruntime releases the GIL inside run(); keep the event loop (and the V2
            # readiness/health endpoints the shim polls) responsive during long inferences.
            results = await asyncio.get_running_loop().run_in_executor(
                None, lambda: session.run(output_names, feeds)
            )
        except Exception as exc:  # noqa: BLE001 - surface onnxruntime's message verbatim
            raise InferenceError(f"onnxruntime inference failed: {exc}") from exc

        names = output_names or self._model_outputs
        outputs = [self._encode_output(name, value) for name, value in zip(names, results)]
        return InferenceResponse(model_name=self.name, model_version=self.version, outputs=outputs)

    @staticmethod
    def _encode_output(name: str, value: Any) -> ResponseOutput:
        coerced = support.coerce_output(value)
        if isinstance(coerced, list):
            return StringCodec.encode_output(name, coerced)
        return NumpyCodec.encode_output(name, coerced)

    def _publish_metadata(self) -> None:
        """Expose the graph's signature on ``GET /v2/models/{name}`` unless settings declare one."""
        if not self._settings.inputs:
            self.inputs = [
                MetadataTensor(
                    name=node.name,
                    datatype=support.ort_type_to_v2_datatype(node.type),
                    shape=support.normalize_shape(node.shape),
                )
                for node in self._model_inputs.values()
            ]
        if not self._settings.outputs:
            self.outputs = [
                MetadataTensor(
                    name=node.name,
                    datatype=support.ort_type_to_v2_datatype(node.type),
                    shape=support.normalize_shape(node.shape),
                )
                for node in self._session.get_outputs()
            ]


def _cuda_provider_libraries(ort: Any) -> tuple[str, ...]:
    """Sonames the CUDA provider dlopen()s, for the onnxruntime build's CUDA major (12 → ``.so.12``)."""
    major = str(getattr(ort, "cuda_version", "") or "").split(".")[0] or "12"
    return (f"libcudart.so.{major}", f"libcublasLt.so.{major}", "libcudnn.so.9")


def _preload_cuda_libraries(ort: Any) -> None:
    """Load CUDA/cuDNN from the pip-installed NVIDIA packages before the CUDA provider initialises.

    ``onnxruntime-gpu`` is built against a newer CUDA toolkit than the SIF's base image carries,
    so the image installs the ``[cuda,cudnn]`` extras (``nvidia-*-cu12`` wheels) and puts their
    ``lib/`` directories on ``LD_LIBRARY_PATH`` (the Containerfile explains why ``preload_dlls``
    alone cannot find them on a RHEL-family Python). ``preload_dlls`` (onnxruntime ≥ 1.21) never
    raises — it only prints — so the libraries are re-checked by soname here and a failure is
    logged at ERROR; the provider check in ``load`` then fails or warns.
    """
    import ctypes

    preload = getattr(ort, "preload_dlls", None)
    if preload is not None:
        try:
            preload(cuda=True, cudnn=True, msvc=False)
        except Exception as exc:  # noqa: BLE001
            logger.warning("onnxruntime.preload_dlls failed (continuing): %s", exc)

    for library in _cuda_provider_libraries(ort):
        try:
            ctypes.CDLL(library)
        except OSError as exc:
            logger.error(
                "CUDA provider library %s is not loadable (%s): the CUDAExecutionProvider will "
                "fail to initialise. Check LD_LIBRARY_PATH / the nvidia-*-cu12 wheels in the SIF.",
                library,
                exc,
            )
