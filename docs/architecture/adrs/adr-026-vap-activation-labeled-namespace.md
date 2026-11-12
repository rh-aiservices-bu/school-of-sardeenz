# ADR-026: The VAP Module-Guard Activates by Shipping the Labeled Namespace

## Status

Accepted. Implemented in M15 ([#232](https://github.com/rh-aiservices-bu/school-of-sardeenz/issues/232),
merged `46f204d`). Completes the write-protection mechanism choice
[ADR-017](adr-017-runner-image-pipeline.md) deferred ("Phase 4 picks and records one").

## Context

ADR-017 requires that only the librarian may write the module store; the chosen mechanism is a
`ValidatingAdmissionPolicy` + binding that denies any pod mounting the `sardeenz-modules` PVC
read-write unless it runs as an exempt ServiceAccount. The binding selects namespaces by label
(`sardeenz.io/module-guard: enforce`), and nothing in the kustomizations created or labeled the
namespace — a stock `kustomize build | oc apply` installed a policy that matched nothing, while
the runbooks asked the operator to `oc label namespace` by hand. Protection shipped inert by
default; a forgotten label meant no admission control at all.

## Decision

1. **`deployment/prereq/` renders the `Namespace/sardeenz` object** carrying
   `app.kubernetes.io/part-of: sardeenz` and `sardeenz.io/module-guard: enforce`, as the first
   resource. A stock `oc apply -k deployment/` (or an overlay whose `namespace:` field renames the
   object) activates the binding on first apply.
2. **Opting out becomes the explicit act** — removing the label — not the forgotten default.
   The runbooks changed from "apply the label" to "verify the label".
3. **The kustomize `namespace:` field remains the naming mechanism**; the resource only adds
   creation and labels. The CEL/validation logic and the binding's `namespaceSelector` are
   unchanged.
4. **Field-ownership conflicts get a direct remedy**: applying the label to the target namespace
   (`oc label namespace <ns> sardeenz.io/module-guard=enforce --overwrite`) rather than retrying a
   whole kustomization with `--force-conflicts`, which targets the base's namespace even on
   overlay installs and seizes ownership of overlay-patched fields (PVC class/size, Deployment
   fields).

## Consequences

- Module-store write protection is on by default; a pod mounting the module PVC read-write without
  the librarian or control-plane ServiceAccount is denied at admission (`The sardeenz-modules PVC
  must be mounted readOnly…`).
- **Traps.** Kustomize `labels:`/`commonLabels` transformers label *resources*, not the Namespace
  object — they cannot activate a `namespaceSelector` (rejected approach). The Namespace is now
  render-owned: `oc delete -k` or GitOps pruning deletes the namespace and cascades both database
  PVCs — exclude the resource from an overlay if the namespace must outlive the stack. The label
  is only as strong as RBAC controlling who may patch the Namespace object (and the policy exempts
  by ServiceAccount name, so pod-create rights in the namespace must be equally tight).
- Admission requires OpenShift 4.17+ / Kubernetes 1.30+; on older clusters the binding is rejected
  at apply time and no protection exists.
- Operator-facing description (exempt ServiceAccounts, opt-out command, floor) lives in
  `docs/usage/deployment-security.md`.

## Non-goals

- Changing the CEL logic or the binding's selector values.
- Extending the guard to other PVCs (weights, scratch).
