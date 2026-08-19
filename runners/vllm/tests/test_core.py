"""Pure-logic tests for the vLLM runner shim — no vLLM/torch/FastAPI required.

Run in-SIF (or any env with pytest) via `pytest` from runners/vllm/. These cover contract-shape
correctness and CLI/command construction; the engine + HTTP layers are exercised by the cluster
integration gates (Phase 4 Task 9).
"""

from __future__ import annotations

import pytest

from sardeenz_vllm_runner import state as st
from sardeenz_vllm_runner.cli import build_vllm_command, parse_args


def test_parse_args_defaults_engine_port_to_port_plus_one():
    args = parse_args(["--model", "/weights/llama", "--port", "9101"])
    assert args.model == "/weights/llama"
    assert args.port == 9101
    assert args.engine_port == 9102


def test_parse_args_forwards_engine_args_after_double_dash():
    args = parse_args(
        ["--model", "/w/m", "--port", "9101", "--", "--max-model-len", "8192", "--dtype", "bfloat16"]
    )
    assert args.engine_args == ["--max-model-len", "8192", "--dtype", "bfloat16"]


def test_parse_args_rejects_equal_ports():
    with pytest.raises(ValueError):
        parse_args(["--model", "/w/m", "--port", "9101", "--engine-port", "9101"])


def test_build_vllm_command_enables_sleep_mode_and_binds_internal_port():
    args = parse_args(["--model", "/w/m", "--port", "9101", "--engine-port", "9200"])
    cmd = build_vllm_command(args)
    assert cmd[:3] == ["vllm", "serve", "/w/m"]
    assert "--enable-sleep-mode" in cmd
    assert cmd[cmd.index("--port") + 1] == "9200"
    assert cmd[cmd.index("--host") + 1] == "127.0.0.1"


def test_build_vllm_command_adds_tensor_parallel_and_forwarded_args():
    args = parse_args(
        ["--model", "/w/m", "--port", "9101", "--tensor-parallel", "2", "--", "--quantization", "fp8"]
    )
    cmd = build_vllm_command(args)
    assert cmd[cmd.index("--tensor-parallel-size") + 1] == "2"
    assert cmd[-2:] == ["--quantization", "fp8"]


def test_vllm_sleep_level_maps_l1():
    assert st.vllm_sleep_level(st.L1_HOST_RAM) == 1


def test_vllm_sleep_level_rejects_unknown():
    with pytest.raises(ValueError):
        st.vllm_sleep_level("L2_DISK")


def test_capabilities_declares_kvcache_elastic_sharing():
    caps = st.capabilities("0.21.0", kvcached_enabled=True)
    assert caps["runnerType"] == "vllm"
    assert caps["engineName"] == "vLLM"
    assert caps["engineVersion"] == "0.21.0"
    assert caps["supportedModelTypes"] == ["LLM"]
    assert caps["supportedSleepLevels"] == [st.L1_HOST_RAM]
    assert caps["features"]["kvCacheElasticSharing"] is True


def test_capabilities_flag_off_when_kvcached_disabled():
    caps = st.capabilities("0.21.0", kvcached_enabled=False)
    assert caps["features"]["kvCacheElasticSharing"] is False


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


def test_sleep_and_wake_response_shapes():
    sr = st.sleep_response(st.L1_HOST_RAM, device_memory_freed_bytes=123)
    assert sr == {"state": st.SLEEPING, "level": st.L1_HOST_RAM, "deviceMemoryFreedBytes": 123}
    assert st.wake_response() == {"state": st.READY}


def test_health_error_state_carries_message():
    status = st.RunnerStatus()
    status.mark_error("boom")
    health = status.health()
    assert health["state"] == st.ERROR
    assert health["message"] == "boom"
