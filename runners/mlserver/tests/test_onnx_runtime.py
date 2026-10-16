"""Integration test for the ONNX runtime against real MLServer + onnxruntime.

Skipped unless ``mlserver``, ``onnxruntime`` and ``onnx`` are importable (they are not part of the
dependency-light ``[test]`` extra that CI installs); run it from a venv that has them to validate
the runtime the SIF resolves as ``settings.ONNX_IMPL``.
"""

from __future__ import annotations

import asyncio

import pytest

mlserver = pytest.importorskip("mlserver")
onnx = pytest.importorskip("onnx")
pytest.importorskip("onnxruntime")
np = pytest.importorskip("numpy")

from mlserver.codecs import NumpyCodec  # noqa: E402
from mlserver.errors import InferenceError, MLServerError  # noqa: E402
from mlserver.settings import ModelParameters, ModelSettings  # noqa: E402
from mlserver.types import InferenceRequest, RequestOutput  # noqa: E402
from onnx import TensorProto, helper  # noqa: E402
from sardeenz_mlserver_runner import settings as cfg  # noqa: E402
from sardeenz_mlserver_runner.onnx_runtime import ONNXRuntimeModel  # noqa: E402


def _write_add_model(path) -> None:
    """y = a + b over float32 [batch, 2] tensors (a plain multi-input/one-output graph)."""
    a = helper.make_tensor_value_info("a", TensorProto.FLOAT, ["batch", 2])
    b = helper.make_tensor_value_info("b", TensorProto.FLOAT, ["batch", 2])
    y = helper.make_tensor_value_info("y", TensorProto.FLOAT, ["batch", 2])
    graph = helper.make_graph([helper.make_node("Add", ["a", "b"], ["y"])], "add", [a, b], [y])
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 13)])
    model.ir_version = 8
    onnx.checker.check_model(model)
    onnx.save(model, str(path))


def _write_single_input_model(path) -> None:
    """y = 2 * x over float32 [batch] (exercises positional single-input mapping + dtype coercion)."""
    x = helper.make_tensor_value_info("float_input", TensorProto.FLOAT, ["batch"])
    y = helper.make_tensor_value_info("y", TensorProto.FLOAT, ["batch"])
    two = helper.make_tensor("two", TensorProto.FLOAT, [], [2.0])
    graph = helper.make_graph(
        [helper.make_node("Mul", ["float_input", "two"], ["y"])], "mul", [x], [y], initializer=[two]
    )
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 13)])
    model.ir_version = 8
    onnx.save(model, str(path))


def _load(model_dir, name: str = "served", extra: dict | None = None) -> ONNXRuntimeModel:
    settings = ModelSettings(
        name=name,
        implementation=ONNXRuntimeModel,
        parameters=ModelParameters(uri=str(model_dir), extra=extra or {}),
    )
    model = ONNXRuntimeModel(settings)
    assert asyncio.run(model.load()) is True
    return model


def _infer(model: ONNXRuntimeModel, inputs: dict[str, np.ndarray], outputs=None):
    request = InferenceRequest(
        inputs=[NumpyCodec.encode_input(name, array) for name, array in inputs.items()],
        outputs=[RequestOutput(name=o) for o in outputs] if outputs else None,
    )
    return asyncio.run(model.predict(request))


def test_implementation_string_resolves_to_runtime():
    module_name, _, class_name = cfg.ONNX_IMPL.rpartition(".")
    module = __import__(module_name, fromlist=[class_name])
    assert getattr(module, class_name) is ONNXRuntimeModel


def test_multi_input_graph_round_trips_tensors(tmp_path):
    _write_add_model(tmp_path / "model.onnx")
    model = _load(tmp_path)

    response = _infer(
        model,
        {"a": np.array([[1, 2]], dtype=np.float32), "b": np.array([[10, 20]], dtype=np.float32)},
    )

    assert [o.name for o in response.outputs] == ["y"]
    np.testing.assert_array_equal(NumpyCodec.decode_output(response.outputs[0]), [[11.0, 22.0]])
    metadata = asyncio.run(model.metadata())
    assert [(t.name, t.datatype, t.shape) for t in metadata.inputs] == [
        ("a", "FP32", [-1, 2]),
        ("b", "FP32", [-1, 2]),
    ]
    assert [(t.name, t.datatype, t.shape) for t in metadata.outputs] == [("y", "FP32", [-1, 2])]


def test_single_input_positional_mapping_and_dtype_coercion(tmp_path):
    _write_single_input_model(tmp_path / "classifier.onnx")  # non-wellknown name, sole *.onnx
    model = _load(tmp_path)

    response = _infer(model, {"input-0": np.array([1.5, 2.5], dtype=np.float64)})

    # NumpyCodec encodes 1-D results as [N, 1] (MLServer convention) — compare flattened
    np.testing.assert_array_equal(NumpyCodec.decode_output(response.outputs[0]).reshape(-1), [3.0, 5.0])


def test_requesting_unknown_output_or_input_is_an_inference_error(tmp_path):
    _write_add_model(tmp_path / "model.onnx")
    model = _load(tmp_path)
    a = np.array([[1, 2]], dtype=np.float32)

    with pytest.raises(InferenceError, match="not model outputs"):
        _infer(model, {"a": a, "b": a}, outputs=["nope"])
    with pytest.raises(InferenceError, match="do not match"):
        _infer(model, {"a": a, "typo": a})


def test_explicit_uri_file_and_provider_pin(tmp_path):
    _write_add_model(tmp_path / "one.onnx")
    _write_add_model(tmp_path / "two.onnx")

    with pytest.raises(MLServerError, match="Several"):
        _load(tmp_path)

    model = _load(tmp_path / "two.onnx", extra={"providers": ["CPUExecutionProvider"]})
    assert model._session.get_providers() == ["CPUExecutionProvider"]

    with pytest.raises(MLServerError, match="not available"):
        _load(tmp_path / "two.onnx", extra={"providers": ["NoSuchExecutionProvider"]})


def test_unknown_session_option_fails_loudly(tmp_path):
    _write_add_model(tmp_path / "model.onnx")
    with pytest.raises(MLServerError, match="Unknown onnxruntime session option"):
        _load(tmp_path, extra={"session_options": {"not_an_option": 1}})
