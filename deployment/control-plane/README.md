# deployment/control-plane

Deploys the control-plane API, its cluster-internal Service, leader-election RBAC, NetworkPolicy,
and runner-catalog storage mounts. PostgreSQL, Valkey, the two service tokens, and the shared SIF
runner PVCs must exist before the Pod becomes ready; the complete installation order is documented
in [`../README.md`](../README.md).

The control plane applies its SQL migrations at startup. It uses a Kubernetes Lease in its own
namespace, even when deployed with one replica, so `SARDEENZ_LEASE_NAMESPACE` comes from the Pod's
namespace and the ServiceAccount has narrowly scoped Lease permissions. `NODE_EXTRA_CA_CERTS`
points Node.js at the mounted service-account CA so its direct Kubernetes API requests validate
the API server certificate.

## Apply

After creating `sardeenz-postgres-credentials` and `sardeenz-service-tokens`, apply this component
with its backing services and PVCs already installed:

```bash
oc apply -k deployment/control-plane/
oc rollout status deployment/sardeenz-control-plane -n sardeenz
```

Keep `sardeenz-control-plane:3000` cluster-internal. The NetworkPolicy admits only the proxy and
dashboard Pods.

## What the import path needs

The control plane loads the runner catalog and, on **Import**, pulls the SIF onto the shared module
store itself (no Kubernetes Job — so it works identically under Podman/VM). This requires:

1. **Read-write access to the module store.** The control-plane Pod mounts the `sardeenz-modules`
   PVC **read-write** (workers mount it read-only). On a Podman/VM deployment this is just a
   read-write bind mount of the shared directory into the control-plane container.
2. **The `sardeenz-control-plane` ServiceAccount.** The module-PVC write-protection
   ValidatingAdmissionPolicy ([`../sif-runner/module-pvc-write-protection.yaml`](../sif-runner/module-pvc-write-protection.yaml))
   exempts exactly two writers — `sardeenz-librarian` and `sardeenz-control-plane`. Run the
   control-plane Pod under that SA or the rw mount will be denied.
3. **Apptainer in the image** (when signature verification is enabled).
   `containers/control-plane/Dockerfile` installs the unprivileged CLI. The control plane streams
   the OCI layer itself and uses Apptainer only to verify the completed SIF, so no special SCC is
   needed.
4. **Registry credentials for private artifacts.** Mount a Docker-format auth file and set
   `APPTAINER_AUTH_FILE` to its path. The checked-in Deployment mounts
   `sardeenz-librarian-registry` read-only for this purpose.
5. **The SIF signing public key** (when `SARDEENZ_VERIFY_SIF=true`, the default) so
   `apptainer verify` trusts pulled SIFs — same `sardeenz-sif-signing-pubkey` ConfigMap the workers
   use ([`../librarian/`](../librarian/)).

## Environment

| Var                           | Purpose                                                           | Default                                   |
| ----------------------------- | ----------------------------------------------------------------- | ----------------------------------------- |
| `SARDEENZ_RUNNER_CATALOG_URL` | Catalog source (http(s) URL or local file / `file://`)            | the official `school-of-sardeenz` raw URL |
| `SARDEENZ_MODULES_DIR`        | Module store mount path                                           | `/modules`                                |
| `SARDEENZ_SIF_IMPORTER`       | `oras` (OCI SIF stream) or `stub` (dev placeholder)               | `stub`                                    |
| `SARDEENZ_APPTAINER_BIN`      | apptainer binary                                                  | `apptainer`                               |
| `SARDEENZ_VERIFY_SIF`         | `apptainer verify` pulled SIFs before publishing                  | `true`                                    |
| `APPTAINER_AUTH_FILE`         | Docker-format credentials for private OCI registries              | unset (public registries only)            |

Set `SARDEENZ_SIF_IMPORTER=oras` in production; leave it unset (`stub`) for local dev / CI where
apptainer isn't installed. For local dev, point `SARDEENZ_RUNNER_CATALOG_URL` at the repo's
`runners.yaml` and `SARDEENZ_MODULES_DIR` at a scratch directory.

## Pod snippet (Kubernetes)

```yaml
spec:
  serviceAccountName: sardeenz-control-plane
  containers:
    - name: control-plane
      image: quay.io/rh-aiservices-bu/sardeenz-control-plane:latest
      env:
        - { name: SARDEENZ_SIF_IMPORTER, value: oras }
        - { name: SARDEENZ_MODULES_DIR, value: /modules }
        - {
            name: SARDEENZ_RUNNER_CATALOG_URL,
            value: 'https://raw.githubusercontent.com/rh-aiservices-bu/school-of-sardeenz/refs/heads/main/runners.yaml',
          }
      volumeMounts:
        - { name: modules, mountPath: /modules } # read-write (control plane is a writer)
        - { name: signing-key, mountPath: /etc/sardeenz/keys, readOnly: true }
  volumes:
    - name: modules
      persistentVolumeClaim: { claimName: sardeenz-modules }
    - name: signing-key
      configMap: { name: sardeenz-sif-signing-pubkey, optional: true }
```

The control plane imports the signing public key on startup the same way the worker does (or bake
it into the image); with `SARDEENZ_VERIFY_SIF=true` an unsigned/untrusted SIF is refused at import.
