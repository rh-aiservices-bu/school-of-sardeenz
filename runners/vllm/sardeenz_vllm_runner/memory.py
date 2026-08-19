"""Best-effort device memory reporting for the vLLM runner shim.

Precise per-runner attribution is impossible under kvcached co-tenancy (two runners share a
device's pool elastically). We report this process's reserved CUDA memory as the used figure and
the device's total capacity — enough for the control plane's utilization view. When CUDA/torch is
unavailable (e.g. a CPU-only worker) this returns an empty ``devices`` list; the caller
(``app.py``) treats that as "no device memory to report" and answers 409 rather than emitting a
``MemoryReport`` with an empty ``devices`` array, which the contract forbids (``minItems: 1``).
"""

from __future__ import annotations

from typing import Any


def memory_report(device_type: str = "CUDA") -> dict[str, Any]:
    devices = _cuda_devices(device_type)
    return {"devices": devices}


def _cuda_devices(device_type: str) -> list[dict[str, Any]]:
    try:
        import torch  # type: ignore
    except Exception:
        return []

    if not torch.cuda.is_available():
        return []

    devices: list[dict[str, Any]] = []
    for index in range(torch.cuda.device_count()):
        try:
            free_bytes, total_bytes = torch.cuda.mem_get_info(index)
            reserved = int(torch.cuda.memory_reserved(index))
            # Prefer this process's reserved pool; fall back to whole-device usage if reserved is 0.
            used = reserved if reserved > 0 else int(total_bytes - free_bytes)
            devices.append(
                {
                    "deviceIndex": index,
                    "deviceType": device_type,
                    "memoryUsedBytes": max(0, used),
                    "memoryTotalBytes": int(total_bytes),
                }
            )
        except Exception:
            continue
    return devices
