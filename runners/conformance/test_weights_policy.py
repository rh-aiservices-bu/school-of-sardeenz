"""Weights-format refusal policy (#336): one matrix, run against every shim's copy.

The policy module is duplicated per shim on purpose — the shims are separate distributions with
no shared package — so this suite is the anti-drift pin between the two copies. The control
plane's third copy is pinned by a vitest drift test
(``control-plane/src/services/__tests__/weights-policy.test.ts``).

Cases come from the #336 spec's conformance matrix; the decision of 2026-11-27 makes the whole
sklearn/pickle family opt-in-only while ``.bst`` (XGBoost binary, not a pickle) stays allowed.
"""

from __future__ import annotations

import pytest


def _write(root, name: str) -> None:
    """Create a fake weight file at ``root/name`` (parents included). Content is never read."""
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"not-really-weights")


def test_safetensors_huggingface_dir_is_allowed(weights_policy, tmp_path):
    _write(tmp_path, "config.json")
    _write(tmp_path, "model.safetensors")
    assert weights_policy.refused_weight_files(str(tmp_path)) == []
    weights_policy.check_weights(str(tmp_path), allow_unsafe=False)


def test_pickle_huggingface_dir_is_refused(weights_policy, tmp_path):
    _write(tmp_path, "config.json")
    _write(tmp_path, "pytorch_model.bin")
    with pytest.raises(weights_policy.WeightsRefusedError) as excinfo:
        weights_policy.check_weights(str(tmp_path), allow_unsafe=False)
    assert "pytorch_model.bin" in str(excinfo.value)


@pytest.mark.parametrize("name", ["model.pt", "model.pth", "model.ckpt"])
def test_torch_archive_is_refused(weights_policy, tmp_path, name):
    _write(tmp_path, name)
    assert weights_policy.refused_weight_files(str(tmp_path)) == [name]
    with pytest.raises(weights_policy.WeightsRefusedError):
        weights_policy.check_weights(str(tmp_path), allow_unsafe=False)


@pytest.mark.parametrize("name", ["model.pkl", "model.pickle", "model.joblib"])
def test_sklearn_family_is_refused(weights_policy, tmp_path, name):
    # Decision 2026-11-27: the sklearn family is opt-in-only.
    _write(tmp_path, name)
    assert weights_policy.refused_weight_files(str(tmp_path)) == [name]
    with pytest.raises(weights_policy.WeightsRefusedError):
        weights_policy.check_weights(str(tmp_path), allow_unsafe=False)


def test_xgboost_binary_is_allowed(weights_policy, tmp_path):
    # .bst is XGBoost's binary model format, not a pickle — deliberately outside the policy.
    _write(tmp_path, "model.bst")
    assert weights_policy.refused_weight_files(str(tmp_path)) == []
    weights_policy.check_weights(str(tmp_path))


def test_index_json_is_allowed(weights_policy, tmp_path):
    _write(tmp_path, "config.json")
    _write(tmp_path, "pytorch_model.bin.index.json")
    assert weights_policy.refused_weight_files(str(tmp_path)) == []


def test_nested_pickle_is_refused_with_relative_path(weights_policy, tmp_path):
    # Recursive on purpose: HF subfolder= and model-settings.json parameters.uri can point below
    # the model directory, so a pickle in a subdirectory is still loaded.
    _write(tmp_path, "config.json")
    _write(tmp_path, "sub/pytorch_model.bin")
    assert weights_policy.refused_weight_files(str(tmp_path)) == ["sub/pytorch_model.bin"]
    with pytest.raises(weights_policy.WeightsRefusedError) as excinfo:
        weights_policy.check_weights(str(tmp_path), allow_unsafe=False)
    assert "sub/pytorch_model.bin" in str(excinfo.value)


@pytest.mark.parametrize("name", [".cache/model.pkl", ".w/pytorch_model.bin"])
def test_pickle_in_dot_directory_is_refused(weights_policy, tmp_path, name):
    # a source-supplied model-settings.json can point parameters.uri at any contained directory
    # (only escapes are rejected), dot-directories included — so they must be scanned.
    _write(tmp_path, name)
    assert weights_policy.refused_weight_files(str(tmp_path)) == [name]
    with pytest.raises(weights_policy.WeightsRefusedError) as excinfo:
        weights_policy.check_weights(str(tmp_path), allow_unsafe=False)
    assert name in str(excinfo.value)


def test_pickle_in_pycache_is_refused(weights_policy, tmp_path):
    _write(tmp_path, "__pycache__/model.pt")
    assert weights_policy.refused_weight_files(str(tmp_path)) == ["__pycache__/model.pt"]
    with pytest.raises(weights_policy.WeightsRefusedError):
        weights_policy.check_weights(str(tmp_path), allow_unsafe=False)


def test_safetensors_in_dot_directory_is_allowed(weights_policy, tmp_path):
    _write(tmp_path, "config.json")
    _write(tmp_path, ".cache/model.safetensors")
    assert weights_policy.refused_weight_files(str(tmp_path)) == []
    weights_policy.check_weights(str(tmp_path), allow_unsafe=False)


def test_mixed_dir_with_pickle_is_refused(weights_policy, tmp_path):
    _write(tmp_path, "model.safetensors")
    _write(tmp_path, "pytorch_model.bin")
    assert "pytorch_model.bin" in weights_policy.refused_weight_files(str(tmp_path))
    with pytest.raises(weights_policy.WeightsRefusedError):
        weights_policy.check_weights(str(tmp_path), allow_unsafe=False)


def test_opt_in_allows_pickle_weights(weights_policy, tmp_path):
    _write(tmp_path, "pytorch_model.bin")
    weights_policy.check_weights(str(tmp_path), allow_unsafe=True)


def test_error_message_names_path_and_both_opt_in_spellings(weights_policy, tmp_path):
    _write(tmp_path, "config.json")
    _write(tmp_path, "pytorch_model.bin")
    with pytest.raises(weights_policy.WeightsRefusedError) as excinfo:
        weights_policy.check_weights(str(tmp_path), allow_unsafe=False)
    message = str(excinfo.value)
    assert "pytorch_model.bin" in message
    assert "allowUnsafeWeights" in message
    assert weights_policy.ALLOW_UNSAFE_ENV == "SARDEENZ_ALLOW_UNSAFE_WEIGHTS"
    assert "SARDEENZ_ALLOW_UNSAFE_WEIGHTS" in message


@pytest.mark.parametrize("value", ["1", "true", "TRUE", " True "])
def test_env_spelling_enables_the_opt_in(weights_policy, value):
    assert weights_policy.allow_unsafe_from_env({weights_policy.ALLOW_UNSAFE_ENV: value}) is True


@pytest.mark.parametrize("value", ["0", "false", "yes", "on", ""])
def test_env_spelling_denies_by_default(weights_policy, value):
    assert weights_policy.allow_unsafe_from_env({weights_policy.ALLOW_UNSAFE_ENV: value}) is False


def test_env_unset_denies(weights_policy):
    assert weights_policy.allow_unsafe_from_env({}) is False


def test_missing_directory_is_not_an_error(weights_policy, tmp_path):
    # The engine reports its own error later; refusing here would mask it.
    missing = str(tmp_path / "does-not-exist")
    assert weights_policy.refused_weight_files(missing) == []
    weights_policy.check_weights(missing, allow_unsafe=False)


def test_refused_suffixes_cover_the_documented_set(weights_policy):
    assert set(weights_policy.REFUSED_SUFFIXES) == {
        ".bin",
        ".pt",
        ".pth",
        ".ckpt",
        ".pkl",
        ".pickle",
        ".joblib",
    }
