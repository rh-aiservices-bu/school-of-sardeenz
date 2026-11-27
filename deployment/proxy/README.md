# Routing proxy deployment

This Kustomize base deploys the stateless routing proxy and two cluster Services:

- `sardeenz-proxy:8080` carries inference traffic;
- `sardeenz-proxy-admin:9099` carries health, readiness, and Prometheus metrics and should remain
  cluster-internal.

The proxy reads the routing map from `sardeenz-redis` and sends wake requests to
`sardeenz-control-plane`. It consumes `SARDEENZ_API_TOKEN` from the shared
`sardeenz-service-tokens` Secret described in [`../README.md`](../README.md).

## Request body limit

Both inference surfaces (`/openai/*` and `/oip/*`) buffer the whole request body before routing it.
`SARDEENZ_PROXY_MAX_BODY_BYTES` (default `33554432`, 32 MiB) caps that buffer; a larger body is
rejected before routing with the proxy's JSON error envelope — `413`, `type: "request_too_large"`, and
a message naming the configured limit and the variable.

The limit bounds one request, not total proxy memory — the aggregate of concurrently buffered
bodies is bounded separately by `SARDEENZ_PROXY_MAX_BUFFERED_BYTES` (see
[Buffered-body budget](#buffered-body-budget)), and the container memory limit in `deployment.yaml`
(`1Gi`) remains the hard ceiling. Keep the inference Service cluster-internal or behind an
authenticated gateway that enforces its own body cap, and lower `SARDEENZ_PROXY_MAX_BODY_BYTES`
where that exposure is unacceptable; raise the memory limit only after accounting for concurrency.
An OpenShift Route in front of the proxy may impose its own, lower body limit, in which case the
router rejects the request first with its own error shape.

## Buffered-body budget

`SARDEENZ_PROXY_MAX_BUFFERED_BYTES` (default `268435456`, 256 MiB) is a global admission budget
over **all bytes of request bodies currently buffered in memory** by the `/openai/*` and `/oip/*`
surfaces. The counter is frame-based, so it is computed from the bytes actually received: a lying,
too-small or absent `Content-Length` cannot bypass it, and chunked framing is counted exactly like
declared framing. A request that would cross the budget is rejected with the proxy's JSON error
envelope — `503`, `type: "overloaded"`, message
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

Sizing: the deployed value is 256 MiB, 25 % of the proxy's `1Gi` container memory limit, leaving
headroom for per-connection stacks, routing state and response streaming. Peak buffered memory is
bounded by this value rather than by concurrency, so raise it and the memory limit together. `0`
disables enforcement — an explicit opt-out that logs
`buffered-body budget enforcement disabled (SARDEENZ_PROXY_MAX_BUFFERED_BYTES=0)` at startup; the
counter and the gauge keep running either way so the exposure stays visible. Watch
`sardeenz_proxy_buffered_body_bytes` (admin `/metrics`, no labels) for the current value, and alarm
when it approaches the configured budget.

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
