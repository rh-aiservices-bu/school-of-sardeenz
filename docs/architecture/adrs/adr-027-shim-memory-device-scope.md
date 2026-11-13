# ADR-027: Shim Memory Figures Are Device-Scope Observations, Not Attributions

## Status

Accepted. Implemented in M17 ([#244](https://github.com/rh-aiservices-bu/school-of-sardeenz/issues/244),
merged `337e0ae`). Extends [ADR-010](adr-010-engine-runners.md) (runner contract: memory
reporting) and [ADR-011](adr-011-worker-capabilities-and-placement.md) (worker capabilities and
placement); leaves the measured-only doctrine (#163/#164) untouched.

## Context

Under co-location — the explicit goal of Phase 5 — several runners share one device, and "how
much memory is in use" has two distinct meanings: the whole device's usage (every process on the
GPU included) and one runner's own usage. The engine-runner contract's `DeviceMemoryUsage`
carried only `memoryUsedBytes`, so a consumer could not tell which figure it was reading. The
vLLM shim's `/memory-report` made this concrete: its `torch.cuda.memory_reserved()` branch was
dead by construction (the shim owns no CUDA pool — the engine is a child process), so the figure
silently degraded to a whole-device read and would double-count every co-located runner when
summed — the defect #116 was supposed to have fixed and #244 closed for the shims.

The worker's NVML path does not have this ambiguity: ts-nvml attributes per-GPU-process bytes to
the owning runner, so its `InstanceMemoryMeasurement` rows are genuinely per-runner. But the
contract gave no way to distinguish the two sources, and no consumer branched on any scope
notion — the double-count was silent until #244 made it declarable.

## Decision

1. **`DeviceMemoryUsage` gains an optional `attribution: runner | device` field** (engine-runner
   contract, additive; spec stays 0.1.1). `runner` means the reporting runner's own usage on the
   device (safe to sum across runners sharing a device); `device` means the whole device's used
   memory as observed by the reporting runner, co-located processes included. Absent means
   **unknown** — legacy images that do not declare a scope stay contract-valid, and consumers
   must treat unknown as neither.
2. **The shims always emit `"device"`.** A shim is a thin supervisor over a child engine process;
   it owns no CUDA pool, so any figure it can read is a whole-device observation
   (`mem_get_info`-derived `max(0, total − free)`). The in-repo runner stub emits `"runner"`
   (its number is `requiredMemory / devices.length` from its own ledger — genuinely per-runner).
   The conformance suite requires every current emitter to declare a scope.
3. **Only the worker's NVML sample is process-attributed.** The worker is the sole component with
   per-process visibility; its instance measurements are the authority for per-runner usage. A
   shim's whole-device figure is an _observation about the device_, never an attribution to the
   reporting runner.
4. **Consumers must branch on `attribution` before aggregating.** Device-scope figures MUST NOT
   be summed across runners sharing a device, and unknown-scope figures MUST NOT be summed as if
   per-runner. (No executable consumer enforced this rule at acceptance — see Consequences. The
   Phase 5 consumer-side rule,
   [#278](https://github.com/rh-aiservices-bu/school-of-sardeenz/issues/278), is the first.)
5. **The per-runner display rule is Phase 5's.** How the control plane and dashboard dedupe
   device-scope rows for per-model display and co-location accounting is a policy decision, not
   part of this contract change; it is deliberately deferred.

## Consequences

- **The double-count is now visible, not silent.** Under co-location on a no-NVML worker, two
  instances each carrying the same whole-device figure are distinguishable from two genuine
  per-runner deltas by reading `attribution`.
- **Traps for a future engineer.** Reading `memoryUsedBytes` as "this runner's usage" without
  checking `attribution` re-introduces the exact double-count #244 deleted — and until Phase 5
  landed the consumer-side rule
  ([#278](https://github.com/rh-aiservices-bu/school-of-sardeenz/issues/278)), the repo gave no
  executable guard; this ADR was the guard.
  Re-adding a "reserved" figure from the shim's own process is dead by construction in the
  two-process topology and must not return. Promoting a device-scope shim figure into a
  per-instance row (as the no-NVML `getLedgerInstanceShares` path can do with real shims) is the
  second known trap.
- **Contract surface stays additive.** No existing field changes meaning; `kvCache` pool stats
  (`KVCachePoolStats`) are unaffected — they are pool-internal figures and always device-scoped
  by nature.

## Non-goals

- Per-model attribution _inside_ the kvcached pool (which model owns which KV blocks) — Phase 5
  territory at the earliest; today's pool stats are per-device only.
- Changing the worker-agent contract's `InstanceMemoryMeasurement` shape — NVML rows are already
  per-runner and correct. _(Partially implemented by Phase 5,
  [#278](https://github.com/rh-aiservices-bu/school-of-sardeenz/issues/278): the contract gained
  an optional `attribution` field so a no-NVML ledger row can state its source scope; NVML rows
  themselves are unchanged.)_
