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
  `sardeenz-worker` SA/Deployment, `sardeenz-modules`/`sardeenz-weights` PVCs).
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
├── prereq/                 # PoC PostgreSQL + Valkey backing services
├── proxy/                  # routing proxy Deployment and inference/admin Services
├── sif-runner/             # worker security posture + worker Deployment (Task 8)
└── librarian/              # SIF build/sign/convert Job + signing keys (Task 7)
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

oc create secret generic sardeenz-postgres-credentials \
  --from-literal=POSTGRESQL_USER=sardeenz \
  --from-literal=POSTGRESQL_PASSWORD="$POSTGRES_PASSWORD" \
  --from-literal=POSTGRESQL_DATABASE=sardeenz \
  --from-literal=SARDEENZ_DATABASE_URL="postgresql://sardeenz:${POSTGRES_PASSWORD}@sardeenz-postgres:5432/sardeenz" \
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
unset POSTGRES_PASSWORD API_TOKEN WORKER_TOKEN ADMIN_PASSWORD JWT_SECRET
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
```

Apply the full stack and activate module-PVC write protection:

```bash
oc apply -k deployment/overlays/school-of-sardeenz/
oc label namespace "$SARDEENZ_NAMESPACE" sardeenz.io/module-guard=enforce

oc rollout status deployment/sardeenz-postgres -n "$SARDEENZ_NAMESPACE"
oc rollout status deployment/sardeenz-redis -n "$SARDEENZ_NAMESPACE"
oc rollout status deployment/sardeenz-control-plane -n "$SARDEENZ_NAMESPACE"
oc rollout status deployment/sardeenz-proxy -n "$SARDEENZ_NAMESPACE"
oc rollout status deployment/sardeenz-dashboard -n "$SARDEENZ_NAMESPACE"
oc rollout status deployment/sardeenz-worker -n "$SARDEENZ_NAMESPACE"
```

The worker requests one GPU and will remain Pending until a suitable node is available. Patch
image tags/digests, PVC StorageClasses, capacities, replicas, and resources in the local overlay
for the target cluster.

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

See [`docs/usage/deployment-security.md`](../docs/usage/deployment-security.md) before exposing the
stack outside a trusted evaluation environment.
