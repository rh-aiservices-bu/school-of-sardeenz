# Routing proxy deployment

This Kustomize base deploys the stateless routing proxy and two cluster Services:

- `sardeenz-proxy:8080` carries inference traffic;
- `sardeenz-proxy-admin:9099` carries health, readiness, and Prometheus metrics and should remain
  cluster-internal.

The proxy reads the routing map from `sardeenz-redis` and sends wake requests to
`sardeenz-control-plane`. It consumes `SARDEENZ_API_TOKEN` from the shared
`sardeenz-service-tokens` Secret described in [`../README.md`](../README.md).

## High availability and graceful shutdown

The Deployment runs **two replicas** behind the inference Service, with a PodDisruptionBudget
(`minAvailable: 1`) registered by this kustomization. A node drain may evict one proxy pod at a
time and the survivor keeps serving: the proxy holds no cross-replica state (ADR-007), so replicas
share only what Redis already shares — the routing map, presence leases and propagation barriers.

Replicas spread across nodes **softly** (`topologySpreadConstraints`, `maxSkew: 1`,
`kubernetes.io/hostname`, `whenUnsatisfiable: ScheduleAnyway`): a multi-node cluster ends up with
one pod per node, while a single-node cluster still schedules both instead of leaving the second
one `Pending`. There is no `strategy:` override — the default RollingUpdate math with two replicas
is `maxSurge: 1` / `maxUnavailable: 0`, i.e. a readiness-gated, zero-downtime rollout: the new pod
must pass `/readyz` before the old one is removed.

**Per-process (per-replica) limits.** Every capacity limit the proxy enforces is per process,
never cluster-wide: parking (`SARDEENZ_PARKING_MAX_PER_MODEL`, `SARDEENZ_PARKING_MAX_GLOBAL`,
`SARDEENZ_PARKING_MAX_BYTES`), forwarding caps (`SARDEENZ_PROXY_MAX_CONCURRENT_FORWARDS`,
`SARDEENZ_PROXY_MAX_CONCURRENT_PER_MODEL`) and the buffered-body budget
(`SARDEENZ_PROXY_MAX_BUFFERED_BYTES`, see [Buffered-body budget](#buffered-body-budget)). With two
replicas each configured value buys that capacity **per replica**, so the effective aggregate
ceiling is the configured value × the replica count — e.g. 2 × 256 MiB of buffered bodies across
the Deployment — while a single request is still capped by the replica that receives it: the
Service load-balances, it does not aggregate.

**Shutdown sequence.** On pod deletion the kubelet first runs the `preStop` httpGet against
`sardeenz-proxy-admin:9099/drain`, which holds the response for 5 s so router and endpoint
propagation finish before the pod stops accepting (the image is distroless, so there is no shell and
no `sleep` for a classic `exec` hook). SIGTERM then flips `/readyz` to `503` — the pod drops out of
the Service's ready endpoints and `inference` handlers decline new work — and the servers stop
accepting while live connections finish, bounded by an in-process deadline:
`SARDEENZ_PARKING_TIMEOUT_SECS + SARDEENZ_PROXY_SHUTDOWN_DRAIN_SECS` (165 s at the defaults of
120 s + 45 s). Size the grace period against that:

`terminationGracePeriodSeconds` (180 s) ≥ preStop (5 s) + parking timeout (120 s) + drain margin
(45 s), with ~10 s of process-exit slack. Raise the three together when raising
`SARDEENZ_PARKING_TIMEOUT_SECS` — the in-process deadline is _derived_ from it
(`Config::shutdown_deadline`), so the manifest cannot silently fall behind the code, but the grace
period is a literal and can.

Because the deadline is parking timeout plus a margin, a request parked on a wake always resolves
first: it is either served or returns its ordinary parking `503`. Requests still streaming when the
deadline expires are **cut** — the process exits, the client sees a connection reset (not a JSON
error) — and a `WARN` naming the deadline and the parked count is logged first. Long SSE streams
that live past ~165 s therefore need a longer
`SARDEENZ_PROXY_SHUTDOWN_DRAIN_SECS` (and a matching grace period), or they will be cut on every
rollout and node drain.

## Request body limit

Both inference surfaces (`/openai/*` and `/oip/*`) buffer the whole request body before routing it.
`SARDEENZ_PROXY_MAX_BODY_BYTES` (default `33554432`, 32 MiB) caps that buffer; a larger body is
rejected before routing with the proxy's JSON error envelope — `413`, `type: "request_too_large"`, and
a message naming the configured limit and the variable.

The limit bounds one request, not total proxy memory — the aggregate of concurrently buffered
bodies within one replica is bounded separately by `SARDEENZ_PROXY_MAX_BUFFERED_BYTES` (see
[Buffered-body budget](#buffered-body-budget)), and the container memory limit in `deployment.yaml`
(`1Gi`) remains the hard ceiling. Keep the inference Service cluster-internal or behind an
authenticated gateway that enforces its own body cap, and lower `SARDEENZ_PROXY_MAX_BODY_BYTES`
where that exposure is unacceptable; raise the memory limit only after accounting for concurrency.
An OpenShift Route in front of the proxy may impose its own, lower body limit, in which case the
router rejects the request first with its own error shape.

## Buffered-body budget

`SARDEENZ_PROXY_MAX_BUFFERED_BYTES` (default `268435456`, 256 MiB) is a **per-process
(per-replica)** admission budget over **all request-body bytes this process currently holds in
memory** across the `/openai/*` and `/oip/*` surfaces. It is not a cluster-wide budget: each replica
enforces its own, independently, so the aggregate ceiling across the Deployment is the configured
value × the replica count. The counter is frame-based, so it is computed from the bytes actually
received: a lying, too-small or absent `Content-Length` cannot bypass it, and chunked framing is
counted exactly like declared framing. A request that would cross the budget is rejected with the
proxy's JSON error envelope — `503`, `type: "overloaded"`, message
`buffered body budget exceeded (SARDEENZ_PROXY_MAX_BUFFERED_BYTES); retry later` — either on its
declared `Content-Length` before the read starts (advisory) or as soon as a data frame would cross
the budget (authoritative). Admission never waits, so the budget cannot deadlock against parking or
forwarding permits.

The per-request cap from the previous section is unchanged and takes precedence: a body with a
declared `Content-Length` over `SARDEENZ_PROXY_MAX_BODY_BYTES` still gets `413 request_too_large`,
never the `503`. One sizing caveat, not a code path: with the budget configured **below**
`SARDEENZ_PROXY_MAX_BODY_BYTES`, a _chunked_ body that would earn a `413` can trip the frame
counter first and surface the `503` instead — so keep the budget well above the per-request cap
(the shipped 256 MiB against 32 MiB does) and lower `SARDEENZ_PROXY_MAX_BODY_BYTES` together with
the budget, never on its own.

Bytes stay counted from the first data frame until the in-memory copy is dropped — **through
parking and through forwarding** — and are released on completion or on cancellation. A parked body
therefore counts against **both** this budget and `SARDEENZ_PARKING_MAX_BYTES`: the two budgets are
additive, not alternatives. That is not a deadlock — a parked request waits only for the model wake,
bounded by `SARDEENZ_PARKING_TIMEOUT_SECS` (120 s by default), while read admission never blocks —
but a long wake storm holding parked bytes can saturate this budget and `503` new requests until
the parked bodies time out or the model wakes. Size the budget above the parked working set you
expect during a wake.

Sizing: the deployed value is 256 MiB **per replica**, 25 % of each proxy container's `1Gi` memory
limit, leaving headroom for per-connection stacks, routing state and response streaming. Peak
buffered memory in one replica is bounded by this value rather than by concurrency, so raise it and
the memory limit together; with two replicas the Deployment can hold up to 512 MiB of buffered
bodies. `0` disables enforcement — an explicit opt-out that logs
`buffered-body budget enforcement disabled (SARDEENZ_PROXY_MAX_BUFFERED_BYTES=0)` at startup; the
counter and the gauge keep running either way so the exposure stays visible. Watch
`sardeenz_proxy_buffered_body_bytes` (admin `/metrics`, no labels) for the current value — one
series per replica, so sum across replicas for the Deployment total — and alarm when it approaches
the configured budget.

## Inference API key

`SARDEENZ_PROXY_INFERENCE_API_KEY` adds an **optional** static key to the inference port as a quick
way to protect a test or demo Route when no authenticated gateway is deployed. It is read from the
shared `sardeenz-service-tokens` Secret with `optional: true`, so an install whose Secret lacks the
key keeps rendering and running exactly as before (auth disabled). The admin port (`/healthz`,
`/readyz`, `/metrics`) is never behind the key — probes and Prometheus scraping keep working.

When the key is set, every `/openai/*` and `/oip/*` request must carry
`Authorization: Bearer <key>`. A missing or wrong key is answered with the proxy's JSON error
envelope — `401`, `type: "authentication_error"`, message `missing or invalid inference API key` —
**before** the request body is read and before any parking or wake trigger, so an unauthenticated
caller can neither buffer a body nor cold-start a model. The comparison is constant-time per key,
and the client's `Authorization` header is never forwarded to the runner while the key is enabled.

Set two comma-separated keys to rotate without downtime, **newest first**: put the new key first,
roll the proxy (it then accepts both keys), roll the dashboard, then remove the old key and roll the
proxy again. A blank or whitespace-only segment fails startup (fail closed — unset the variable to
disable the key). The dashboard BFF reads the same Secret key (as `SARDEENZ_INFERENCE_API_KEY`) and
sends server-side only the **first** key of the list — a bearer token is a single value, and the BFF
does not rotate by itself — so the playground keeps working through the roll; the browser never sees
it.

This is a single shared secret for quick protection: it carries no per-client identity, no quotas
and no rate limiting, and it cannot express per-tenant policy. An authenticated gateway remains the
production answer (see the proxy's security and trust model in
[`docs/architecture/components/proxy.md`](../../docs/architecture/components/proxy.md#security-and-trust-model)).

Apply this component alone with:

```bash
oc apply -k deployment/proxy/
oc rollout status deployment/sardeenz-proxy -n sardeenz
```

For external inference access on OpenShift, create a TLS Route only for the inference Service:

```bash
oc create route edge sardeenz-proxy \
  --service=sardeenz-proxy \
  --port=inference \
  --insecure-policy=Redirect \
  -n sardeenz
```

Do not expose `sardeenz-proxy-admin` publicly.
