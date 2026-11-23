# deployment/

Kubernetes/OpenShift manifests for Sardeenz.

## Manifest format (decision)

**Kustomize, raw YAML bases.** These are the repo's first cluster manifests, so the convention is
set here:

- **Kustomize** (not Helm) — bases under `deployment/<component>/`, overlaid per environment. Helm
  is not adopted anywhere in the repo; avoid it unless that changes.
- **Plain YAML** resources, one file per resource kind where practical, aggregated by a
  `kustomization.yaml`.
- **Namespace:** set by the overlay via `kustomization.yaml` `namespace:` (bases are
  namespace-light). Default `sardeenz`.
- **Naming:** all resources are prefixed `sardeenz-` (e.g. `sardeenz-sif-runner` SCC,
  `sardeenz-worker` SA/Deployment, `sardeenz-modules`/`sardeenz-weights` PVCs); the exception is
  the `sardeenz` Namespace object itself (see `prereq/`).
- **Cluster prerequisites** (self-managed OpenShift/OKD **4.15+**, tested on 4.21): `crun`
  runtime, a shared RWX StorageClass, rights to create a custom SCC, and the
  `io.kubernetes.cri-o.Devices: "/dev/fuse"` pod annotation (no device plugin on 4.15+).

## Layout

```
deployment/
├── kustomization.yaml      # full PoC stack composition
├── README.md               # install and configuration guide
├── control-plane/          # API Deployment, Service, Lease RBAC, catalog mounts, policy
├── dashboard/              # React frontend + BFF Deployment and Service
├── prereq/                 # Namespace + PoC PostgreSQL + Valkey backing services
├── proxy/                  # routing proxy Deployment and inference/admin Services
├── sif-runner/             # worker security posture + worker Deployment (Task 8)
├── librarian/              # SIF build/sign/convert Job + signing keys (Task 7)
└── monitoring/             # ServiceMonitors for OpenShift user-workload monitoring
```

Each directory is independently deployable. The root Kustomization composes the full PoC stack;
the Librarian's parameterized publishing Job remains a separately processed Template.

## Full PoC installation

These manifests provide single-replica PostgreSQL and Valkey instances for evaluation. They are
not an HA production database design. Before applying, choose a namespace and create the required
Secrets out of band:

```bash
SARDEENZ_NAMESPACE=school-of-sardeenz
oc new-project "$SARDEENZ_NAMESPACE" # omit if it already exists

set +x
POSTGRES_PASSWORD="$(openssl rand -hex 24)"
API_TOKEN="$(openssl rand -hex 32)"
WORKER_TOKEN="$(openssl rand -hex 32)"
ADMIN_PASSWORD="$(openssl rand -hex 24)"
JWT_SECRET="$(openssl rand -hex 32)"
REDIS_PASSWORD="$(openssl rand -hex 24)"

oc create secret generic sardeenz-postgres-credentials \
  --from-literal=POSTGRESQL_USER=sardeenz \
  --from-literal=POSTGRESQL_PASSWORD="$POSTGRES_PASSWORD" \
  --from-literal=POSTGRESQL_DATABASE=sardeenz \
  --from-literal=SARDEENZ_DATABASE_URL="postgresql://sardeenz:${POSTGRES_PASSWORD}@sardeenz-postgres:5432/sardeenz" \
  -n "$SARDEENZ_NAMESPACE"

oc create secret generic sardeenz-redis-credentials \
  --from-literal=REDIS_PASSWORD="$REDIS_PASSWORD" \
  --from-literal=SARDEENZ_REDIS_URL="redis://:${REDIS_PASSWORD}@sardeenz-redis:6379" \
  -n "$SARDEENZ_NAMESPACE"

oc create secret generic sardeenz-service-tokens \
  --from-literal=SARDEENZ_API_TOKEN="$API_TOKEN" \
  --from-literal=SARDEENZ_WORKER_TOKEN="$WORKER_TOKEN" \
  -n "$SARDEENZ_NAMESPACE"

oc create secret generic sardeenz-dashboard-auth \
  --from-literal=AUTH_MODE=simple \
  --from-literal=ADMIN_USERNAME=admin \
  --from-literal=ADMIN_PASSWORD="$ADMIN_PASSWORD" \
  --from-literal=JWT_SECRET="$JWT_SECRET" \
  -n "$SARDEENZ_NAMESPACE"

# Store the generated admin password securely before clearing these shell variables.
unset POSTGRES_PASSWORD API_TOKEN WORKER_TOKEN ADMIN_PASSWORD JWT_SECRET REDIS_PASSWORD
```

Real registry credentials remain in `sardeenz-librarian-registry`, created as described in
[`librarian/README.md`](librarian/README.md). The control plane also uses that Docker configuration
when importing from a private ORAS catalog repository.

The checked-in bases default to namespace `sardeenz`. For another namespace, create a local,
untracked overlay such as:

```yaml
# deployment/overlays/school-of-sardeenz/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

namespace: school-of-sardeenz

resources:
  - ../../prereq
  - ../../control-plane
  - ../../proxy
  - ../../dashboard
  - ../../sif-runner
  - ../../librarian
  - ../../monitoring # ServiceMonitors; see deployment/dashboard/README.md
```

Apply the full stack:

```bash
oc apply -k deployment/overlays/school-of-sardeenz/
# Module write-protection ships active (Namespace resource in prereq/). Verify:
oc get namespace "$SARDEENZ_NAMESPACE" -o jsonpath='{.metadata.labels.sardeenz\.io/module-guard}{"\n"}'
# -> enforce

oc rollout status deployment/sardeenz-postgres -n "$SARDEENZ_NAMESPACE"
oc rollout status deployment/sardeenz-redis -n "$SARDEENZ_NAMESPACE"
oc rollout status deployment/sardeenz-control-plane -n "$SARDEENZ_NAMESPACE"
oc rollout status deployment/sardeenz-proxy -n "$SARDEENZ_NAMESPACE"
oc rollout status deployment/sardeenz-dashboard -n "$SARDEENZ_NAMESPACE"
oc rollout status deployment/sardeenz-worker -n "$SARDEENZ_NAMESPACE"
```
If applying over a namespace that already exists fails with a field-ownership conflict on the
Namespace's `metadata.labels`, apply the label directly
(`oc label namespace "$SARDEENZ_NAMESPACE" sardeenz.io/module-guard=enforce --overwrite`) rather
than retrying a whole kustomization with `--force-conflicts`, which can seize ownership of fields
your overlay patches. The next `oc apply -k` then records the namespace cleanly.

The worker requests one GPU and will remain Pending until a suitable node is available. Patch
image tags/digests, PVC StorageClasses, capacities, replicas, and resources in the local overlay
for the target cluster.

## Platform image publishing and rollout

The checked-in bases run `:latest` for the four platform workloads (proxy, control-plane,
dashboard, worker); `worker-base` is a build input for the worker image, not a workload. A release
is therefore two moves: publish a tag, then pin it per environment and roll the pods out. How CI
builds and pushes the five platform images (secrets, robot, build order) is documented in
[`containers/README.md`](../containers/README.md#publishing-platform-images-from-github); this
section is the operator half.

### What CI publishes

- `.github/workflows/publish-images.yml` runs on every merge to `dev`, builds **only the impacted**
  images, and tags each with the merge commit's 7-char sha (`${SHA::7}` — the `git log --oneline`
  form, e.g. `sardeenz-proxy:5bb4090`). It never pushes `:latest`.
- `.github/workflows/publish-platform-images.yml` is manual and applies **one tag to all five**
  platform images (proxy, control-plane, dashboard, worker-base, worker) from the chosen ref; this
  is the only way `:latest` is produced. Build order and digest pairing are documented in
  [`containers/README.md`](../containers/README.md#publishing-platform-images-from-github); the
  path→image impact map is the header comment of `.github/workflows/publish-images.yml`.
- Consequence: pin in the overlay — never edit the base's `:latest`.

### Publish a release

```bash
# the recurring case: refresh the moving tag the bases follow
gh workflow run publish-platform-images.yml --ref dev -f tag=latest

# seed all five images at one git sha (e.g. a release commit) so one overlay pin covers the stack
gh workflow run publish-platform-images.yml --ref dev -f tag=<sha>
```

`-f tag=` is validated as an OCI tag; any tag you intend to pin works (`latest`, a 7-char sha, a
release tag such as `0.2.0`). `-f tag=<sha>` publishes **only** that sha tag: it does not move
`latest`, which matters for the worker-base prerequisite under "Prerequisites and failure modes".
Re-running replaces the tag; the digest may change when the rebuilt manifest differs (digests are
content-addressed), which is why a settled release pins the digest. With `imagePullPolicy: Always`,
the next rollout picks up whatever the tag now points at (see "Roll out").

### Pin a tag or digest

Pin in the environment overlay's `kustomization.yaml` with Kustomize's `images:` transformer. `name`
is the tag-less image name as written in the base; `newTag` and `digest` are mutually exclusive per
entry (`name` applies to every workload that uses that repository — the four platform repositories
are distinct, so give one entry each):

```yaml
# deployment/overlays/<env>/kustomization.yaml
images:
  - name: quay.io/rh-aiservices-bu/sardeenz-proxy
    newTag: "5bb4090"          # a sha tag publish-images.yml already pushed
  - name: quay.io/rh-aiservices-bu/sardeenz-control-plane
    digest: sha256:<manifest-list-digest>
```

A `newTag` is convenient while following a sha; a `digest` is what makes a rollout reproducible
once the tag is settled (the tag/digest guidance is in
[`containers/README.md`](../containers/README.md#canonical-quay-repositories)). The images are
manifest lists (a `linux/amd64` image plus an attestation), so pin the **list/index** digest:

```bash
skopeo inspect --format '{{.Digest}}' docker://quay.io/rh-aiservices-bu/sardeenz-proxy:<tag>

# cluster tooling only: --filter-by-os makes a manifest list readable; .listDigest is the index
# digest the `digest:` field wants (.image is null)
oc image info quay.io/rh-aiservices-bu/sardeenz-proxy:<tag> \
  --filter-by-os=linux/amd64 -o json | jq -r .listDigest
```

`skopeo inspect` is the same form [`docs/usage/runner-catalog.md`](../docs/usage/runner-catalog.md)
uses for runner images; the Quay UI/API shows the same manifest digest. Without `--filter-by-os`,
`oc image info` errors on a manifest list.

One caveat: the bases set `imagePullPolicy: Always`, which needs registry reachability at pod start.
For an air-gapped cluster, pin a `digest` and set `imagePullPolicy: IfNotPresent` on that workload in
the same overlay (patch it, or add a second overlay layer).

### Roll out

Apply the overlay; a changed tag or digest changes the Pod template, so the rollout starts by
itself:

```bash
oc apply -k deployment/overlays/<env>/
```

A same-tag republish leaves `oc apply -k` a no-op, so restart the four platform Deployments
instead:

```bash
oc rollout restart deployment/sardeenz-proxy deployment/sardeenz-control-plane \
  deployment/sardeenz-dashboard deployment/sardeenz-worker -n "$SARDEENZ_NAMESPACE"
```

With `Always` the new pods re-resolve the tag; under the old `IfNotPresent` a restart alone could
bring back the node-cached image, which is why the policy changed. Then verify the rollout and the
image reference the pods were created from:

```bash
oc rollout status deployment/sardeenz-proxy -n "$SARDEENZ_NAMESPACE" --timeout=5m
oc rollout status deployment/sardeenz-control-plane -n "$SARDEENZ_NAMESPACE" --timeout=5m
oc rollout status deployment/sardeenz-dashboard -n "$SARDEENZ_NAMESPACE" --timeout=5m
oc rollout status deployment/sardeenz-worker -n "$SARDEENZ_NAMESPACE" --timeout=5m

oc get pod -l app.kubernetes.io/name=sardeenz-proxy -n "$SARDEENZ_NAMESPACE" \
  -o jsonpath='{range .items[*]}{range .status.containerStatuses[*]}{.image}{"\n"}{end}{end}'
```

For a digest pin, `.image` prints the `@sha256:` reference from the overlay and pod template.
`oc describe pod`'s `Image ID` is the runtime's local image ID (the image config digest), not the
registry manifest digest, so do not compare it with `skopeo inspect`; for a tag follow, the evidence
is that the pod is newly created after the restart and `Always` forced a registry re-resolve.

For a one-off patch there is an imperative alternative (`oc apply -k` overwrites it on the next
run, so the overlay remains the declarative path):

```bash
oc set image deployment/sardeenz-proxy proxy=quay.io/rh-aiservices-bu/sardeenz-proxy:<tag> \
  -n "$SARDEENZ_NAMESPACE"
```

Plan for disruption: `sardeenz-control-plane` and `sardeenz-worker` are `strategy: Recreate`
(control plane: `/readyz` gates on the leader Lease and a single replica means a surge pod could
never become Ready; worker: it holds an exclusive GPU). A worker rollout terminates **every runner
on that worker**; the 60 s `terminationGracePeriodSeconds` drains in-flight runners (the agent
SIGTERMs each runner, which drains vLLM). Restart the worker when model disruption is acceptable, or
stop models first through the control plane. The proxy and dashboard use the default RollingUpdate
with one replica: the replacement pod starts alongside the old one (the default `maxSurge` rounds
up to one pod), must pass its readiness probe, and only then is the old pod removed — a
readiness-gated handover with no planned outage, subject to the image pull succeeding.

### Prerequisites and failure modes

**`worker-base:latest` must exist.** The per-merge worker job builds `FROM worker-base:<sha7>` when
the base was rebuilt in the same run, otherwise it resolves `worker-base:latest`
(`.github/workflows/publish-images.yml`, "Resolve worker-base digest"). A worker-only merge
therefore fails at that step when `:latest` has never been published. Seed it once (and again after
any base change you want worker-only merges to pair with):

```bash
gh workflow run publish-platform-images.yml --ref dev -f tag=latest
```

`-f tag=<sha>` does **not** satisfy this — it writes the sha tag only. Check:

```bash
skopeo inspect --format '{{.Digest}}' \
  docker://quay.io/rh-aiservices-bu/sardeenz-worker-base:latest
```

**A tag or digest that does not exist.** Kustomize never contacts the registry, so `oc apply -k`
and the render succeed; at the cluster the Pod goes `ErrImagePull` → `ImagePullBackOff`. A plain
`oc rollout status` never returns on that rollout (`--timeout=0s`, the default, waits forever); with
the `--timeout=5m` from "Roll out" above it blocks until the timeout and then reports failure. There
is no fallback to another tag — fix the overlay and re-apply.

**A sha tag that was never published.** The per-merge workflow only builds impacted images, so the
merge a sha comes from may not have touched every component. Publish all five at that sha, then pin
it:

```bash
gh workflow run publish-platform-images.yml --ref dev -f tag=<sha>
```

**Air-gapped / unreachable registry.** With `imagePullPolicy: Always`, pod start needs registry
reachability — see the caveat under "Pin a tag or digest".

This covers the platform images. Runner images and SIFs are a different pipeline: the republish
runbook is "Republishing a runner and recording its shim source" in
[`docs/usage/runner-catalog.md`](../docs/usage/runner-catalog.md#republishing-a-runner-and-recording-its-shim-source)
and "Republishing the vLLM runner (shim provenance)" in
[`deployment/librarian/README.md`](librarian/README.md#republishing-the-vllm-runner-shim-provenance).
Deploy-only checks (real re-resolution, `ImagePullBackOff` timing, the image-reference check, worker
restart disruption) are proved by the first rollout after a republish; nothing in this section can
be exercised in the dev container.

## Unsigned PoC runners

The checked-in control-plane and worker bases verify SIF signatures. If the Librarian published
unsigned artifacts for the current PoC, disable verification explicitly on both consumers before
importing or running them:

```bash
oc set env deployment/sardeenz-control-plane SARDEENZ_VERIFY_SIF=false \
  -n "$SARDEENZ_NAMESPACE"
oc set env deployment/sardeenz-worker SARDEENZ_VERIFY_SIF=false \
  -n "$SARDEENZ_NAMESPACE"
```

Restore verification before using signed production artifacts.

## External access

Never expose the control plane, proxy admin Service, worker agent, or runner ports. On OpenShift,
create edge-terminated Routes for the dashboard and, when direct inference access is required, the
proxy's inference Service:

```bash
oc create route edge sardeenz-dashboard --service=sardeenz-dashboard --port=http \
  --insecure-policy=Redirect -n "$SARDEENZ_NAMESPACE"
oc create route edge sardeenz-proxy --service=sardeenz-proxy --port=inference \
  --insecure-policy=Redirect -n "$SARDEENZ_NAMESPACE"

DASHBOARD_URL="https://$(oc get route sardeenz-dashboard \
  -n "$SARDEENZ_NAMESPACE" -o jsonpath='{.spec.host}')"
oc set env deployment/sardeenz-dashboard SARDEENZ_PUBLIC_URL="$DASHBOARD_URL" \
  -n "$SARDEENZ_NAMESPACE"
```

The shipped NetworkPolicies allow Route traffic to the dashboard and (if created) the proxy
inference Service; the control plane, proxy admin Service, worker agent, and runner ports have
no router/external ingress rule — they are reachable only from the in-cluster sources listed in
[`docs/usage/deployment-security.md`](../docs/usage/deployment-security.md).

See [`docs/usage/deployment-security.md`](../docs/usage/deployment-security.md) before exposing the
stack outside a trusted evaluation environment.
