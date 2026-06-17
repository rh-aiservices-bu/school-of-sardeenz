# ADR-014: Inference Recency Tracking for LRU Eviction

## Status

Accepted

## Context

The eviction engine sorts candidates by `lastInferenceAt` to implement LRU (least recently used) ordering. However, the control plane does not sit in the inference hot path — the proxy handles requests directly and forwards them to runners. As a result, `lastInferenceAt` is never populated and LRU ordering is effectively random.

Three options were considered for getting the recency signal into the control plane:

1. **Proxy periodic batch push.** The proxy accumulates last-request timestamps in memory and pushes them to Redis on an interval. Adds state to the "stateless" proxy; timestamps lost on proxy restart.
2. **Runner health endpoint.** The runner reports last-request time in its health response. The control plane only polls runner health during deploys, not continuously — the signal would be too stale for meaningful LRU.
3. **Redis key per request.** The proxy writes a timestamp key per model on each inference request. Simple, real-time, keeps the proxy stateless.

## Decision

**Option 3 — Redis key per request with local debounce.**

The proxy writes a Redis key for each model it routes a request to:

```
SET {prefix}:inference:last:{modelName} <ISO-8601 timestamp>
```

To minimize Redis write overhead, the proxy applies a **local debounce** (~5 seconds per model): if the last write for a model was less than 5 seconds ago, the write is skipped. Since GPU inference requests typically take hundreds of milliseconds to seconds each, the debounce rarely fires and the overhead is negligible. The debounce cache is purely an optimization — no durable state, no recovery needed.

The control plane reads these keys in a Redis pipeline when building eviction candidates, merging the timestamps into the model states before scoring.

### Key format

| Key                                   | Value                     | Written by                                   | Read by                                           |
| ------------------------------------- | ------------------------- | -------------------------------------------- | ------------------------------------------------- |
| `{prefix}:inference:last:{modelName}` | ISO-8601 timestamp string | Proxy (on each inference request, debounced) | Control plane (during eviction candidate scoring) |

The key prefix matches the existing `SARDEENZ_REDIS_KEY_PREFIX` configuration, consistent with all other Redis keys in the system (ADR-009).

### Why not update the model state blob?

The model state JSON blob in Redis (`{prefix}:models:{modelName}`) is managed exclusively by the control plane via atomic Lua CAS scripts. Having the proxy write directly into it would break the single-writer guarantee and risk corrupting the state machine. A separate, simple key avoids this entirely.

## Consequences

- **LRU eviction becomes meaningful.** Models that haven't served inference in the longest time are evicted first, rather than random selection.
- **Proxy change required.** The proxy needs a small addition: write the timestamp key on each routed request with local debounce. This is a Phase 1 (proxy) follow-up task.
- **Staleness window.** The recency signal is at most ~5 seconds stale (debounce interval). For eviction decisions on a minutes-to-hours timescale, this is negligible.
- **No cleanup burden.** Inference timestamp keys for deleted models are harmless — they are simple strings with no TTL. They can be cleaned up opportunistically during model deletion, but orphaned keys waste only a few bytes each.
