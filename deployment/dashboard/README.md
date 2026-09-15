# Dashboard deployment

The dashboard image contains both the compiled React frontend and its Fastify BFF. The BFF is the
only browser-facing application API and connects internally to the control plane, Valkey, and the
routing proxy.

Production images refuse to start with unauthenticated access. Create `sardeenz-dashboard-auth`
as described in [`../README.md`](../README.md); the supplied example uses simple username/password
authentication. OAuth configuration is documented in
[`../../docs/usage/openshift-rbac.md`](../../docs/usage/openshift-rbac.md); the dashboard base
also creates the ServiceAccount and namespace-scoped marker Roles used for OAuth RBAC.

Apply this component alone with:

```bash
oc apply -k deployment/dashboard/
oc rollout status deployment/sardeenz-dashboard -n sardeenz
```

Expose it through an edge-terminated OpenShift Route and then tell the BFF its public origin:

```bash
oc create route edge sardeenz-dashboard \
  --service=sardeenz-dashboard \
  --port=http \
  --insecure-policy=Redirect \
  -n sardeenz

DASHBOARD_URL="https://$(oc get route sardeenz-dashboard -n sardeenz -o jsonpath='{.spec.host}')"
oc set env deployment/sardeenz-dashboard \
  SARDEENZ_PUBLIC_URL="$DASHBOARD_URL" \
  -n sardeenz
```

## OpenShift monitoring

On OpenShift, the dashboard's metrics page queries Prometheus through the cluster's
**user-workload monitoring** stack rather than a project-managed Prometheus. Enable it once per
cluster (cluster-admin):

```bash
oc apply -f - <<'EOF'
apiVersion: v1
kind: ConfigMap
metadata:
  name: cluster-monitoring-config
  namespace: openshift-monitoring
data:
  config.yaml: |
    enableUserWorkload: true
EOF
```

With that enabled, this component's manifests configure everything else:

- **ServiceMonitors** (`deployment/monitoring/`) tell the cluster's Prometheus to scrape the proxy
  admin Service and the control plane Service every 15s.
- **`sardeenz-dashboard-service-ca` ConfigMap** is annotated for the service-ca operator to inject
  the cluster's internal CA bundle, mounted into the dashboard container so it can validate Thanos
  Querier's TLS certificate.
- **`sardeenz-dashboard-metrics-reader` Role/RoleBinding** (`rbac.yaml`) grants the dashboard's
  ServiceAccount `get` on `pods.metrics.k8s.io` in this namespace — the Thanos Querier tenancy
  port authorises the caller's token against that pod-metrics permission (not core Pods and not
  a Prometheus-specific one).
- **`SARDEENZ_PROMETHEUS_URL`** points at the Thanos Querier tenancy port
  (`https://thanos-querier.openshift-monitoring.svc:9092`), which requires the bearer token, CA,
  and namespace query parameter the other three env vars below provide.

The monitoring component is part of the root Kustomization. The `ServiceMonitor` CRD exists on
every OpenShift cluster, so applying it before user-workload monitoring is enabled is harmless;
the targets simply appear once the stack is running. To apply it alone:

```bash
oc apply -k deployment/monitoring/
```

### Non-OpenShift / plain Prometheus setups

If the cluster has an ordinary Prometheus reachable without auth or TLS, set only
`SARDEENZ_PROMETHEUS_URL` to its base URL and leave the other three unset:

| Variable                                | Purpose                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------ |
| `SARDEENZ_PROMETHEUS_URL`               | Prometheus (or Thanos Querier) base URL                                  |
| `SARDEENZ_PROMETHEUS_BEARER_TOKEN_PATH` | Path to a token file sent as `Authorization: Bearer …` on every request  |
| `SARDEENZ_PROMETHEUS_CA_PATH`           | PEM CA bundle used to validate the Prometheus endpoint's TLS certificate |
| `SARDEENZ_PROMETHEUS_TENANT_NAMESPACE`  | Sent as the `namespace` query parameter (Thanos Querier tenancy)         |

When neither the token path nor the tenant namespace is set, the BFF probes readiness with
`GET /-/healthy`. When either is set it sends an authenticated `GET /api/v1/query?query=vector(1)`
instead, because the Thanos Querier tenancy port does not serve `/-/healthy`.

### Verification

- **Observe > Targets** in the OpenShift console should show both the `sardeenz-proxy` and
  `sardeenz-control-plane` ServiceMonitor targets as `Up`.
- `GET /readyz` on the dashboard should report `"prometheus": "ok"` once scraping succeeds; it
  reports `"warning"` (without affecting overall readiness) while Prometheus is unreachable.
