# ADR-028: The Drain Signal Is Two-Valued — Unknown Never Means Drained, and the 409-in-Window ERROR Is Deliberate

## Status

Accepted. Implemented in M17 ([#239](https://github.com/rh-aiservices-bu/school-of-sardeenz/issues/239),
merged `337e0ae`); the drain-loop semantics it records were shaped by #166 (consecutive-poll
fast-fail) and #206 (MLServer drain stall). Extends [ADR-010](adr-010-engine-runners.md)
(runner contract: sleep/wake and health checking); the per-shim scrape mechanics are specified in
[`components/runner-contract.md`](../components/runner-contract.md).

## Context

Sleeping a runner safely requires knowing that no request is in flight. The runner contract's
drain signal is the `activeRequests` field on `GET /health`, which each shim derives by scraping
the engine's Prometheus metrics (vLLM: `vllm:num_requests_running` + `num_requests_waiting`,
summed across label series; MLServer: `rest_server_requests_in_progress`). A scrape can fail in
several ways — HTTP error, 200 body whose metric names no longer parse, non-finite samples — and
the control plane must decide what each means for the drain.

Two historical bugs shaped the semantics: #239, where the vLLM scrape never matched labeled
metric lines and reported a fabricated `0` — making every sleep look drained and offloading
weights out from under in-flight generations; and #206, where a drain stall shipped before the
consequences of treating a stall as drainable were understood. The obvious-looking "fixes" for
each are regressions in disguise: defaulting an unreadable scrape to `0`, retrying a refused
sleep from the control plane, or treating a 200-but-unparsed body as drained.

## Decision

1. **The drain signal is two-valued: a count, or unknown.** A missing, unparseable, or
   non-finite `activeRequests` means *unknown* — never `0`. Only a successful scrape with both
   expected metrics present yields a count (vLLM requires both `running` and `waiting`; a
   half-parsed scrape is unknown).
2. **Fail-open on unknown, at both ends.** The shim's `POST /sleep` guard is skipped when the
   scrape is unknown — a metrics outage must not make sleep impossible (a wedged metrics
   endpoint would otherwise wedge sleep permanently, and sleep is the recovery path). The
   control plane's drain loop keeps polling on unknown — unknown never satisfies the drain
   condition.
3. **A 200-but-unparsed scrape behaves like a failed scrape, and that consequence is accepted.**
   `/health` omits `activeRequests`, the drain waits out `sleepTimeoutMs`, and the sleep ends in
   `504 RUNNER_TIMEOUT` → instance ERROR. Silence would be worse: pre-#239, the same condition
   reported a fake `0` and slept through active generations. A live capture of real vLLM
   `/metrics` text on first post-merge deployment is the release gate for the parser's
   assumptions.
4. **A request that starts inside the drain→sleep window turns the sleep into `409 NOT_READY` →
   instance ERROR — by design.** The control plane polls `activeRequests === 0`, then calls
   `/sleep` before removing the endpoint; a request routed in that gap hits the shim's guard.
   The rejected alternative — a control-plane-side drain retry after 409 — re-introduces the
   race the guard closes (the drain condition was observed true; retrying does not make it
   stickier) and multiplies the failure surface. Loud, user-visible ERROR beats silently
   destroying a generation.
5. **Consecutive-poll fast-fail (#166) is part of the same contract.** Three consecutive failed
   health polls abort the drain with `RUNNER_UNAVAILABLE` rather than waiting out the full
   timeout — a runner that is unreachable is not drained either.

## Consequences

- **Trap for a future engineer:** "unknown → treat as 0" or "unknown → treat as drained" both
  look like robustness improvements and both re-create #239 — the first directly, the second by
  sleeping through in-flight requests on a metrics outage. Equally, "add a drain retry after
  409" looks like resilience and re-opens the race. All three are rejected here so the next
  reviewer has a citation.
- **Sleep of a wedged runner has two ERROR exits** (drain timeout 504, fast-fail
  unavailable) plus the guard's 409 — all land the instance in ERROR, which is the intended
  loud-failure posture; the operator, not the control plane, decides to retry.
- **The shim-side guard and the control-plane drain are two independent nets.** The shim
  re-scrapes at sleep time (its own read may differ from the last polled count); neither side
  trusts a stale observation.
- **`deviceMemoryFreedBytes` semantics are separate** and not covered here (the control plane
  currently ignores it — see runner-contract.md's sleep/wake section).

## Non-goals

- Control-plane-side drain retries, and any change to the drain→sleep window's remove-endpoint
  ordering.
- vLLM sleep level 2 (`L2_DISCARD`) mapping — intentionally unmapped; only `L1_HOST_RAM` is
  contract-exposed.
- Making a metrics outage wake the engine's metrics exporter (operator concern, not a contract
  concern).
