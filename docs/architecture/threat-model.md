# Threat Model

This page covers the Sardeenz namespace: the four platform components, the worker agents and the
runner processes they launch. It is a map, not a second copy of the decision records — each control
names the mechanism that enforces it and the ADR or issue that owns the reasoning, so drift is
visible. It assumes a single trust domain per namespace and a cluster network administered by
someone trusted; a cluster administrator is outside the model.

## Actors and Trust Levels

| Actor                              | What it can do                                                                                                     | Trust level                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| Inference client                   | Sends `/openai/*` and `/oip/*` requests, streaming or not, with whatever bearer token the ingress gave it            | Untrusted — the proxy authenticates no client                 |
| Dashboard user                     | Admin or admin-readonly via OpenShift OAuth or simple mode; deploys, deletes, sleeps, wakes, stops, starts and moves models, imports catalog entries | Authenticated, role-scoped                                    |
| Workload in the Sardeenz namespace | Any pod that can reach a listener; can attempt Redis writes, routing-map poisoning and control-plane calls           | Untrusted but reachable — bounded by default-deny and tokens  |
| Weights / module-volume writer     | Writes the files runners load or exec                                                                              | Equivalent to code execution on every worker                  |
| Cluster administrator              | Removes the module-guard label, patches NetworkPolicies, binds the SCC, reads Secrets                                | Fully trusted — out of scope                                  |

## Trust Boundaries

| Boundary                              | What crosses it                                     | Enforced by                                                                                                          | Record                                                    |
| ------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Inference client → proxy inference port | Inference requests and the client's `Authorization` header | Optional shared static key (`SARDEENZ_PROXY_INFERENCE_API_KEY`, off by default); otherwise an authenticated ingress is a deployment prerequisite | [#332](https://github.com/rh-aiservices-bu/school-of-sardeenz/issues/332), [`components/proxy.md`](components/proxy.md#optional-inference-api-key) |
| Browser → dashboard BFF               | Admin actions, SSE events                            | OAuth/simple login, JWT cookie, fail-closed startup; the `?token=` fallback is limited to SSE routes                   | [ADR-023](adrs/adr-023-sse-only-query-token-fallback.md)   |
| Dashboard BFF → control plane         | Deploy, wake, eviction and move commands; asserted actor headers | `SARDEENZ_API_TOKEN` bearer, constant-time compare, fail-closed at config load                                        | [ADR-022](adrs/adr-022-fail-closed-service-tokens.md)      |
| Control plane → worker agent          | Runner lifecycle commands                            | `SARDEENZ_WORKER_TOKEN` on every route except `/healthz`                                                              | [ADR-022](adrs/adr-022-fail-closed-service-tokens.md)      |
| Control plane → runner process        | Entrypoint argv, SIF path, runner environment        | `SARDEENZ_RUNNER_ENTRYPOINT` allowlist; `apptainer verify` against the signing key before exec                         | [ADR-024](adrs/adr-024-worker-entrypoint-allowlist.md), [ADR-017](adrs/adr-017-runner-image-pipeline.md) |
| Any pod → any listener in the namespace | Service tokens, inference payloads, Redis and PostgreSQL traffic | Namespace-wide default-deny ingress with one explicit allow per flow; Valkey `requirepass`                             | [ADR-025](adrs/adr-025-namespace-default-deny-ingress.md)  |
| Any pod → module store (writes)       | Runner SIFs and module content                       | Admission policy denies a read-write mount outside the librarian and control-plane ServiceAccounts; imports are digest-validated and signature-verified | [ADR-026](adrs/adr-026-vap-activation-labeled-namespace.md), [ADR-018](adrs/adr-018-runner-catalog-oras-distribution.md) |
| Weights volume → runner               | The model weights the engine loads                   | Pickle-based formats refused by default with a per-model `allowUnsafeWeights` opt-in; no integrity or provenance check | [ADR-032](adrs/adr-032-pickle-weights-refusal.md)          |
| Runner container → host and GPU       | GPU devices, the mounts it is given                  | `sardeenz-sif-runner` SCC: restricted posture with seccomp `Unconfined` and `fsGroup: RunAsAny`, all capabilities dropped, no privilege escalation | [ADR-016](adrs/adr-016-sif-worker-security-posture.md)     |
| Platform images → cluster             | Code that runs as Sardeenz workloads                 | Digest-pinned bases, Trivy CRITICAL gate, keyless cosign; runner SIFs signed and verified at import and exec           | [ADR-030](adrs/adr-030-platform-image-signing-and-scanning.md), [ADR-017](adrs/adr-017-runner-image-pipeline.md) |

## Accepted Risks

| Risk                                                                                                                | Why it is accepted                                                                                              | Record                                                                 |
| ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Inference clients are unauthenticated by the proxy; the repo ships no gateway, so a demo Route is an open endpoint   | An optional shared key closes the port cheaply but carries no per-client identity, quotas or rate limiting; only a gateway enforces per-tenant policy | [#332](https://github.com/rh-aiservices-bu/school-of-sardeenz/issues/332) |
| In-namespace traffic is plaintext — service tokens, inference payloads, Redis and PostgreSQL connections             | NetworkPolicy and bearer tokens give reachability control and authentication, not confidentiality, under the trusted-network assumption | [ADR-031](adrs/adr-031-in-namespace-plaintext-traffic.md), [#334](https://github.com/rh-aiservices-bu/school-of-sardeenz/issues/334) |
| Weights are trusted input — write access to the weights volume, a named `runtimeModule` or `--trust-remote-code` is code execution on a worker | Signing or checksumming weights is out of scope; the format refusal narrows the load path but establishes no provenance | [ADR-032](adrs/adr-032-pickle-weights-refusal.md), [#284](https://github.com/rh-aiservices-bu/school-of-sardeenz/issues/284) |
| One shared bearer token per service, no rotation automation, no per-client tokens or scoping                          | Rotation is an operator procedure; per-caller identity needs a token issuer the platform does not have           | [ADR-022](adrs/adr-022-fail-closed-service-tokens.md), [ADR-013](adrs/adr-013-secrets-management.md) |
| The audit actor is asserted, not proven — any holder of the shared service token can claim any actor name            | Token authentication proves the caller is a service, not who it acts for; the line is for investigation, never an authorization input | [ADR-035](adrs/adr-035-audit-asserted-actor.md) |
| No isolation between runner processes sharing a worker and a GPU; memory figures are device-scope observations       | GPU isolation needs hardware partitioning or per-model nodes, which the platform does not provide                | [ADR-029](adrs/adr-029-colocation-hold-and-pressure-stop.md), [ADR-027](adrs/adr-027-shim-memory-device-scope.md) |
| The proxy trusts the routing map completely — compromising Redis or anything that writes `sardeenz:routing-map` redirects inference traffic, including client bearer tokens, to an arbitrary endpoint | The proxy is a stateless routing layer, not a policy enforcement point; validating routes there would duplicate the control plane | [ADR-025](adrs/adr-025-namespace-default-deny-ingress.md), [`components/proxy.md`](components/proxy.md#security-and-trust-model) |

## Audit and Attribution

Every mutating control-plane request emits exactly one structured line marked `audit: true`, with
the actor, action, target, allowlisted parameters, the outcome and the request id; read paths and
non-`/api/v1` routes are never logged. Dashboard-initiated actions carry the logged-in user, while
direct API callers and the proxy's wake trigger record `service`. The actor is asserted by the
caller, so the line supports investigation and never authorization — accepted risk 5. The field
list, retention guidance and what is deliberately never logged are in
[Deployment Security](../usage/deployment-security.md#audit-log); [ADR-035](adrs/adr-035-audit-asserted-actor.md)
records the decision.

## Non-Goals

- Multi-tenant isolation, per-tenant quotas or client identity between model owners — Sardeenz
  assumes one trust domain per namespace and the proxy has no concept of client identity; tenancy
  belongs to the ingress.
- Authenticating inference clients — delegated to an ingress or gateway; the optional shared key
  ([#332](https://github.com/rh-aiservices-bu/school-of-sardeenz/issues/332)) is not a gateway.
- Encryption in transit inside the namespace — accepted risk 2; native TLS is
  [#334](https://github.com/rh-aiservices-bu/school-of-sardeenz/issues/334).
- Weights signing or checksumming — [ADR-032](adrs/adr-032-pickle-weights-refusal.md);
  [#284](https://github.com/rh-aiservices-bu/school-of-sardeenz/issues/284) is placement, not
  provenance.
- A Postgres audit table or a dashboard audit view — structured logs only
  ([ADR-035](adrs/adr-035-audit-asserted-actor.md)).
- Advisory scanning of the shipped SIF and runtime trees — #182 and #338 audit the CI install path
  only.
- Protection from a cluster administrator: every control above is administratively reversible.
