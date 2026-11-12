# ADR-025: The Namespace Ships Default-Deny Ingress; Every Flow Needs an Explicit Allow

## Status

Accepted. Implemented in M15 ([#230](https://github.com/rh-aiservices-bu/school-of-sardeenz/issues/230),
merged `46f204d`). Flow table and caveats live in
[`docs/usage/deployment-security.md`](../../usage/deployment-security.md).

## Context

Before M15, the cluster manifested per-component allow policies only (control plane and worker
from #108). Redis — which holds the routing map, worker reports and claims — was reachable by any
pod in the namespace, so any pod could poison a `RoutingEntry` and make the proxy forward
inference traffic, including client bearer tokens, to an attacker-controlled host. Valkey was
also passwordless. Partial allow-lists do not bound the attack surface: anything unlisted is
reachable, and a missing rule fails open.

## Decision

1. **Namespace-wide default-deny ingress** (`deployment/prereq/networkpolicy.yaml`: empty
   `podSelector`, `policyTypes: [Ingress]`, no ingress rules). Egress stays unrestricted (Phase 5
   territory).
2. **Every in-cluster flow carries an explicit allow rule**, in the base that owns the
   destination: redis 6379 ← control plane, proxy, dashboard BFF, worker; postgres 5432 ← control
   plane; proxy 8080 ← platform router **and** the dashboard BFF's in-cluster Playground chat
   forwarding; proxy admin 9099 ← the monitoring namespace; dashboard 4000 ← platform router;
   control plane 3000 and worker ports keep their existing policies. The authoritative flow table
   is `docs/usage/deployment-security.md`.
3. **Router ingress uses the documented OpenShift form**
   (`namespaceSelector: policy-group.network.openshift.io/ingress: ""`, OVN-Kubernetes); clusters
   whose router namespace carries the SDN-era label patch the selector in an overlay.
4. **AUTH complements isolation, it does not replace it.** Valkey requires `requirepass` from the
   operator-created `sardeenz-redis-credentials` Secret and all four `SARDEENZ_REDIS_URL`
   consumers source it via `secretKeyRef`. NetworkPolicy limits *who can reach* 6379; AUTH stops
   *anyone who still can*.

## Consequences

- **A new listener or caller pair is unreachable by default.** The deployer must add an allow rule
  or debug a 504/timeout that looks like an application bug. The flow table is the checklist.
- The default-deny takes effect as soon as the prereq base is applied: apply the full stack (or
  the component bases carrying allow policies) in the same rollout.
- **Traps.** Forgetting the ingress-namespace selector form breaks router traffic silently;
  forgetting that dashboard-BFF → proxy chat forwarding is an in-cluster flow 504s the Playground
  (caught twice in review); NetworkPolicy labels are self-chosen pod labels, not workload
  identity — the dedicated-namespace/RBAC caveat in the security guide is load-bearing (a
  spoofable `app.kubernetes.io/name` impersonates a source).
- Kubelet probes and `oc port-forward` are node-originated and unaffected by pod policies.
- The librarian needs no ingress rule (egress only); the default-deny simply denies it inbound.

## Non-goals

- Egress restriction for workers and engines (Phase 5).
- Service mesh / mTLS identity.
