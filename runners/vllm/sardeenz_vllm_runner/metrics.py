"""Pure Prometheus text-exposition parsing for the runner shim.

No torch, no vLLM, no httpx — matches the pure-logic test-suite convention
(runners/vllm/tests/test_core.py) so the parser is testable in any env with pytest.
"""

from __future__ import annotations

import math


def sum_metric(text: str, name: str) -> float | None:
    """Sum all samples of one Prometheus text-exposition metric.

    Skips `#` comment lines; accepts lines whose first whitespace token is exactly
    `name` or starts with `name{` (never `name_*` — histogram/counter suffixes like
    `_bucket`/`_count`/`_sum` are distinct metrics). The value is the last
    whitespace-separated field, parsed as float (vLLM emits float strings like
    `8.0`; label values containing spaces keep the value last). Unparseable values
    make the whole call None. Returns None when the metric is absent, or when any
    matched sample is non-finite (NaN/±Inf) — unknown, never a fabricated number.
    """
    total = 0.0
    matched = False
    for line in text.splitlines():
        if line.startswith("#"):
            continue
        fields = line.split()
        if not fields:
            continue
        if fields[0] != name and not fields[0].startswith(name + "{"):
            continue
        matched = True
        try:
            value = float(fields[-1])
        except ValueError:
            return None
        if not math.isfinite(value):
            return None
        total += value
    return total if matched else None
