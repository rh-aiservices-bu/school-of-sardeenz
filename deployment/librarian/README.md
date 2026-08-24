# deployment/librarian

The SIF **build/sign/convert** pipeline (Phase 4 Task 7,
[ADR-017](../../docs/architecture/adrs/adr-017-runner-image-pipeline.md)). Turns a runner OCI image
into a **signed, world-readable SIF** on the module store. It runs as a Kubernetes Job and is the
**only** writer of the module PVC — never a serving worker.

## Contents

| File                              | What it is                                                                                                                                                                                                                                     |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `serviceaccount.yaml`             | `sardeenz-librarian` SA + RBAC to `use` the `sardeenz-sif-runner` SCC (apptainer build needs userns). This SA is the one the module write-protection VAP exempts.                                                                              |
| `job.yaml`                        | The build Job: module PVC **read-write**, node-local `emptyDir` scratch (~50Gi), mem 8Gi/16Gi (the OCI-unpack OOM finding), private signing key from a Secret, and the build script from a ConfigMap. Edit `IMAGE_REF` + `SIF_NAME` per build. |
| `signing-key-secret.example.yaml` | **Template** for the private-key Secret — create the real one out-of-band; never commit a key.                                                                                                                                                 |
| `kustomization.yaml`              | SA + Job. The build script ConfigMap is created separately from [`scripts/build-sif.sh`](../../scripts/build-sif.sh) (single source of truth — see below).                                                                                     |

## Pipeline

```text
containers/runner-<engine>/Containerfile
   → CI: build + scan + sign the OCI image → registry
   → librarian Job (this dir): apptainer build → apptainer sign → verify → chmod 644 → module PVC
   → worker: apptainer exec (squashfuse, read-only) + apptainer verify at exec
```

`scripts/build-sif.sh` does the build→sign→verify→publish, writing to a node-local temp first
(hardlink-heavy unpack must not touch the network FS) then atomically renaming onto the module
store with mode `0644` (world-readable — the librarian's write UID ≠ the worker's arbitrary read
UID).

## Signing key management

Apptainer SIF signing keys are a **new** secret class — [ADR-013](../../docs/architecture/adrs/adr-013-secrets-management.md)
governs only env-var app secrets, not signing keypairs (ADR-017).

1. **Generate** a keypair: `apptainer key newpair` (use an **empty passphrase** for unattended CI,
   or set `APPTAINER_PASSPHRASE` in the Job).
2. **Private key** → a Secret mounted **only** into this Job (`sardeenz-sif-signing-key`), imported
   into the keyring before `apptainer sign`. Never mount it on workers.
3. **Public key** → distributed to **every worker** as the `sardeenz-sif-signing-pubkey` ConfigMap
   (consumed by `deployment/sif-runner`), imported so `apptainer verify` trusts SIFs at exec.

See `signing-key-secret.example.yaml` for the exact `apptainer key export` / `oc create` commands.

### Rotation

1. Generate a new keypair; **roll the new public key to all workers first** (add it to the pubkey
   ConfigMap so both old and new are trusted).
2. Re-sign existing SIFs with the new key (re-run the librarian, or `apptainer sign` in place).
3. Once every SIF is re-signed and every worker trusts the new key, **retire the old public key**
   from the ConfigMap and rotate out the old private-key Secret.

## Run a build

```bash
# 1. Deliver the build script as a ConfigMap (from the repo root, canonical source):
oc create configmap sardeenz-librarian-scripts \
  --from-file=build-sif.sh=scripts/build-sif.sh -n sardeenz
# 2. Create the private-key Secret out-of-band (see "Signing key management" above).
# 3. Apply the SA/RBAC + Job template:
oc apply -k deployment/librarian/
# 4. Run a build (edit IMAGE_REF/SIF_NAME in job.yaml or override on the spawned job):
oc create job --from=job/sardeenz-librarian-build sardeenz-build-vllm-0.21 -n sardeenz
oc logs -f job/sardeenz-build-vllm-0.21 -n sardeenz
```

Prereqs: the `sardeenz-modules` PVC (from `deployment/sif-runner`), the `worker-base` image, and a
node with ~50Gi free ephemeral storage + ≥16Gi RAM headroom.
