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
oc new-project sardeenz # omit if it already exists

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

For another namespace, include `../../prereq` in an environment overlay whose `namespace:` field
sets the target. Create `sardeenz-postgres-credentials` in that same namespace before applying it.

The Valkey instance is intentionally passwordless so it matches the current worker and proxy URL.
It is exposed only by a cluster-internal Service, but any Pod able to reach that Service can use it.
Do not treat this as a production security posture.

The PostgreSQL and Valkey claims default to 10 GiB and 5 GiB respectively. Set
`storageClassName` or patch their sizes in an environment overlay when the cluster defaults are
not suitable.
