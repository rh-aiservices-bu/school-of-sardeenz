# PoC backing services

This Kustomize base runs the PostgreSQL and Valkey services required by Sardeenz. It is intended
for evaluation and development clusters: both databases are single-replica workloads backed by
`ReadWriteOnce` PVCs, with no automated backup, failover, or upgrade orchestration. Use managed or
operator-managed databases for production.

The in-cluster endpoints are:

| Service    | Application setting                                                                      |
| ---------- | ---------------------------------------------------------------------------------------- |
| Valkey     | `SARDEENZ_REDIS_URL=redis://sardeenz-redis:6379`                                         |
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

Apply the services and wait for both rollouts:

```bash
oc apply -k deployment/prereq/
oc rollout status deployment/sardeenz-postgres -n sardeenz
oc rollout status deployment/sardeenz-redis -n sardeenz
```

This now also creates the `sardeenz` Namespace with the
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
overlay's namespace. Create `sardeenz-postgres-credentials` in that same namespace before
applying it.

The Valkey instance is intentionally passwordless so it matches the current worker and proxy URL.
It is exposed only by a cluster-internal Service, but any Pod able to reach that Service can use it.
Do not treat this as a production security posture.

The PostgreSQL and Valkey claims default to 10 GiB and 5 GiB respectively. Set
`storageClassName` or patch their sizes in an environment overlay when the cluster defaults are
not suitable.
