# deployment/control-plane

Deployment notes for the control plane's **runner-catalog import** path. (Full control-plane
manifests are tracked separately; this documents only the catalog/module-store requirements added
by the runner-catalog feature.)

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
3. **Apptainer in the image** (for `SARDEENZ_SIF_IMPORTER=oras`). `containers/control-plane/Dockerfile`
   installs the unprivileged apptainer CLI; `apptainer pull oras://…` + `apptainer verify` are
   download-only (no setuid/fuse/userns), so no special SCC is needed for the control plane.
4. **The SIF signing public key** (when `SARDEENZ_VERIFY_SIF=true`, the default) so
   `apptainer verify` trusts pulled SIFs — same `sardeenz-sif-signing-pubkey` ConfigMap the workers
   use ([`../librarian/`](../librarian/)).

## Environment

| Var | Purpose | Default |
|---|---|---|
| `SARDEENZ_RUNNER_CATALOG_URL` | Catalog source (http(s) URL or local file / `file://`) | the official `school-of-sardeenz` raw URL |
| `SARDEENZ_MODULES_DIR` | Module store mount path | `/modules` |
| `SARDEENZ_SIF_IMPORTER` | `oras` (real: `apptainer pull`) or `stub` (dev: placeholder file) | `stub` |
| `SARDEENZ_APPTAINER_BIN` | apptainer binary | `apptainer` |
| `SARDEENZ_VERIFY_SIF` | `apptainer verify` pulled SIFs before publishing | `true` |

Set `SARDEENZ_SIF_IMPORTER=oras` in production; leave it unset (`stub`) for local dev / CI where
apptainer isn't installed. For local dev, point `SARDEENZ_RUNNER_CATALOG_URL` at the repo's
`runners.yaml` and `SARDEENZ_MODULES_DIR` at a scratch directory.

## Pod snippet (Kubernetes)

```yaml
spec:
  serviceAccountName: sardeenz-control-plane
  containers:
    - name: control-plane
      image: sardeenz-control-plane:latest
      env:
        - { name: SARDEENZ_SIF_IMPORTER, value: oras }
        - { name: SARDEENZ_MODULES_DIR, value: /modules }
        - { name: SARDEENZ_RUNNER_CATALOG_URL, value: "https://raw.githubusercontent.com/rh-aiservices-bu/school-of-sardeenz/refs/heads/main/runners.yaml" }
      volumeMounts:
        - { name: modules, mountPath: /modules }          # read-write (control plane is a writer)
        - { name: signing-key, mountPath: /etc/sardeenz/keys, readOnly: true }
  volumes:
    - name: modules
      persistentVolumeClaim: { claimName: sardeenz-modules }
    - name: signing-key
      configMap: { name: sardeenz-sif-signing-pubkey, optional: true }
```

The control plane imports the signing public key on startup the same way the worker does (or bake
it into the image); with `SARDEENZ_VERIFY_SIF=true` an unsigned/untrusted SIF is refused at import.
