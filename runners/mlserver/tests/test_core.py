"""Pure-logic tests for the MLServer runner shim — no MLServer/torch/httpx/FastAPI required.

Run via `pytest` from runners/mlserver/. These cover contract-shape correctness, CLI/served-name
extraction, and model-repository generation; the engine + HTTP layers are exercised by the cluster
integration gates (Unit D).
"""

from __future__ import annotations

import json
import os
import sys
import types

import pytest

from sardeenz_mlserver_runner import memory as mem
from sardeenz_mlserver_runner import settings as cfg
from sardeenz_mlserver_runner import state as st
from sardeenz_mlserver_runner.cli import _extract_served_names, aux_ports, parse_args


def _install_fake_torch(monkeypatch: pytest.MonkeyPatch, device_count: int = 2) -> None:
    """Inject a fake `torch` module — torch isn't installed outside the runner-mlserver image."""
    fake_torch = types.ModuleType("torch")
    fake_torch.cuda = types.SimpleNamespace(  # type: ignore[attr-defined]
        is_available=lambda: True,
        device_count=lambda: device_count,
        mem_get_info=lambda index: (1_000, 10_000),
        memory_reserved=lambda index: 2_000,
    )
    monkeypatch.setitem(sys.modules, "torch", fake_torch)


# --- cli.py -------------------------------------------------------------------------------------


def test_parse_args_defaults_engine_port_to_port_plus_one():
    # NOTE: deviates from the blueprint's literal `--model /repo --port 9101` (no `--`) — parse_args
    # requires `--served-model-name` (design decision #1: the launcher always emits it, so absence
    # is a hard error), so this adds the minimal passthrough needed to exercise engine-port
    # defaulting without tripping that check.
    args = parse_args(["--model", "/repo", "--port", "9101", "--", "--served-model-name", "org/m"])
    assert args.model == "/repo"
    assert args.port == 9101
    assert args.engine_port == 9102


def test_parse_args_rejects_equal_ports():
    with pytest.raises(ValueError):
        parse_args(["--model", "/w/m", "--port", "9101", "--engine-port", "9101"])


def test_extract_served_names_single():
    served, config, leftovers = _extract_served_names(["--served-model-name", "org/m"])
    assert served == "org/m"
    assert config == "org/m"
    assert leftovers == []


def test_extract_served_names_served_first_then_config():
    served, config, leftovers = _extract_served_names(
        ["--served-model-name", "served", "org/m"]
    )
    assert served == "served"
    assert config == "org/m"
    assert leftovers == []


def test_extract_served_names_missing_raises():
    with pytest.raises(ValueError):
        _extract_served_names([])


def test_parse_args_end_to_end_from_launcher_argv():
    argv = [
        "--model",
        "/repo",
        "--port",
        "9101",
        "--engine-port",
        "9102",
        "--",
        "--served-model-name",
        "served",
        "org/m",
    ]
    args = parse_args(argv)
    assert args.served_name == "served"
    assert args.config_name == "org/m"
    assert args.model == "/repo"


def test_parse_args_uses_env_override_ports(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("SARDEENZ_MLSERVER_GRPC_PORT", "18000")
    monkeypatch.setenv("SARDEENZ_MLSERVER_METRICS_PORT", "28000")
    argv = ["--model", "/repo", "--port", "9101", "--", "--served-model-name", "org/m"]
    args = parse_args(argv)
    assert args.grpc_port == 18000
    assert args.metrics_port == 28000


def test_parse_args_falls_back_to_offsets_without_env(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("SARDEENZ_MLSERVER_GRPC_PORT", raising=False)
    monkeypatch.delenv("SARDEENZ_MLSERVER_METRICS_PORT", raising=False)
    argv = ["--model", "/repo", "--port", "9101", "--", "--served-model-name", "org/m"]
    args = parse_args(argv)
    assert args.grpc_port == 19102
    assert args.metrics_port == 29102


def test_aux_ports_defaults_and_env_override():
    assert aux_ports(9102, None, None) == (19102, 29102)
    assert aux_ports(9102, "18000", "28000") == (18000, 28000)
    with pytest.raises(ValueError):
        aux_ports(9102, "9102", None)  # collides with engine_port
    with pytest.raises(ValueError):
        aux_ports(9102, "18000", "18000")  # grpc == metrics
    with pytest.raises(ValueError):
        aux_ports(9102, "70000", None)  # > 65535


# --- settings.py (model-repository generation) ---------------------------------------------------


def test_build_model_settings_rewrites_existing_name(tmp_path):
    source_settings = {
        "name": "orig",
        "implementation": cfg.SKLEARN_IMPL,
        "parameters": {"uri": "./m.joblib"},
    }
    (tmp_path / "model-settings.json").write_text(json.dumps(source_settings))

    settings = cfg.build_model_settings(str(tmp_path), "served")

    assert settings["name"] == "served"
    assert settings["implementation"] == cfg.SKLEARN_IMPL
    assert os.path.isabs(settings["parameters"]["uri"])
    assert settings["parameters"]["uri"].startswith(str(tmp_path))


def test_build_model_settings_generates_sklearn_when_absent(tmp_path):
    (tmp_path / "m.joblib").write_text("fake")

    settings = cfg.build_model_settings(str(tmp_path), "served")

    assert settings == {
        "name": "served",
        "implementation": cfg.SKLEARN_IMPL,
        "parameters": {"uri": str(tmp_path)},
    }


def test_build_model_settings_rejects_relative_uri_escape(tmp_path):
    source_settings = {
        "name": "orig",
        "implementation": cfg.SKLEARN_IMPL,
        "parameters": {"uri": "../../../etc"},
    }
    (tmp_path / "model-settings.json").write_text(json.dumps(source_settings))

    with pytest.raises(ValueError, match="escapes the model directory"):
        cfg.build_model_settings(str(tmp_path), "served")


def test_build_model_settings_rejects_absolute_uri_outside_source_dir(tmp_path):
    outside = tmp_path.parent / "sibling-model"
    outside.mkdir()
    source_settings = {
        "name": "orig",
        "implementation": cfg.SKLEARN_IMPL,
        "parameters": {"uri": str(outside)},
    }
    (tmp_path / "model-settings.json").write_text(json.dumps(source_settings))

    with pytest.raises(ValueError, match="escapes the model directory"):
        cfg.build_model_settings(str(tmp_path), "served")


def test_build_model_settings_allows_absolute_uri_inside_source_dir(tmp_path):
    nested = tmp_path / "weights"
    nested.mkdir()
    source_settings = {
        "name": "orig",
        "implementation": cfg.SKLEARN_IMPL,
        "parameters": {"uri": str(nested)},
    }
    (tmp_path / "model-settings.json").write_text(json.dumps(source_settings))

    settings = cfg.build_model_settings(str(tmp_path), "served")

    assert settings["parameters"]["uri"] == str(nested)


def test_infer_implementation_huggingface(tmp_path):
    (tmp_path / "config.json").write_text("{}")
    (tmp_path / "model.safetensors").write_text("fake")

    assert cfg.infer_implementation(str(tmp_path)) == cfg.HUGGINGFACE_IMPL


def test_infer_implementation_unknown_raises(tmp_path):
    with pytest.raises(ValueError):
        cfg.infer_implementation(str(tmp_path))


def test_write_model_repository_writes_one_settings_file(tmp_path):
    settings = {"name": "served", "implementation": cfg.SKLEARN_IMPL, "parameters": {"uri": "/x"}}

    repo_dir = cfg.write_model_repository(settings, repo_root=str(tmp_path))

    entries = os.listdir(repo_dir)
    assert entries == ["model-settings.json"]
    with open(os.path.join(repo_dir, "model-settings.json"), encoding="utf-8") as fh:
        assert json.load(fh) == settings


# --- state.py (state machine + capabilities + response shapes) -----------------------------------


def test_status_lifecycle_transitions():
    status = st.RunnerStatus()
    assert status.state == st.STARTING
    health = status.health()
    assert health["state"] == st.STARTING
    assert "progress" in health  # progress present only while STARTING

    status.mark_ready()
    assert status.state == st.READY
    ready_health = status.health(active_requests=3)
    assert ready_health["state"] == st.READY
    assert ready_health["activeRequests"] == 3
    assert "progress" not in ready_health  # no progress once READY

    status.mark_sleeping(st.L1_HOST_RAM)
    assert status.sleep_status() == {"isSleeping": True, "level": st.L1_HOST_RAM}

    status.mark_awake()
    assert status.sleep_status() == {"isSleeping": False}


def test_capabilities_mlserver():
    caps = st.capabilities("1.6.1")
    assert caps["runnerType"] == "mlserver"
    assert caps["engineName"] == "MLServer"
    assert caps["engineVersion"] == "1.6.1"
    assert caps["supportedModelTypes"] == ["PREDICTIVE", "LLM", "EMBEDDING"]
    assert caps["supportedSleepLevels"] == [st.L1_HOST_RAM]
    assert caps["kvCacheElasticSharing"] is False


def test_sleep_and_wake_response_shapes():
    sr = st.sleep_response(st.L1_HOST_RAM, device_memory_freed_bytes=123)
    assert sr == {"state": st.SLEEPING, "level": st.L1_HOST_RAM, "deviceMemoryFreedBytes": 123}
    assert st.wake_response() == {"state": st.READY}


def test_health_omits_active_requests_when_none():
    status = st.RunnerStatus()
    health = status.health(active_requests=None)
    assert "activeRequests" not in health


def test_health_error_state_carries_message():
    status = st.RunnerStatus()
    status.mark_error("boom")
    health = status.health()
    assert health["state"] == st.ERROR
    assert health["message"] == "boom"


def test_repository_paths():
    assert st.repository_unload_path("org/m") == "/v2/repository/models/org/m/unload"
    assert st.repository_load_path("org/m") == "/v2/repository/models/org/m/load"
    assert st.model_ready_path("m") == "/v2/models/m/ready"
    assert st.health_ready_path() == "/v2/health/ready"


# --- memory.py (fake torch) -----------------------------------------------------------------------


def test_memory_report_remaps_device_indices_from_env(monkeypatch: pytest.MonkeyPatch):
    _install_fake_torch(monkeypatch, device_count=2)
    monkeypatch.setenv("SARDEENZ_DEVICE_INDICES", "3,7")
    report = mem.memory_report()
    assert [d["deviceIndex"] for d in report["devices"]] == [3, 7]


def test_memory_report_falls_back_to_local_index_without_env(monkeypatch: pytest.MonkeyPatch):
    _install_fake_torch(monkeypatch, device_count=2)
    monkeypatch.delenv("SARDEENZ_DEVICE_INDICES", raising=False)
    report = mem.memory_report()
    assert [d["deviceIndex"] for d in report["devices"]] == [0, 1]


def test_memory_report_empty_without_cuda(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delitem(sys.modules, "torch", raising=False)
    report = mem.memory_report()
    assert report["devices"] == []
