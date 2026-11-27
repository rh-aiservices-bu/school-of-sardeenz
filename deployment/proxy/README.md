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

The limit bounds one request, not total proxy memory: parked bodies are budgeted separately by
`SARDEENZ_PARKING_MAX_BYTES` (1 GiB), and the container memory limit in `deployment.yaml` is
`1Gi` — the hard ceiling. In-flight buffers are not accounted anywhere, and
`SARDEENZ_PROXY_MAX_CONCURRENT_FORWARDS` defaults to `0` (no cap), so at the default body limit
roughly 32 simultaneous maximum-size requests can fill that ceiling before any parking or
forwarding decision is made. Keep the inference Service cluster-internal or behind an authenticated
gateway that enforces its own body cap, and lower `SARDEENZ_PROXY_MAX_BODY_BYTES` where that
exposure is unacceptable; raise the memory limit only after accounting for concurrency. An
OpenShift Route in front of the proxy may impose its own, lower body limit, in which case the
router rejects the request first with its own error shape.

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
