# ADR-031: In-Namespace Traffic Is Plaintext by Design at This Stage

## Status

Accepted. Implements [#333](https://github.com/rh-aiservices-bu/school-of-sardeenz/issues/333)
(M21). Extends [ADR-022](adr-022-fail-closed-service-tokens.md) (tokens without encryption) and
[ADR-025](adr-025-namespace-default-deny-ingress.md) (reachability without confidentiality).
Direction for native TLS on the token-carrying hops: Backlog
[#334](https://github.com/rh-aiservices-bu/school-of-sardeenz/issues/334). Flow table and CNI
caveats live in [`docs/usage/deployment-security.md`](../../usage/deployment-security.md).

## Context

Every connection between Sardeenz components inside the namespace is unencrypted: plaintext HTTP
for the proxy, control-plane, worker-agent and runner endpoints, plaintext RESP for Valkey, and
plaintext PostgreSQL for the control plane. Confidentiality inside the namespace rests on nothing;
reachability and authentication do the work instead. This ADR records that posture, the
assumptions that make it acceptable at this stage, and the client facts that decide whether an
operator can turn encryption on without code changes.

### The hops

All rows were verified against the code at the M21 tip; line numbers drift, the mechanisms do not.

| Hop                                                  | Carries                                                                   | What authenticates it                                                                                                                                                                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser → dashboard BFF (:4000)                      | user session (JWT) or the `sardeenz_sse` cookie, prompts, admin actions   | BFF authentication at the application layer (the SSE token fallback is ADR-023); TLS ends at the edge Route, so router → BFF is plaintext HTTP inside the cluster (`deployment/README.md:384-397`)                |
| Dashboard BFF → proxy inference (:8080)              | prompts and completions                                                   | optional static key `SARDEENZ_PROXY_INFERENCE_API_KEY` (#332): one shared Secret value for proxy and BFF (`proxy/src/config.rs:105`, `dashboard/server/clients/inference.ts:41-48`); key absent = unauthenticated |
| Proxy → runner engine (`9102 + 4n`)                  | prompts and completions, plus a client-supplied `Authorization` header    | none — the runner engine is unauthenticated; the client's `Authorization` is stripped only while the inference key (#332) is enabled (`proxy/src/auth.rs:12-23,40`), otherwise it is forwarded as-is              |
| Proxy → control plane (:3000, `POST /api/v1/wake`)   | `SARDEENZ_API_TOKEN`, the `modelName` to wake                             | fail-closed bearer (ADR-022), `proxy/src/parking/wake.rs:21-27`                                                                                                                                                   |
| Dashboard BFF → control plane (:3000)                | `SARDEENZ_API_TOKEN`, every model/worker/cluster operation the UI issues  | fail-closed bearer (ADR-022), `dashboard/server/clients/control-plane.ts:17,36-38`                                                                                                                                |
| Control plane → worker agent (:9100)                 | `SARDEENZ_WORKER_TOKEN`, runner create/delete/logs                        | fail-closed bearer (ADR-022), `control-plane/src/clients/worker.ts:164-182`                                                                                                                                       |
| Control plane → runner management (`9101 + 4n`)      | `/health`, `/sleep`, `/wake`, `/sleep-status`                             | none (`control-plane/src/clients/runner.ts:27-45`)                                                                                                                                                                |
| Control plane, proxy, dashboard BFF → Valkey         | routing map, claims and reservations, recency tracking, plus the password | `requirepass` AUTH only — no TLS (`deployment/prereq/README.md:44-46`)                                                                                                                                            |
| Worker agent → Valkey (:6379)                        | self-registration and heartbeat keys                                      | same Secret URL, `requirepass` AUTH (`runners/dev-worker/src/registration.ts:142-154`)                                                                                                                            |
| Control plane → PostgreSQL (:5432)                   | SQL, schema, model and instance state, plus the database password         | password inside `SARDEENZ_DATABASE_URL`, no `sslmode` (`control-plane/src/config.ts:219-222`)                                                                                                                     |
| Monitoring → control plane `/metrics`, proxy (:9099) | Prometheus metrics                                                        | none — the namespace-scoped allow rule is the only control                                                                                                                                                        |

The Valkey and PostgreSQL rows carry credentials in the connection string itself (the
`requirepass` password is embedded as `redis://:<password>@…`, the database password in the
`postgresql://user:password@…` URL), so those two hops leak a credential even without a token
header. The monitoring row is included for completeness: `GET /metrics` on the control plane has
no bearer check at all. The flow table under _Namespace default-deny and allow policies_ in
[`docs/usage/deployment-security.md`](../../usage/deployment-security.md) is the authoritative
statement of _who may reach_ each destination; this table states what travels once they do.

### Trust assumptions

1. **A dedicated namespace for Sardeenz only**, with RBAC and admission preventing untrusted
   workload authors from creating or patching Pods there. NetworkPolicy sources are self-chosen
   pod labels, not workload identity: anyone who can create a Pod can impersonate a component
   (`docs/usage/deployment-security.md:189-196`).
2. **A CNI that actually enforces NetworkPolicy**, verified at deploy time
   (`docs/usage/deployment-security.md:197-201`). Plaintext is acceptable only because
   reachability is bounded first.
3. **The node and CNI layer are trusted.** Anyone who can capture traffic at the node, veth or
   CNI level defeats this posture regardless of what the components negotiate; that capability is
   outside the threat model this ADR accepts.
4. **No untrusted workloads run in the namespace** — no sidecars or dashboards from other teams,
   no debugging pods left behind. A pod placed there is trusted as much as a Sardeenz component.
5. **External exposure only through edge-terminated Routes** for the dashboard BFF (:4000) and,
   if created, the proxy inference Service (:8080), with `--insecure-policy=Redirect`
   (`deployment/README.md:384-397`). The control plane, the proxy admin Service (:9099), the
   worker agent and the runner ports have no router ingress rule (`deployment/README.md:399-402`).
6. **The prerequisites sit inside the same trust boundary.** The shipped deployment runs Valkey
   and PostgreSQL in the namespace (`deployment/prereq/`). An externally managed service meets this
   assumption only if its network path is at least as trusted — and then decision 3's TLS options
   apply.

## Decision

1. **Accept plaintext in-namespace at this stage.** The controls are namespace isolation
   (ADR-025), fail-closed bearer tokens (ADR-022), the optional inference-port key (#332), and
   Valkey `requirepass` — not encryption. No component, manifest or token changes in this ADR;
   this ADR only records what the existing controls do and do not provide.
2. **Mitigation inventory as it stands after M21 (#332, #300).** Every item bounds blast radius;
   none of them provides confidentiality:
   - default-deny ingress with an explicit allow per flow (ADR-025) — bounds who gets reachability;
   - `SARDEENZ_API_TOKEN` and `SARDEENZ_WORKER_TOKEN`, fail-closed at startup (ADR-022) — bounds
     what an unauthenticated in-namespace caller can do;
   - `SARDEENZ_PROXY_INFERENCE_API_KEY` (#332) — an opt-in single shared secret on `/openai/*` and
     `/oip/*`, checked before the body is read and before any wake trigger, with the client's
     header stripped from the forwarded request while it is enabled. It carries no per-client
     identity, quotas or rate limiting, so a gateway remains the production answer for the
     inference port;
   - `SARDEENZ_PROXY_MAX_BUFFERED_BYTES` (#300, 256 MiB default) — bounds aggregate buffered
     request bodies, which also bounds the memory an anonymous caller can consume through parking
     and forwarding;
   - Valkey `requirepass` from the `sardeenz-redis-credentials` Secret — stops anyone who still
     reaches 6379 without the password.
3. **Encryption options available today are operator-side; none needs a component change except
   Redis TLS on the proxy.**
   - **Service-mesh strict mTLS (Istio, Linkerd)** encrypts any TCP hop between enrolled pods —
     HTTP, RESP and PostgreSQL alike, including the runner engine ports, which are listeners on the
     worker pod. Valkey and PostgreSQL are therefore covered once those pods are enrolled too; the
     shipped `deployment/prereq/` manifests carry no injection annotation, so enrolment has to come
     from the namespace-level mesh setting. The mesh itself is deployment guidance, not something
     this repository ships.
   - **TLS to managed Redis** needs no client code change: ioredis (5.11.1, the version the
     workspace lockfile currently resolves) treats a `rediss://` URL as TLS-enabled — the
     constructor sets `isTls` when the URL string starts with `rediss://` and applies `tls: true`
     once the arguments are merged (`node_modules/ioredis/built/Redis.js:678` and `:688-689`). All
     three ioredis clients are built from `config.redisUrl`: the worker agent passes the URL alone,
     the control plane and the dashboard BFF add an options object that sets neither `tls` nor
     `rediss` handling (`control-plane/src/clients/redis.ts:8`,
     `dashboard/server/clients/redis.ts:40`, `runners/dev-worker/src/index.ts:93`). Changing the
     Secret's scheme is enough for those three.
   - **TLS to managed PostgreSQL** needs no client code change either: `pg` (8.23.1, with
     `pg-connection-string` 2.14.1) parses `sslmode`, `sslcert`, `sslkey` and `sslrootcert` from the
     connection string (`node_modules/pg-connection-string/index.js:77-79`, mode mapping
     `:107-152`), `sslmode=verify-full` enables TLS with verification, and the pool is built
     straight from `SARDEENZ_DATABASE_URL` (`control-plane/src/clients/database.ts:9-11`).
   - **The Rust proxy is the exception and gates the Redis half.** `proxy/Cargo.toml:31` declares
     `redis = { version = "0.29", features = ["tokio-comp", "connection-manager"] }` — no TLS
     feature. redis 0.29.5 maps `rediss://` to `ConnectionAddr::TcpTls` and then fails without one
     of `tls-rustls` / `tls-native-tls` with `InvalidClientConfig` "Cannot connect to TCP with TLS
     without the tls feature" (crate source, `connection.rs:365` and `:826-831`). A cluster-wide
     `rediss://` migration therefore strands the proxy until its Redis client gains a TLS feature,
     which is #334's work.
4. **The intended direction is native TLS on the token-carrying hops — Backlog #334**: the
   control-plane API, the worker-agent API and Redis. For the payload hops (proxy → runner engine,
   runner management), #334 tracks their scope as an open decision; until it is settled they remain
   service-mesh territory. This ADR promises no TLS work in M21.
5. **Rotation is the compensating control that exists today.** The service tokens, the inference
   key and the Valkey password live in Secrets; rotating them invalidates anything captured off
   the wire. There is no detection: a leaked token leaves no trace until it is used, and nothing in
   the platform distinguishes a legitimate in-namespace caller from a forgery.

## Consequences

- **Positive:** the posture is recorded and auditable instead of being reverse-engineered from
  NetworkPolicy tables and client code; the TLS-client facts are pinned to file and line so #334
  starts from evidence rather than from re-verification; the deployment guide can point at one
  place instead of describing encryption ad hoc.
- **Negative:** any in-namespace attacker (or node-level capture) reads `SARDEENZ_API_TOKEN`,
  `SARDEENZ_WORKER_TOKEN`, the inference key and the Valkey password, then impersonates any
  component — the control-plane API grants model deploy/delete and GPU allocation, the worker token
  grants runner control, and the Valkey password allows direct writes to the routing map (the
  ADR-025 poisoning attack) and forged heartbeats. Inference payloads on the BFF → proxy and
  proxy → runner hops can be read and modified in flight, the runner engines and management
  endpoints are unauthenticated once reachability is achieved (labels are self-chosen, so a
  compromised pod can be reachable as `sardeenz-proxy`), and with the inference key disabled the
  client's own `Authorization` header travels in plaintext into that unauthenticated backend.
  Admission control and namespace hygiene are therefore load-bearing, not optional: this posture is
  only as strong as "nothing untrusted runs here".
- **The proxy cannot follow a cluster-wide `rediss://` migration** until its Redis client gains a
  TLS feature (decision 3), so Redis TLS is a #334 deliverable in practice, not a pure operator
  setting.
- **This ADR ages into a supersession, not a deletion**: when #334 lands, its successor extends or
  supersedes this record (ADR admission rules) and the hop table is re-verified against the new
  code.

## Non-goals

- Implementing TLS, certificates or rotation automation (Backlog #334).
- Service-mesh deployment guidance beyond pointing at strict mTLS.
- The external Route's TLS configuration: edge termination with `--insecure-policy=Redirect` is
  operator-side and documented in `deployment/README.md`.
- Changing any token, Secret layout, NetworkPolicy or component configuration.
- Egress restriction for workers and engines (Phase 5, per ADR-025).
