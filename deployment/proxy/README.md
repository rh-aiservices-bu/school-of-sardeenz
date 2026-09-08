# Routing proxy deployment

This Kustomize base deploys the stateless routing proxy and two cluster Services:

- `sardeenz-proxy:8080` carries inference traffic;
- `sardeenz-proxy-admin:9099` carries health, readiness, and Prometheus metrics and should remain
  cluster-internal.

The proxy reads the routing map from `sardeenz-redis` and sends wake requests to
`sardeenz-control-plane`. It consumes `SARDEENZ_API_TOKEN` from the shared
`sardeenz-service-tokens` Secret described in [`../README.md`](../README.md).

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
