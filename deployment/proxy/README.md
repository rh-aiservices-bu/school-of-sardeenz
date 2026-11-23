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
