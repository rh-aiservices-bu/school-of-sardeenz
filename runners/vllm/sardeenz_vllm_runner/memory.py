"""Best-effort device memory reporting for the vLLM runner shim.

Precise per-runner attribution is impossible under kvcached co-tenancy (two runners share a
device's pool elastically). We report this process's reserved CUDA memory as the used figure and
the device's total capacity — enough for the control plane's utilization view. When CUDA/torch is
unavailable (e.g. a CPU-only worker) this returns an empty ``devices`` list; the caller
(``app.py``) treats that as "no device memory to report" and answers 409 rather than emitting a
``MemoryReport`` with an empty ``devices`` array, which the contract forbids (``minItems: 1``).
"""

from __future__ import annotations

import os
from typing import Any

from . import kvcached_pools


def memory_report(device_type: str = "CUDA") -> dict[str, Any]:
    devices = _cuda_devices(device_type)
    # kvcached pool stats are per-device telemetry only; a read failure (or no
    # kvcached at all) just means the kvCache field is absent — never a zero.
    pools = _kvcached_pools()
    for device in devices:
        stats = pools.get(device["deviceIndex"])
        if stats is not None:
            device["kvCache"] = stats
    return {"devices": devices}


def _kvcached_pools() -> dict[int, dict[str, Any]]:
    device_indices = _resolve_device_indices()
    if device_indices is None:
        return {}
    try:
        return kvcached_pools.read_kvcached_pools(device_indices)
    except Exception:
        return {}


def _resolve_device_indices() -> list[int] | None:
    """Map container-local CUDA device slots to cluster-global GPU indices.

    The worker agent sets ``SARDEENZ_DEVICE_INDICES`` (parallel to ``CUDA_VISIBLE_DEVICES``) to the
    control-plane-assigned indices for this runner's devices; without it (e.g. a bare `vllm serve`
    outside the worker) we fall back to the container-local index.
    """
    raw = os.environ.get("SARDEENZ_DEVICE_INDICES", "").strip()
    if not raw:
        return None
    try:
        return [int(part) for part in raw.split(",")]
    except ValueError:
        return None


def _cuda_devices(device_type: str) -> list[dict[str, Any]]:
    try:
        import torch  # type: ignore
    except Exception:
        return []

    if not torch.cuda.is_available():
        return []

    device_indices = _resolve_device_indices()

    devices: list[dict[str, Any]] = []
    for index in range(torch.cuda.device_count()):
        try:
            free_bytes, total_bytes = torch.cuda.mem_get_info(index)
            reserved = int(torch.cuda.memory_reserved(index))
            # Prefer this process's reserved pool; fall back to whole-device usage if reserved is 0.
            used = reserved if reserved > 0 else int(total_bytes - free_bytes)
            reported_index = (
                device_indices[index]
                if device_indices is not None and index < len(device_indices)
                else index
            )
            devices.append(
                {
                    "deviceIndex": reported_index,
                    "deviceType": device_type,
                    "memoryUsedBytes": max(0, used),
                    "memoryTotalBytes": int(total_bytes),
                }
            )
        except Exception:
            continue
    return devices
