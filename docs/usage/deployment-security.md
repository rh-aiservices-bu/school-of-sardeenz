# Deployment Security

## Dashboard BFF Authentication

The dashboard BFF enforces secure authentication defaults at startup:

- **Production (`NODE_ENV=production`)**: `AUTH_MODE=none` is rejected. The server will not start without explicit authentication configured. Set `AUTH_MODE` to `simple` or `oauth`.
- **Simple mode**: `ADMIN_PASSWORD` must be explicitly set to a non-empty value. The server will not start with an empty or default password, regardless of environment.
- **Development**: `AUTH_MODE=none` is permitted but logs a prominent warning. Do not expose development instances beyond a trusted network.

### Inference concurrency defense in depth

The BFF limits simultaneous `POST /api/inference/chat/completions` responses per verified user with `SARDEENZ_BFF_MAX_CONCURRENT_INFERENCE_REQUESTS_PER_USER` (default `4`). It rejects excess requests with `429` before they reach the proxy, and releases slots when the response ends or the client disconnects. In `AUTH_MODE=none`, all callers intentionally share one `anonymous` identity.

This limiter is in-memory and scoped to each BFF replica. With multiple replicas, a user can consume up to the configured cap on each replica, so use an ingress/API-gateway per-user limit as the aggregate, cluster-wide control. The BFF cap remains useful as a local defense if that outer control is bypassed or misconfigured.

### Required environment variables by auth mode

| Auth Mode | Required Variables                                                                                                                              |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `simple`  | `AUTH_MODE=simple`, `ADMIN_PASSWORD=<non-empty>`, `JWT_SECRET=<non-empty>`                                                                      |
| `oauth`   | `AUTH_MODE=oauth`, `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET`, `OAUTH_ISSUER_URL`, `K8S_API_URL`, `SARDEENZ_PUBLIC_URL`, `JWT_SECRET=<non-empty>` |
| `none`    | Only allowed when `NODE_ENV` is not `production` (development/testing)                                                                          |

### Example production configuration

```bash
AUTH_MODE=simple
ADMIN_USERNAME=admin
ADMIN_PASSWORD=<strong-random-password>
JWT_SECRET=<random-256-bit-hex>
SARDEENZ_PUBLIC_URL=https://sardeenz.example.com
```

### OpenShift OAuth RBAC

In OAuth mode, Sardeenz uses the same namespace-scoped marker Roles as Sardeenz v1. The
dashboard ServiceAccount submits `LocalSubjectAccessReview` requests for the authenticating user
and their OpenShift groups. A user receives `admin` and/or `admin-readonly` only when they are
bound to the corresponding marker Role; users with neither are denied login. The dashboard base
creates the marker Roles and its review permission. Operators create user or group RoleBindings,
for example:

```bash
oc adm policy add-role-to-group sardeenz-admin platform-admins \
  --role-namespace=sardeenz -n sardeenz
oc adm policy add-role-to-group sardeenz-admin-readonly viewers \
  --role-namespace=sardeenz -n sardeenz
```

The default OpenShift deployment configures `K8S_API_URL=https://kubernetes.default.svc` and uses
the projected dashboard ServiceAccount token. Local deployments can set `SERVICE_ACCOUNT_TOKEN`
instead. This approach does not give Sardeenz administrators permission to create Pods.
See [OpenShift OAuth RBAC](openshift-rbac.md) for the complete deployment and RoleBinding guide.

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

## Service-to-Service Tokens

Two shared secrets add defense in depth between components. Both are bearer tokens compared in
constant time; services fail closed at startup when their token is unset, so local development must
opt out with `SARDEENZ_ALLOW_UNAUTHENTICATED_API=true` (dev-only escape hatch — never set it
in-cluster).

| Variable                | Checked by                                                              | Must also be set on                          |
| ----------------------- | ----------------------------------------------------------------------- | -------------------------------------------- |
| `SARDEENZ_API_TOKEN`    | Control plane, on every `/api/v1/*` request (`Authorization: Bearer …`) | Dashboard BFF and proxy (wake-trigger calls) |
| `SARDEENZ_WORKER_TOKEN` | Worker agent (port 9100), on every route except `/healthz`              | Control plane (`WorkerClient`)               |

Store them in Kubernetes Secrets, not in manifests
([ADR-013](../architecture/adrs/adr-013-secrets-management.md)).

## Control Plane Network Isolation

The control plane supports shared bearer-token authentication through `SARDEENZ_API_TOKEN`, but
it **must still be deployed within a trusted network boundary**. Use a dedicated Kubernetes
namespace and a NetworkPolicy restricting ingress to trusted services; the token is defense in
depth, not a reason to expose the control plane publicly.

### What is exposed if authentication or network isolation is missing

Any caller with network access to the control plane can:

| Operation             | Endpoint                                       | Impact                             |
| --------------------- | ---------------------------------------------- | ---------------------------------- |
| Deploy models         | `POST /api/v1/models`                          | Allocates GPU resources            |
| Delete models         | `DELETE /api/v1/models/:name`                  | Frees GPU resources, stops runners |
| Sleep / wake models   | `POST /api/v1/models/:name/sleep\|wake`        | Changes resource allocation        |
| Stop / start models   | `POST /api/v1/models/:name/stop\|start`        | Changes resource allocation        |
| Read cluster topology | `GET /api/v1/workers`, `GET /api/v1/cluster/*` | Reveals infrastructure details     |
| Read routing map      | `GET /api/v1/models`                           | Reveals model endpoints            |
| Scrape metrics        | `GET /metrics`                                 | Prometheus operational data        |

### Recommended deployment constraints

1. **Kubernetes NetworkPolicy**: Restrict ingress to the control-plane Service to only the proxy, dashboard, and worker agents. Deny all other ingress.

2. **No public-facing Ingress**: Do not create an Ingress or Route for the control plane. It should only be reachable via cluster-internal DNS (`control-plane.namespace.svc`).

3. **Service mesh mTLS** (optional): If running in a service mesh (Istio, Linkerd), enable strict mTLS between the control plane and its clients.

`deployment/control-plane/networkpolicy.yaml` also allows ingress to port 3000 from the
`openshift-user-workload-monitoring` namespace, so OpenShift's Prometheus can scrape the
unauthenticated `GET /metrics` endpoint listed above. That endpoint has no bearer-token check;
this namespace-scoped rule is its only access restriction.

## Worker Agent Network Isolation

The worker agent's management API (`POST/DELETE /runners`, `GET /runners/*/logs`) on port 9100 is
protected by the shared secret `SARDEENZ_WORKER_TOKEN` (required at startup unless
`SARDEENZ_ALLOW_UNAUTHENTICATED_API` opts out), checked via `Authorization: Bearer <token>` on
every route except `/healthz`. This token protects **only** the worker agent; it does not protect a
runner shim's management endpoint at a runner block's base port or its engine listener. Those
runner endpoints are unauthenticated and depend on network isolation. As with the control plane,
this is a defense-in-depth measure, not a substitute for network isolation — the worker **must
only be deployed within a trusted network boundary**.

### What is exposed without network isolation

Any caller with network access to a worker agent can:

| Operation        | Endpoint                                                               | Impact                                          |
| ---------------- | ---------------------------------------------------------------------- | ----------------------------------------------- |
| Start a runner   | `POST /runners`                                                        | Launches an engine process, consumes GPU memory |
| Stop a runner    | `DELETE /runners/:runnerId`                                            | Kills an in-flight runner                       |
| Read runner logs | `GET /runners/:runnerId/logs`, `GET /runners/by-model/:modelName/logs` | Reveals model/engine operational data           |

### Recommended deployment constraints

1. **Set `SARDEENZ_WORKER_TOKEN`**: Configure the same value on the worker agent and the control plane (`SARDEENZ_WORKER_TOKEN`) so the control plane authenticates its `WorkerClient` requests. Leave unset for local dev only, together with `SARDEENZ_ALLOW_UNAUTHENTICATED_API=true` — startup fails when it is empty.

2. **Kubernetes NetworkPolicy**: `deployment/sif-runner/networkpolicy.yaml` restricts ingress to
   the worker Pod with component-scoped selectors. In its default 32-runner configuration it
   allows the control plane (`app.kubernetes.io/name=sardeenz-control-plane`) to the worker API
   (9100) and management ports `9101 + 4n` (`n = 0…31`, 9101 through 9225); it allows the proxy
   (`app.kubernetes.io/name=sardeenz-proxy`) only to HTTP engine ports `9102 + 4n` (`n = 0…31`,
   9102 through 9226).
   gRPC (`base + 2`) and metrics (`base + 3`) ports receive no ingress rule and are not exposed.

3. **Keep runner engines private**: runner HTTP engine listeners are unauthenticated backends.
   Do not create a direct Service, Ingress, or Route for a worker or engine port. Clients must use
   the proxy's protocol-family routes (`/openai/...` or `/oip/...`), which are forwarded to the
   selected engine.

### Namespace and CNI considerations

The shipped policy has a `podSelector` only, so Kubernetes scopes both control-plane and proxy
sources to the **same namespace** as the worker. This is deliberate: labels alone are not a
namespace boundary. If those components run in another namespace, add a separate ingress source
that combines a `namespaceSelector` identifying that specific trusted namespace with the existing
component `podSelector`; never broaden the rule to every namespace or every pod in a namespace.

NetworkPolicy label selection is not cryptographic workload identity: the source identity here is
the Pod's self-chosen `app.kubernetes.io/name` label. Deploy Sardeenz in a dedicated namespace and
use RBAC and admission controls to prevent untrusted workload authors from creating or patching
Pods (or Pod templates) there, and from spoofing the reserved Sardeenz component labels. Otherwise
an untrusted namespace writer can label a Pod as `sardeenz-proxy` or
`sardeenz-control-plane` and impersonate that source; the same concern applies in any specifically
selected cross-namespace source namespace.

NetworkPolicy is effective only with a CNI implementation that enforces it. Verify enforcement on
the target cluster (including the CNI's treatment of pod-local traffic) before relying on these
rules as the engine isolation boundary. Keep `SARDEENZ_WORKER_PORT`,
`SARDEENZ_RUNNER_PORT_START`, `SARDEENZ_MAX_RUNNERS`, and the explicit policy ports synchronized
when patching an overlay; changing only one can break management or inference traffic.

4. **No public-facing Ingress**: Do not create an Ingress or Route for the worker agent. It should only be reachable via cluster-internal DNS.

## Namespace default-deny and allow policies

The `sardeenz` namespace ships default-deny ingress from
[`deployment/prereq/networkpolicy.yaml`](../../deployment/prereq/networkpolicy.yaml): a single
policy with an empty `podSelector`, `policyTypes: [Ingress]` and no ingress rules drops every
inbound connection to every Pod in the namespace. NetworkPolicy allows are additive, so the
per-flow policies below supply exactly the allowed set. Egress is unrestricted.

| Destination | Port | Allowed sources | Policy |
| ----------- | ---- | --------------- | ------ |
| redis (Valkey) | 6379 | control plane, proxy, dashboard, worker (same-namespace pod selectors) | `prereq/networkpolicy.yaml` |
| PostgreSQL | 5432 | control plane | `prereq/networkpolicy.yaml` |
| proxy inference | 8080 | platform router (ingress namespace) and the dashboard BFF (chat forwarding via `SARDEENZ_INFERENCE_URL`) | `proxy/networkpolicy.yaml` |
| proxy admin | 9099 | `openshift-user-workload-monitoring` namespace | `proxy/networkpolicy.yaml` |
| dashboard BFF | 4000 | platform router (ingress namespace) | `dashboard/networkpolicy.yaml` |
| control plane | 3000 | proxy, dashboard, `openshift-user-workload-monitoring` namespace | existing `control-plane/networkpolicy.yaml` |
| worker agent + shim mgmt | 9100, 9101+4n | control plane | existing `sif-runner/networkpolicy.yaml` |
| worker engines | 9102+4n | proxy | existing `sif-runner/networkpolicy.yaml` |

Network isolation is complemented by Valkey authentication: the server now requires
`requirepass` from the `sardeenz-redis-credentials` Secret (see `deployment/prereq/README.md`).
The default-deny plus allow policies limit *who can reach* port 6379; AUTH stops anyone who
still can — a pod that merely carries a Sardeenz component label in the namespace is not
sufficient by itself.

The two ingress-sourced rules (proxy 8080, dashboard 4000) select the platform router with
`policy-group.network.openshift.io/ingress: ""`, the documented "allow from the OpenShift
Ingress Controller" form for the OVN-Kubernetes default network plugin (OpenShift/OKD 4.15+).
On clusters whose router namespace carries the SDN-era label instead, patch the selector in an
overlay to `network.openshift.io/policy-group: ingress`. Verify at deploy time with
`oc get namespace openshift-ingress --show-labels` and a Route probe after apply.

The same "Namespace and CNI considerations" caveats as above apply unchanged: NetworkPolicy
labels are not workload identity, and the rules are only as strong as the CNI's enforcement of
them.

## Module store write protection

The `sardeenz-modules` PVC (the module store) is write-protected by a cluster-scoped
`ValidatingAdmissionPolicy` that rejects Pods mounting the claim read-write unless they run as
one of the two exempt ServiceAccounts (`sardeenz-librarian`, which builds and publishes modules,
and `sardeenz-control-plane`, which imports them); every other Pod, workers included, must mount
it `readOnly`. The mechanism and its inline fallbacks are documented in
[`deployment/sif-runner/module-pvc-write-protection.yaml`](../../deployment/sif-runner/module-pvc-write-protection.yaml)
and [ADR-017](../architecture/adrs/adr-017-runner-image-pipeline.md).

Protection ships active: the policy's binding selects namespaces labeled
`sardeenz.io/module-guard=enforce`, which the `sardeenz` Namespace from `deployment/prereq/`
carries on a stock install. Removing the label is the explicit opt-out:

```bash
oc label namespace <namespace> sardeenz.io/module-guard-
```

Admission requires ValidatingAdmissionPolicy support: OpenShift 4.17+ / Kubernetes 1.30+. On
older clusters the binding is rejected at apply time and no protection exists.

As with the NetworkPolicy labels above, the guard is only as strong as the RBAC controlling who
may patch the Namespace object: anyone who can remove the `sardeenz.io/module-guard` label (or
edit the binding) can switch protection off. Restrict Namespace-object writes the same way you
restrict Pod creation — labels alone are not a namespace boundary.

## Container securityContexts and SCC capabilities

Every Sardeenz workload container hardens its own `securityContext`: no privilege escalation
and all Linux capabilities dropped. The control plane, proxy, dashboard, Postgres, and Valkey
containers also run with `runAsNonRoot: true`. The control-plane and proxy containers run with
`readOnlyRootFilesystem: true` and a scratch `emptyDir` mounted at `/tmp`: the control plane's
`HOME=/tmp/sardeenz` and any temporary files live there, while persistent data stays on the
modules/weights PVCs and the SIF importer's temp files stay inside the (writable) modules
claim. The proxy pod sets `automountServiceAccountToken: false` — it never calls the
Kubernetes API, so the default ServiceAccount carries no token into the pod. The control
plane, dashboard, and librarian keep their ServiceAccount tokens: the control plane for
leader-election Leases, the dashboard for its Prometheus bearer token and OAuth
subject-access checks, the librarian for the image-build API. The worker keeps its
ServiceAccount for the SCC binding, but its agent makes no Kubernetes API calls. The worker
container's `runAsNonRoot: true` makes the SCC's non-root UID policy self-enforcing at the
pod level: a root-`USER` image fails fast instead of silently running as UID 0. The
librarian's `build-oci` init container matches its `publish-sif` sibling (no privilege
escalation, all capabilities dropped).

The `sardeenz-sif-runner` SCC grants **no added capabilities**: it is `restricted-v2` with two
deliberate relaxations — seccomp `Unconfined`, so Apptainer can create its in-container user
namespace, and `fsGroup: RunAsAny`, so the worker and librarian pods can request `fsGroup: 0`
for a group-writable `/scratch`
([ADR-016](../architecture/adrs/adr-016-sif-worker-security-posture.md)). All runner ports
(worker management 9100; runner management `9101 + 4n` and HTTP engine `9102 + 4n` for
`n = 0…31`, per the flow table above) are above 1024, so `NET_BIND_SERVICE` was dead weight
and is not granted: `allowedCapabilities` is empty and `requiredDropCapabilities: [ALL]`
remains.
