# Deployment Security — Phase 2

## Network Isolation Requirement

The Phase 2 control plane **does not implement authentication or authorization**. This is a deliberate phase decision (see `docs/project/phase2.md`), not an accidental omission. Auth is planned for a later phase.

Until authentication is added, the control plane **must only be deployed within a trusted network boundary** — for example, a Kubernetes namespace with NetworkPolicy restricting ingress to trusted services only.

## What is exposed without auth

Any caller with network access to the control plane can:

| Operation | Endpoint | Impact |
| --- | --- | --- |
| Deploy models | `POST /api/v1/models` | Allocates GPU resources |
| Delete models | `DELETE /api/v1/models/:name` | Frees GPU resources, stops runners |
| Sleep / wake models | `POST /api/v1/models/:name/sleep\|wake` | Changes resource allocation |
| Read cluster topology | `GET /api/v1/workers`, `GET /api/v1/cluster/*` | Reveals infrastructure details |
| Read routing map | `GET /api/v1/models` | Reveals model endpoints |
| Consume SSE events | `GET /api/v1/events` | Real-time cluster state stream |
| Scrape metrics | `GET /metrics` | Prometheus operational data |

## Recommended deployment constraints

1. **Kubernetes NetworkPolicy**: Restrict ingress to the control-plane Service to only the proxy, dashboard, and worker agents. Deny all other ingress.

2. **No public-facing Ingress**: Do not create an Ingress or Route for the control plane. It should only be reachable via cluster-internal DNS (`control-plane.namespace.svc`).

3. **Service mesh mTLS** (optional): If running in a service mesh (Istio, Linkerd), enable strict mTLS between the control plane and its clients.

## When will auth be added?

Authentication and authorization are tracked as a future phase item. The current plan is to add:
- mTLS between control plane, proxy, and workers (inter-service auth)
- Token-based auth for the dashboard and external API consumers
- RBAC for model management operations

Until then, deployment isolation is the sole access control mechanism.
