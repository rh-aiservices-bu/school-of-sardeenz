"""Pure-logic tests for the vLLM runner shim — no vLLM/torch/FastAPI required.

Run in-SIF (or any env with pytest) via `pytest` from runners/vllm/. These cover contract-shape
correctness and CLI/command construction; the engine + HTTP layers are exercised by the cluster
integration gates (Phase 4 Task 9).
"""

from __future__ import annotations

import struct
import sys
import types
from pathlib import Path

import pytest

from sardeenz_vllm_runner import kvcached_pools as kp
from sardeenz_vllm_runner import memory as mem
from sardeenz_vllm_runner import state as st
from sardeenz_vllm_runner.cli import build_vllm_command, parse_args


def _install_fake_torch(monkeypatch: pytest.MonkeyPatch, device_count: int = 2) -> None:
    """Inject a fake `torch` module — torch isn't installed outside the runner-vllm image."""
    fake_torch = types.ModuleType("torch")
    fake_torch.cuda = types.SimpleNamespace(  # type: ignore[attr-defined]
        is_available=lambda: True,
        device_count=lambda: device_count,
        mem_get_info=lambda index: (1_000, 10_000),
        memory_reserved=lambda index: 2_000,
    )
    monkeypatch.setitem(sys.modules, "torch", fake_torch)


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


def test_build_vllm_command_forwards_served_model_name_after_double_dash():
    # The worker passes the routing name through the `--` passthrough (see ApptainerLauncher), so the
    # in-SIF shim needs no dedicated flag — it forwards it verbatim to `vllm serve`.
    args = parse_args(
        ["--model", "/w/m", "--port", "9101", "--", "--served-model-name", "org/Llama-3"]
    )
    cmd = build_vllm_command(args)
    assert cmd[cmd.index("--served-model-name") + 1] == "org/Llama-3"


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
    assert caps["kvCacheElasticSharing"] is True


def test_capabilities_flag_off_when_kvcached_disabled():
    caps = st.capabilities("0.21.0", kvcached_enabled=False)
    assert caps["kvCacheElasticSharing"] is False


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


def test_health_omits_active_requests_when_none():
    status = st.RunnerStatus()
    health = status.health(active_requests=None)
    assert "activeRequests" not in health


def test_health_includes_active_requests_when_present():
    status = st.RunnerStatus()
    health = status.health(active_requests=5)
    assert health["activeRequests"] == 5


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


# ---------------------------------------------------------------------------
# kvcached pool stats (issue #165)
# ---------------------------------------------------------------------------


def _write_segment(dir_path: Path, name: str, total: int, used: int, prealloc: int) -> None:
    (dir_path / name).write_bytes(struct.pack("<qqq", total, used, prealloc))


def test_kvcached_ipc_name_sorts_and_dedups_devices():
    assert kp.build_kvcached_ipc_name([3]) == "kvcached_vllm_GPU3"
    assert kp.build_kvcached_ipc_name([1, 0]) == "kvcached_vllm_GPU0_GPU1"
    assert kp.build_kvcached_ipc_name([2, 2, 1]) == "kvcached_vllm_GPU1_GPU2"


def test_kvcached_ipc_name_for_env():
    assert kp.kvcached_ipc_name_for_env("3") == "kvcached_vllm_GPU3"
    assert kp.kvcached_ipc_name_for_env("1,0") == "kvcached_vllm_GPU0_GPU1"
    assert kp.kvcached_ipc_name_for_env("") is None
    assert kp.kvcached_ipc_name_for_env(None) is None
    assert kp.kvcached_ipc_name_for_env("bogus") is None
    assert kp.kvcached_ipc_name_for_env(",,") is None


def test_read_kvcached_pools_reads_own_segment(tmp_path, monkeypatch: pytest.MonkeyPatch):
    _write_segment(tmp_path, "kvcached_vllm_GPU3", 1_000_000, 400_000, 100_000)
    monkeypatch.setattr(kp, "SHM_DIR", str(tmp_path))
    pools = kp.read_kvcached_pools([3])
    assert pools == {
        3: {
            "totalBytes": 1_000_000,
            "usedBytes": 400_000,
            "preallocBytes": 100_000,
            "freeBytes": 500_000,
        }
    }


def test_read_kvcached_pools_ignores_foreign_segments(tmp_path, monkeypatch: pytest.MonkeyPatch):
    _write_segment(tmp_path, "kvcached_vllm_GPU3", 1_000_000, 400_000, 100_000)
    # A pool on a device this runner does not own: ignored.
    _write_segment(tmp_path, "kvcached_vllm_GPU7", 999, 1, 1)
    # A non-pool file of the right size but wrong name shape: ignored.
    _write_segment(tmp_path, "unrelated", 5, 0, 0)
    # A pool segment with zero total (not yet initialized): ignored.
    _write_segment(tmp_path, "kvcached_vllm_GPU3_g1", 0, 0, 0)
    monkeypatch.setattr(kp, "SHM_DIR", str(tmp_path))
    # Only the device-3 pool is reported — and the zero-total _g1 twin is excluded
    # from it, so the numbers are the single initialized pool's.
    assert kp.read_kvcached_pools([3]) == {
        3: {"totalBytes": 1_000_000, "usedBytes": 400_000, "preallocBytes": 100_000, "freeBytes": 500_000}
    }
    # A runner on device 7 sees only the device-7 pool.
    assert kp.read_kvcached_pools([7]) == {
        7: {"totalBytes": 999, "usedBytes": 1, "preallocBytes": 1, "freeBytes": 997}
    }
    assert kp.read_kvcached_pools([]) == {}


def test_read_kvcached_pools_skips_wrong_size_and_zero_total(
    tmp_path, monkeypatch: pytest.MonkeyPatch
):
    (tmp_path / "kvcached_vllm_GPU0").write_bytes(b"short")
    monkeypatch.setattr(kp, "SHM_DIR", str(tmp_path))
    assert kp.read_kvcached_pools([0]) == {}


def test_read_kvcached_pools_missing_shm_dir_is_empty(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(kp, "SHM_DIR", "/nonexistent/shm/dir")
    assert kp.read_kvcached_pools([0]) == {}


def test_read_kvcached_pools_missing_segment_is_absent_not_zero(
    tmp_path, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setattr(kp, "SHM_DIR", str(tmp_path))
    assert kp.read_kvcached_pools([0]) == {}


def test_read_kvcached_pools_sums_multiple_groups_on_one_device(
    tmp_path, monkeypatch: pytest.MonkeyPatch
):
    # Two pools on the same GPU (e.g. hybrid attention groups _g1/_g2): per-device
    # figure is their sum.
    _write_segment(tmp_path, "kvcached_vllm_GPU0", 1_000, 300, 100)
    _write_segment(tmp_path, "kvcached_vllm_GPU0_g1", 2_000, 500, 200)
    monkeypatch.setattr(kp, "SHM_DIR", str(tmp_path))
    assert kp.read_kvcached_pools([0]) == {
        0: {"totalBytes": 3_000, "usedBytes": 800, "preallocBytes": 300, "freeBytes": 1_900}
    }


def test_read_kvcached_pools_tp_segment_counts_per_rank_not_split(
    tmp_path, monkeypatch: pytest.MonkeyPatch
):
    # A tensor-parallel segment is written by every rank; each rank's allocator
    # tracks its own device's pages, so each owned device carries the full value.
    _write_segment(tmp_path, "kvcached_vllm_GPU0_GPU1", 1_000, 400, 100)
    monkeypatch.setattr(kp, "SHM_DIR", str(tmp_path))
    pools = kp.read_kvcached_pools([0, 1])
    assert pools[0] == {"totalBytes": 1_000, "usedBytes": 400, "preallocBytes": 100, "freeBytes": 500}
    assert pools[1] == pools[0]


def test_memory_report_attaches_kvcache_block(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    _install_fake_torch(monkeypatch, device_count=2)
    monkeypatch.setenv("SARDEENZ_DEVICE_INDICES", "3,7")
    _write_segment(tmp_path, "kvcached_vllm_GPU3", 8, 3, 2)
    monkeypatch.setattr(kp, "SHM_DIR", str(tmp_path))
    report = mem.memory_report()
    by_index = {d["deviceIndex"]: d for d in report["devices"]}
    assert by_index[3]["kvCache"] == {
        "totalBytes": 8,
        "usedBytes": 3,
        "preallocBytes": 2,
        "freeBytes": 3,
    }
    # Device without a pool keeps no kvCache key — absent, not zero.
    assert "kvCache" not in by_index[7]


def test_memory_report_no_kvcache_without_device_indices(monkeypatch: pytest.MonkeyPatch, tmp_path):
    _install_fake_torch(monkeypatch, device_count=1)
    monkeypatch.delenv("SARDEENZ_DEVICE_INDICES", raising=False)
    _write_segment(tmp_path, "kvcached_vllm_GPU0", 8, 3, 2)
    monkeypatch.setattr(kp, "SHM_DIR", str(tmp_path))
    report = mem.memory_report()
    assert "kvCache" not in report["devices"][0]
