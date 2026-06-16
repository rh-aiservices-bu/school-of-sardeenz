# Deployment Security

## Dashboard BFF Authentication

The dashboard BFF enforces secure authentication defaults at startup:

- **Production (`NODE_ENV=production`)**: `AUTH_MODE=none` is rejected. The server will not start without explicit authentication configured. Set `AUTH_MODE` to `simple` or `oauth`.
- **Simple mode**: `ADMIN_PASSWORD` must be explicitly set to a non-empty value. The server will not start with an empty or default password, regardless of environment.
- **Development**: `AUTH_MODE=none` is permitted but logs a prominent warning. Do not expose development instances beyond a trusted network.

### Required environment variables by auth mode

| Auth Mode | Required Variables |
| --- | --- |
| `simple` | `AUTH_MODE=simple`, `ADMIN_PASSWORD=<non-empty>`, `JWT_SECRET=<non-empty>` |
| `oauth` | `AUTH_MODE=oauth`, `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET`, `OAUTH_ISSUER_URL`, `JWT_SECRET=<non-empty>` |
| `none` | Only allowed when `NODE_ENV` is not `production` (development/testing) |

### Example production configuration

```bash
AUTH_MODE=simple
ADMIN_USERNAME=admin
ADMIN_PASSWORD=<strong-random-password>
JWT_SECRET=<random-256-bit-hex>
```

## Control Plane Network Isolation

The control plane does not implement its own authentication. It **must only be deployed within a trusted network boundary** — for example, a Kubernetes namespace with NetworkPolicy restricting ingress to trusted services only.

### What is exposed without network isolation

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

### Recommended deployment constraints

1. **Kubernetes NetworkPolicy**: Restrict ingress to the control-plane Service to only the proxy, dashboard, and worker agents. Deny all other ingress.

2. **No public-facing Ingress**: Do not create an Ingress or Route for the control plane. It should only be reachable via cluster-internal DNS (`control-plane.namespace.svc`).

3. **Service mesh mTLS** (optional): If running in a service mesh (Istio, Linkerd), enable strict mTLS between the control plane and its clients.
