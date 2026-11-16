# ADR-029: Co-location Keeps Sleep's Hold, and Pressure Evicts by Stopping — Never Sleeping

## Status

Accepted. Implemented in Phase 5 on M19
([#276](https://github.com/rh-aiservices-bu/school-of-sardeenz/issues/276) and
[#277](https://github.com/rh-aiservices-bu/school-of-sardeenz/issues/277), merged `06ff80a`).
Extends [ADR-011](adr-011-worker-capabilities-and-placement.md) (worker capabilities and
placement: the elastic oversubscription branch amends its capacity filtering) and
[ADR-014](adr-014-inference-recency-tracking.md) (recency-driven eviction: pool pressure is the
system's first non-demand eviction trigger); records semantics adjacent to
[ADR-028](adr-028-drain-signal-semantics.md) (drain-signal two-valuedness — the pressure stop
deliberately bypasses the drain loop, see Decision 4). Two earlier phases constrain the shape:
Phase 4 proved kvcached elastic sharing on one device (spike Gate 9d,
[`phase4-apptainer-spike.md`](../../project/phase4-apptainer-spike.md)) and Phase 4's deferred
OOM guard is what #276's fail-closed capability guard delivers.

## Context

Phase 5 turned Phase 4's spike result — two vLLM runners sharing one GPU via kvcached elastic
KV-cache sharing — into a control-plane placement policy. Three coupled questions had to be
answered together, and answering any one of them in isolation produces a wrong system:

1. **What does sleep mean on a co-located device?** Sleep's contract (ADR-014's LRU eviction,
   the wake path) has always been "weights leave, the reservation hold stays". Under
   co-location that contract becomes load-bearing in a new way: a sleeping instance is still a
   memory resident. If sleep released its hold, a wake would re-acquire bytes the device may
   have promised to a co-tenant — and the wake pre-check would re-open the phantom-shortfall
   class the per-device rewrite exists to kill.
2. **How much oversubscription may an elastic device carry?** The kvcached pool reports
   `freeBytes`/`preallocBytes` — virtual capacity, not backed physical bytes. Without a cap,
   the elastic branch could promise unbounded headroom on every co-located pool.
3. **What does the system do when a shared pool is nonetheless driven to pressure?** The
   reconciliation tick now evaluates per-device pool pressure
   (`SARDEENZ_POOL_PRESSURE_*`, off by default). Eviction is the response — but eviction's
   default gentle action is sleep, and sleeping is precisely the wrong tool against pressure.

## Decision

1. **Sleep keeps its hold; a sleeping instance is a full member of its device's co-location
   group.** `coLocationGroup` (in `placement.ts`) is the single derivation of "who shares this
   device" — sleeping instances are members, their bytes stay in the device ledger. A sleeping
   co-tenant therefore blocks a non-elastic newcomer via the fail-closed capability guard, and
   wake-eviction may select it as a victim like any other member.
2. **The wake pre-check is per-device and excludes the waker's own hold.** Sleep never
   released the hold, so the pre-Phase-5 worker-wide sum re-counted the waking instance's
   still-held bytes and produced a phantom shortfall — evicting innocents to "free" memory the
   waker itself held. Victims are drawn from the waker's device group, sized per device
   (`requiredMemory / tensorParallel`), and bounded by
   `SARDEENZ_EVICTION_MAX_PER_CYCLE`; legacy instances without `deviceIndices` keep the
   worker-wide fallback.
3. **Oversubscription is bounded by a cap on the device's KV-pool total, not by absolute
   bytes.** Headroom is
   `min(min(freeBytes + preallocBytes, poolTotalBytes), cap% × poolTotalBytes)` with the cap
   set by `SARDEENZ_COLOCATION_MAX_POOL_HEADROOM_PERCENT` (integer percent 0–100, default
   **50**; `0` disables elastic headroom), boot-validated fail-loudly (the
   `SARDEENZ_SIF_IMPORTER` posture) and clamped at consumption. A percent-of-pool cap
   (not an absolute-bytes cap) is the only form that stays safe across a heterogeneous fleet —
   an 80 GB A100 and a 24 GB L4 must not share one knob's byte constant. Placement that cannot
   resolve a co-resident's capability — or finds any unknown-placement resident (null/empty
   `deviceIndices`, including an ERROR instance that retains its hold) — fails closed: zero
   headroom. An accepted residual: `freeBytes` is unbacked virtual capacity, so the formula can
   count the same capacity on behalf of more than one co-located pool; the cap bounds the
   _policy_ overcommit, and the Gate 9b NVML reality check (actual device usage under
   concurrent inference stays within physical capacity,
   [`phase5.md`](../../project/phase5.md) §Gate 9b step 7) is the acceptance evidence that
   decides whether a physical-usage clamp must replace the telemetry-only formula. Until that
   evidence exists, no code change is warranted.
4. **Pressure victims are STOPPED, never slept, and the stop is deliberately drain-free.** When
   the pool-pressure evaluator fires (usage-ratio threshold held for N consecutive ticks,
   `SARDEENZ_POOL_PRESSURE_{ENABLED,THRESHOLD_PERCENT,RELEASE_TARGET_PERCENT,DEBOUNCE_TICKS}`,
   `RELEASE_TARGET < THRESHOLD` enforced at boot against effective values), the response runs
   the existing `EvictionEngine` scoped to the pressure device's co-location group — but the
   victim action is the deterministic `stopModel` teardown with a best-effort `stopRunner` reap,
   not sleep. Two reasons, one mechanical, one causal:
   - _Sleeping cannot relieve pressure._ A slept instance keeps its VRAM hold; sleeping the
     very instances that pressure the pool frees nothing. Stop is the only action that
     releases holds.
   - _Draining waits on the cause._ A pool is pressured by in-flight traffic; waiting for the
     drain signal is waiting on the very load that must recede before relief cuts in, so the
     pressure path calls `stopModel` via the null runner client and skips `waitForDrain` on
     purpose. The shim-side stop still delivers the runner's SIGTERM grace; the control plane
     accepts cutting in-flight requests under pressure (danger notification per victim, one
     `EVICTION_TRIGGERED` cluster event each).
     This is a deliberate, documented exception to the M10/M17 posture that stop paths drain
     ([ADR-028](adr-028-drain-signal-semantics.md)'s drain-loop semantics are untouched — no
     drain signal is read on this path, and operator-initiated stops still drain). Sizing stays
     by configured `requiredMemory` — the overshoot for a pool-sized problem is accepted over
     any pool-telemetry-derived precision. A failed non-404 reap reclassifies the stranded
     STOPPED record to observable ERROR rather than leaving it invisible.
5. **The pressure trigger is the system's first non-demand eviction trigger, and it ships
   disabled.** Every prior eviction was demand-driven (deploy-fail, wake-shortfall); pressure
   adds a self-initiated path and therefore ships off
   (`SARDEENZ_POOL_PRESSURE_ENABLED=false`) — an upgrade changes no behavior until an operator
   enables it.

## Consequences

- **Trap for a future engineer:** "make wake eviction kinder" or "make pressure eviction
  kinder" both look like robustness improvements. Sleeping a victim re-introduces the
  phantom-shortfall class (wake pre-checks would count holds that were never released) in the
  first case, and relieves no pressure in the second — both are rejected here so the next
  reviewer has a citation.
- **The sleeps-don't-relieve-pressure invariant is now written down.** Any future
  "sleep-as-gentle-eviction" feature must either find a different trigger or amend this ADR.
- **`coLocationGroup` is a contract, not a helper.** Any new consumer of "who shares this
  device" must import it, never re-derive; #277's pressure path is the precedent, and a second
  derivation is the kind of drift that lets sleeping members silently drop out of one
  consumer's view.
- **The pressure path trades request-cutting candor for determinism.** In-flight requests on a
  pressure victim are cut (drain-free stop), and that is recorded behavior with a danger
  notification — not an edge case to be papered over later.
- **The freeBytes residual is a gate, not a bug ticket.** ADR-level acceptance of the
  telemetry-only headroom formula is conditional on the Gate 9b NVML measurement; if it fails,
  the fix replaces the formula (physical-usage clamp or NVML-based headroom source), not the
  cap.

## Non-goals

- Sleep-based pressure relief in any form (sleep keeps holds — see Decision 1).
- Per-model attribution inside the kvcached pool (ADR-027 non-goal, unchanged).
- Changing operator-initiated stop semantics (drain posture per ADR-028 is unchanged).
- Enabling pool pressure by default; the operator decides when a shared pool may be relieved
  by eviction.
