# PoC backing services

This Kustomize base runs the PostgreSQL and Valkey services required by Sardeenz. It is intended
for evaluation and development clusters: both databases are single-replica workloads backed by
`ReadWriteOnce` PVCs, with no automated backup, failover, or upgrade orchestration. Use managed or
operator-managed databases for production.

The in-cluster endpoints are:

| Service    | Application setting                                                                      |
| ---------- | ---------------------------------------------------------------------------------------- |
| Valkey     | `SARDEENZ_REDIS_URL=redis://:<password>@sardeenz-redis:6379`                             |
| PostgreSQL | `SARDEENZ_DATABASE_URL=postgresql://sardeenz:<password>@sardeenz-postgres:5432/sardeenz` |

## Install

Create the target namespace if it does not already exist, then create the PostgreSQL credentials.
Generate a URL-safe password so the same value can be placed directly in the database connection
URL later without percent-encoding:

```bash
oc new-project sardeenz # needed for the secret below when sardeenz does not exist yet; the apply step below also creates and labels it

set +x
POSTGRES_PASSWORD="$(openssl rand -hex 24)"
oc create secret generic sardeenz-postgres-credentials \
  --from-literal=POSTGRESQL_USER=sardeenz \
  --from-literal=POSTGRESQL_PASSWORD="$POSTGRES_PASSWORD" \
  --from-literal=POSTGRESQL_DATABASE=sardeenz \
  --from-literal=SARDEENZ_DATABASE_URL="postgresql://sardeenz:${POSTGRES_PASSWORD}@sardeenz-postgres:5432/sardeenz" \
  -n sardeenz
unset POSTGRES_PASSWORD
```

Valkey requires authentication: generate a hex password (URL-safe, so it can be embedded in the
connection URL without percent-encoding) and create the `sardeenz-redis-credentials` Secret —
`REDIS_PASSWORD` is consumed by the Valkey container and its probes, `SARDEENZ_REDIS_URL` by the
control plane, proxy, dashboard and worker (values live in Secrets, never in manifests —
[ADR-013](../../docs/architecture/adrs/adr-013-secrets-management.md)):

```bash
set +x
REDIS_PASSWORD="$(openssl rand -hex 24)"
oc create secret generic sardeenz-redis-credentials \
  --from-literal=REDIS_PASSWORD="$REDIS_PASSWORD" \
  --from-literal=SARDEENZ_REDIS_URL="redis://:${REDIS_PASSWORD}@sardeenz-redis:6379" \
  -n sardeenz
unset REDIS_PASSWORD
```

Always create the Secret with the command above: the Valkey image validates `REDIS_PASSWORD`
at startup and the container exits when the value is empty or invalid, and both keys must come
from the same generated value. Regenerating the Secret requires the rotation steps below.

Apply the services and wait for both rollouts:

```bash
oc apply -k deployment/prereq/
oc rollout status deployment/sardeenz-postgres -n sardeenz
oc rollout status deployment/sardeenz-redis -n sardeenz
```

The default-deny takes effect as soon as this base is applied: apply the full stack, or apply
the component kustomization bases (control-plane, proxy, dashboard, sif-runner) that carry the
allow policies together with this base, so un-allowed flows are not dropped in the window
between applies.

Applying this base also creates the `sardeenz` Namespace with the
`sardeenz.io/module-guard: enforce` label that activates module-PVC write protection
(see [`../sif-runner/`](../sif-runner/)). Verify:

```bash
oc get namespace sardeenz -o jsonpath='{.metadata.labels.sardeenz\.io/module-guard}{"\n"}'
# -> enforce
```

If the Namespace document is applied over a namespace that already exists but was created
outside this stack, `oc apply -k` can fail with a field-ownership conflict on `metadata.labels`.
Do not retry with a full-base `--force-conflicts` apply: it would target this base's `sardeenz`
namespace even when you are installing an overlay into a different one, and it would seize field
ownership of fields the overlay legitimately patches (PVC `storageClassName`, sizes, Deployment
fields), silently reverting them. Instead, apply the label directly to the target namespace —
this is also the explicit opt-out when the trailing `-` is used:

```bash
oc label namespace <namespace> sardeenz.io/module-guard=enforce --overwrite
```

The next `oc apply -k` then records the namespace cleanly. Note that the Namespace is part of
the rendered stack: `oc delete -k deployment/prereq/` (or GitOps pruning) deletes the namespace
and cascades to the PostgreSQL and Valkey PVCs and their data. Exclude the Namespace from the
overlay if it must live outside the stack lifecycle.

For another namespace, include `../../prereq` in an environment overlay whose `namespace:` field
sets the target — the transformer renames the rendered Namespace object (and its labels) to the
overlay's namespace. Create `sardeenz-postgres-credentials` **and `sardeenz-redis-credentials`**
in that same namespace before applying it.

Valkey runs with `requirepass` set from the `sardeenz-redis-credentials` Secret (the container
reads it via the image's `VALKEY_PASSWORD` support), and the namespace default-deny
NetworkPolicy in this directory restricts which pods may reach it. Rotate by recreating the
Secret, then restart the store and every consumer — all five read their credentials as
environment variables at process start, so pods that are not restarted keep the old password
and fail AUTH:

```bash
oc rollout restart deployment/sardeenz-redis deployment/sardeenz-control-plane \
  deployment/sardeenz-proxy deployment/sardeenz-dashboard deployment/sardeenz-worker -n sardeenz
```

The PostgreSQL and Valkey claims default to 10 GiB and 5 GiB respectively. Set
`storageClassName` or patch their sizes in an environment overlay when the cluster defaults are
not suitable.

## Bumping the prereq images

Both Deployments pin their image as `name:dated-tag@sha256:<64 hex>` — the manual-bump form of
[ADR-030 decision 1](../../docs/architecture/adrs/adr-030-platform-image-signing-and-scanning.md)
(the date is the sclorg build date, not the date of our bump), and the digest is the multi-arch
**index** digest. The tag stays in front of the digest so a reader can see which snapshot is pinned;
`latest@sha256:…` is reproducible but reads as automation this repository does not have.

Dependabot has no ecosystem for raw Kubernetes manifests — its `docker` entries are keyed on build
directories (`.github/dependabot.yml`) — so this is a manual step. List the available dated tags,
then resolve the chosen tag's index digest:

```bash
curl -s "https://quay.io/api/v1/repository/sclorg/valkey-8-c10s/tag/?limit=5&onlyActiveTags=true" \
  | jq -r '.tags[].name'
curl -s "https://quay.io/api/v1/repository/sclorg/valkey-8-c10s/tag/?specificTag=20261125&onlyActiveTags=true" \
  | jq -r '.tags[0] | "\(.manifest_digest) list=\(.is_manifest_list)"'
curl -s "https://quay.io/api/v1/repository/sclorg/postgresql-16-c9s/tag/?specificTag=20261125&onlyActiveTags=true" \
  | jq -r '.tags[0] | "\(.manifest_digest) list=\(.is_manifest_list)"'
# or: skopeo inspect --format '{{.Digest}}' docker://quay.io/sclorg/valkey-8-c10s:20261125
```

Edit the `image:` line in `valkey-deployment.yaml` / `postgres-deployment.yaml` with the new tag and
its `sha256:` digest, then `oc apply -k deployment/prereq/` and confirm the rollout picks the pinned
reference. `imagePullPolicy: IfNotPresent` is intentional with an immutable digest: nodes never
re-resolve the reference, so the running bytes are the pinned ones.
`tests/container-images/verify-dependabot-coverage.mjs` (`make verify-dependabot-coverage`, a step of
the CI `quality` job) fails when a `:latest` or digest-less reference reappears under this
directory.
