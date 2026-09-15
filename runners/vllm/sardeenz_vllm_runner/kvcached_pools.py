"""Read kvcached elastic KV-cache pool stats from the pool's shared-memory segment.

kvcached publishes each pool's state to a 24-byte POSIX shared-memory file in
``/dev/shm`` — ``[total_size, used_size, prealloc_size]`` as little-endian int64
(same struct ``kvtop`` displays, same file the C++ ``PageAllocator`` writes).
``total_size`` is the pool's reserved virtual capacity (set at pool init; it does
not change as the pool elastically resizes); ``used_size``/``prealloc_size`` are
the physical bytes currently pinned by in-use vs preallocated (reserved) pages.
``free`` is derived: ``max(0, total - used - prealloc)``.

Discovery mirrors ``kvcached.cli.kvtop``: enumerate ``SHM_DIR``, accept files whose
size is exactly the struct size and whose ``total_size > 0``, read them under a
shared ``flock``. Segment names carry the owning GPU indices in the
``kvcached_vllm_GPU<sorted indices>`` form the launcher pins via
``KVCACHED_IPC_NAME`` (see ``engine.build_kvcached_ipc_name``); a segment the
runner does not participate in is ignored — the runner only reports pools it is
part of. A multi-GPU (tensor-parallel) segment is split evenly across its GPUs.

Read-only, fail-soft like the torch path in ``memory.py``: no kvcached segments
visible, a read error, or an unreadable struct means "no pool stats" (empty
mapping) — never an exception, and absence is never reported as zero.
"""

from __future__ import annotations

import fcntl
import mmap
import os
import re
import struct
from typing import Any

#: Default location of kvcached's shared-memory segments. Overridable in tests
#: (monkeypatch); kvcached itself hardcodes /dev/shm.
SHM_DIR: str = "/dev/shm"

_MEM_INFO_STRUCT_SIZE = struct.calcsize("<qqq")  # 3 x int64 = 24 bytes

# v1-compatible pool segment naming (kvcached_vllm_GPU0 / kvcached_vllm_GPU0_GPU1).
# kvcached uses the name verbatim (only sanitizing characters), so the index group
# may appear in any order and the name may carry the suffixes kvcached appends for
# multiple pools in one process (`_g<id>`) or a name-collision retry (`_<n>`) —
# parse the `GPU<n>` tokens instead of string-matching.
_SEGMENT_NAME_RE = re.compile(
    r"kvcached_vllm_GPU\d+(?:_GPU\d+)*(?:(?:_g\d+)|_\d+)*$", re.IGNORECASE
)
_GPU_TOKEN_RE = re.compile(r"GPU(\d+)", re.IGNORECASE)


def build_kvcached_ipc_name(device_indices: list[int]) -> str:
    """Segment name for this runner's pool(s), per the v1 naming convention.

    Sorted so that co-located runners on the same device(s) derive the same name
    and therefore share one pool segment — which is what makes kvcached's elastic
    sharing work between Sardeenz runners.
    """
    return "kvcached_vllm_GPU" + "_GPU".join(str(i) for i in sorted(set(device_indices)))


def kvcached_ipc_name_for_env(raw_indices: str | None) -> str | None:
    """Pool segment name derived from SARDEENZ_DEVICE_INDICES, or None if unset/invalid."""
    if not raw_indices or not raw_indices.strip():
        return None
    try:
        indices = [int(part) for part in raw_indices.split(",") if part.strip()]
    except ValueError:
        return None
    if not indices:
        return None
    return build_kvcached_ipc_name(indices)


def _segment_gpu_indices(segment_name: str) -> list[int] | None:
    """GPU indices a segment name refers to, or None if it is not a per-GPU pool."""
    if not _SEGMENT_NAME_RE.fullmatch(segment_name):
        return None
    return [int(tok) for tok in _GPU_TOKEN_RE.findall(segment_name)]


def _read_segment(path: str) -> tuple[int, int, int] | None:
    """Read one segment under a shared lock; None if missing/unreadable/zero-total."""
    try:
        with open(path, "r+b") as f:
            fcntl.flock(f, fcntl.LOCK_SH)
            try:
                if f.seek(0, os.SEEK_END) != _MEM_INFO_STRUCT_SIZE:
                    return None
                f.seek(0)
                total, used, prealloc = struct.unpack("<qqq", f.read(_MEM_INFO_STRUCT_SIZE))
            finally:
                fcntl.flock(f, fcntl.LOCK_UN)
    except (FileNotFoundError, PermissionError, OSError, struct.error):
        return None
    if total <= 0:
        return None
    return (total, used, prealloc)


def _pool_stats(total: int, used: int, prealloc: int) -> dict[str, int]:
    return {
        "totalBytes": int(total),
        "usedBytes": max(0, int(used)),
        "preallocBytes": max(0, int(prealloc)),
        "freeBytes": max(0, int(total) - max(0, int(used)) - max(0, int(prealloc))),
    }


def read_kvcached_pools(device_indices: list[int]) -> dict[int, dict[str, Any]]:
    """Per-device kvcached pool stats for the devices this runner participates in.

    Returns ``{deviceIndex: kvCache block}`` (block shape: engine-runner contract
    ``KVCachePoolStats``). Empty mapping when no visible segment belongs to any of
    ``device_indices`` — the caller then omits the ``kvCache`` field.
    """
    if not device_indices:
        return {}
    owned = set(device_indices)
    per_device: dict[int, list[tuple[int, int, int]]] = {}

    try:
        names = os.listdir(SHM_DIR)
    except FileNotFoundError:
        return {}
    except OSError:
        return {}

    for name in names:
        indices = _segment_gpu_indices(name)
        if not indices:
            continue
        shared = owned & set(indices)
        if not shared:
            continue
        info = _read_segment(os.path.join(SHM_DIR, name))
        if info is None:
            continue
        # Tensor-parallel segments are written by every rank to the same file;
        # each rank's PageAllocator tracks its own device's pages, so the values
        # are per-rank — i.e. exactly the pool size on each device. No split.
        for device_index in shared:
            per_device.setdefault(device_index, []).append(info)

    return {
        device_index: _pool_stats(*(sum(part) for part in zip(*stats)))
        for device_index, stats in per_device.items()
    }
