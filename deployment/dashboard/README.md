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

The default Prometheus URL anticipates a future `sardeenz-prometheus` Service. Its absence appears
as a warning in dashboard readiness but does not make the dashboard unavailable.
