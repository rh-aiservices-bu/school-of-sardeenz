# Deployment Security

## Dashboard BFF Authentication

The dashboard BFF enforces secure authentication defaults at startup:

- **Production (`NODE_ENV=production`)**: `AUTH_MODE=none` is rejected. The server will not start without explicit authentication configured. Set `AUTH_MODE` to `simple` or `oauth`.
- **Simple mode**: `ADMIN_PASSWORD` must be explicitly set to a non-empty value. The server will not start with an empty or default password, regardless of environment.
- **Development**: `AUTH_MODE=none` is permitted but logs a prominent warning. Do not expose development instances beyond a trusted network.

### Required environment variables by auth mode

| Auth Mode | Required Variables                                                                                                                     |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `simple`  | `AUTH_MODE=simple`, `ADMIN_PASSWORD=<non-empty>`, `JWT_SECRET=<non-empty>`                                                              |
| `oauth`   | `AUTH_MODE=oauth`, `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET`, `OAUTH_ISSUER_URL`, `SARDEENZ_PUBLIC_URL`, `JWT_SECRET=<non-empty>`         |
| `none`    | Only allowed when `NODE_ENV` is not `production` (development/testing)                                                                  |

### Example production configuration

```bash
AUTH_MODE=simple
ADMIN_USERNAME=admin
ADMIN_PASSWORD=<strong-random-password>
JWT_SECRET=<random-256-bit-hex>
SARDEENZ_PUBLIC_URL=https://sardeenz.example.com
```

### Running behind a reverse proxy or ingress

The BFF sets Fastify's `trustProxy: true`, so `X-Forwarded-For`/`X-Forwarded-Proto`/`X-Forwarded-Host`
from the proxy are honored for client IP (used by the login rate limiter) and request scheme/host.
Since those headers only reflect the truth when a trusted proxy sits in front of the BFF and strips
any client-supplied values, always deploy the BFF behind a proxy/ingress that overwrites (not
appends) these headers on the way in.

Set `SARDEENZ_PUBLIC_URL` to the externally-visible origin (scheme + host, no trailing slash) of the
dashboard, e.g. `https://sardeenz.example.com`. It is used to:

- Build the OAuth `redirect_uri` sent to the identity provider — required so the value doesn't
  depend on spoofable request headers when `AUTH_MODE=oauth`. `validateAuthConfig` refuses to start
  in `oauth` mode without it.
- Decide whether the SSE auth cookie is issued with `Secure` — derived from the `https:` scheme of
  `SARDEENZ_PUBLIC_URL` when set, falling back to a localhost heuristic in local dev.

## Control Plane Network Isolation

The control plane does not implement its own authentication. It **must only be deployed within a trusted network boundary** — for example, a Kubernetes namespace with NetworkPolicy restricting ingress to trusted services only.

### What is exposed without network isolation

Any caller with network access to the control plane can:

| Operation             | Endpoint                                       | Impact                             |
| --------------------- | ---------------------------------------------- | ---------------------------------- |
| Deploy models         | `POST /api/v1/models`                          | Allocates GPU resources            |
| Delete models         | `DELETE /api/v1/models/:name`                  | Frees GPU resources, stops runners |
| Sleep / wake models   | `POST /api/v1/models/:name/sleep\|wake`        | Changes resource allocation        |
| Read cluster topology | `GET /api/v1/workers`, `GET /api/v1/cluster/*` | Reveals infrastructure details     |
| Read routing map      | `GET /api/v1/models`                           | Reveals model endpoints            |
| Scrape metrics        | `GET /metrics`                                 | Prometheus operational data        |

### Recommended deployment constraints

1. **Kubernetes NetworkPolicy**: Restrict ingress to the control-plane Service to only the proxy, dashboard, and worker agents. Deny all other ingress.

2. **No public-facing Ingress**: Do not create an Ingress or Route for the control plane. It should only be reachable via cluster-internal DNS (`control-plane.namespace.svc`).

3. **Service mesh mTLS** (optional): If running in a service mesh (Istio, Linkerd), enable strict mTLS between the control plane and its clients.

## Worker Agent Network Isolation

The worker agent's management API (`POST/DELETE /runners`, `GET /runners/*/logs`) is protected by an optional shared secret (`SARDEENZ_WORKER_TOKEN`), checked via `Authorization: Bearer <token>` on every route except `/healthz`. As with the control plane, this is a defense-in-depth measure, not a substitute for network isolation — the worker **must only be deployed within a trusted network boundary**.

### What is exposed without network isolation

Any caller with network access to a worker agent can:

| Operation         | Endpoint                                | Impact                                 |
| ------------------ | ---------------------------------------- | --------------------------------------- |
| Start a runner      | `POST /runners`                          | Launches an engine process, consumes GPU memory |
| Stop a runner       | `DELETE /runners/:runnerId`              | Kills an in-flight runner               |
| Read runner logs    | `GET /runners/:runnerId/logs`, `GET /runners/by-model/:modelName/logs` | Reveals model/engine operational data |

### Recommended deployment constraints

1. **Set `SARDEENZ_WORKER_TOKEN`**: Configure the same value on the worker agent and the control plane (`SARDEENZ_WORKER_TOKEN`) so the control plane authenticates its `WorkerClient` requests. Leave unset for local dev only — a startup warning is logged on both sides when it is empty.

2. **Kubernetes NetworkPolicy**: `deployment/sif-runner/networkpolicy.yaml` restricts ingress to the worker Service to the control plane only. Deny all other ingress.

3. **No public-facing Ingress**: Do not create an Ingress or Route for the worker agent. It should only be reachable via cluster-internal DNS.
