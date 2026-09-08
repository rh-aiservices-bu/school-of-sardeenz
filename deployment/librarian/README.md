# OpenShift runner image publisher

This directory contains the reproducible build pipeline for runner artifacts. One parameterized
OpenShift Template creates an ordinary Kubernetes `Job` that coordinates two heavy cluster-side
operations:

```text
Git repository + branch/tag/commit
  -> OpenShift native Docker build -> tagged OCI image + immutable digest
  -> Apptainer conversion -> optional SIF signature -> tagged ORAS artifact
```

Nothing is built on the administrator's workstation. The OpenShift build service gets its own
CPU, memory, and ephemeral-storage budget for the Containerfile build. The Job then gets separate
node-local scratch for OCI-to-SIF conversion. A GPU is not required.

## Files

| File                              | Purpose                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------ |
| `job.yaml`                        | OpenShift Template containing the parameterized `batch/v1` publishing Job.                       |
| `params.example.env`              | Copyable per-build parameters, including the Git ref and both destination tags.                  |
| `serviceaccount.yaml`             | Librarian ServiceAccount, SCC grant, and permissions to create/observe one-off OpenShift Builds. |
| `registry-secret.example.yaml`    | Shape of the Docker-config Secret shared by the native build and Apptainer.                      |
| `signing-key-secret.example.yaml` | Optional private signing-key Secret shape.                                                       |
| `kustomization.yaml`              | Installs the long-lived ServiceAccount and RBAC only.                                            |
| `scripts/build-runner-sif.sh`     | Coordinates the OpenShift OCI build and SIF stage.                                               |
| `scripts/build-sif.sh`            | Converts, optionally signs/verifies, and pushes the SIF.                                         |

## Parameters

The parameters normally changed for every build are:

| Parameter           | Example                                                      | Meaning                                                           |
| ------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------- |
| `PIPELINE_NAME`     | `vllm-021-rc1-20260908`                                      | Unique Job and OpenShift Build name.                              |
| `GIT_URI`           | `https://github.com/rh-aiservices-bu/school-of-sardeenz.git` | Source repository.                                                |
| `GIT_REF`           | `feature/new-vllm`                                           | Branch, tag, or commit SHA to build.                              |
| `CONTEXT_DIR`       | `.`                                                          | Repository-relative build context; `.` means the repository root. |
| `CONTAINERFILE`     | `containers/runner-vllm/Containerfile`                       | Path relative to `CONTEXT_DIR`.                                   |
| `OCI_REPOSITORY`    | `quay.io/rh-aiservices-bu/sardeenz-runner-images/vllm`       | OCI destination without a tag.                                    |
| `OCI_TAG`           | `0.21-rc1`                                                   | Explicit OCI image tag.                                           |
| `SIF_NAME`          | `vllm-0.21-rc1`                                              | SIF filename stem.                                                |
| `ORAS_REPOSITORY`   | `quay.io/rh-aiservices-bu/sardeenz-runners/vllm`             | SIF artifact destination without scheme/tag.                      |
| `ORAS_TAG`          | `0.21-rc1`                                                   | Explicit ORAS artifact tag.                                       |
| `SIGN_SIF`          | `false`                                                      | Sign and verify before pushing. Defaults to `false` for PoC use.  |
| `SIF_BUILDER_IMAGE` | `quay.io/rh-aiservices-bu/sardeenz-worker-base@sha256:...`   | Image containing Apptainer and FUSE helpers.                      |

`CLI_IMAGE`, Secret names, and OCI/SIF resource budgets also have parameters. Inspect them with:

```bash
oc process --parameters -f deployment/librarian/job.yaml
```

## One-time setup

The commands below assume the namespace is `sardeenz` and you are logged in with `oc`.

### 1. Create the namespace and runtime prerequisites

```bash
oc new-project sardeenz                         # omit if it already exists
oc apply -f deployment/sif-runner/scc.yaml
oc apply -k deployment/librarian/
```

The librarian uses the same validated rootless Apptainer posture as Sardeenz workers: OpenShift
4.15+, `crun`, unprivileged user namespaces, seccomp `Unconfined`, and `/dev/fuse` supplied by the
CRI-O device annotation. It is not privileged and receives no added Linux capabilities.

`SIF_BUILDER_IMAGE` must already be available to the cluster. Use `worker-base`, built as described
in `containers/worker-base/README.md`, and prefer its digest-pinned reference. This is intentionally
the base rather than the deployable `sardeenz-worker` image: SIF conversion needs Apptainer and
FUSE, but not the TypeScript worker agent. The bootstrap image is small compared with the runner
images and changes infrequently.

### 2. Install the pipeline scripts

Create or update the ConfigMap whenever either script changes:

```bash
oc create configmap sardeenz-librarian-scripts \
  --from-file=build-sif.sh=scripts/build-sif.sh \
  --from-file=build-runner-sif.sh=scripts/build-runner-sif.sh \
  --dry-run=client -o yaml -n sardeenz | oc apply -f -
```

### 3. Create the registry Secret

The same Docker configuration is used by OpenShift to push the OCI image and by Apptainer to pull
that digest and push the SIF. The token therefore needs push access to both destination
repositories and pull access to the newly built OCI image.

For one registry account:

```bash
oc create secret docker-registry sardeenz-librarian-registry \
  --docker-server=quay.io \
  --docker-username='<robot account>' \
  --docker-password='<token>' \
  --docker-email='unused@example.com' \
  -n sardeenz
```

For multiple registries, create a `kubernetes.io/dockerconfigjson` Secret from a Docker config
containing every required registry:

```bash
oc create secret generic sardeenz-librarian-registry \
  --type=kubernetes.io/dockerconfigjson \
  --from-file=.dockerconfigjson=/path/to/config.json \
  -n sardeenz
```

The Job also lists this Secret under `imagePullSecrets`. This allows private CLI or
`SIF_BUILDER_IMAGE` pulls when their registry credentials are present in the same config.

### 4. Optional: configure SIF signing

Signing is disabled by default. For the current PoC, skip this step and keep `SIGN_SIF=false`.
The pipeline invokes `apptainer push --allow-unsigned`.

To enable signing later:

```bash
apptainer key newpair
apptainer key export --secret --armor <fingerprint> sardeenz-sif-signing.private.asc
apptainer key export --armor <fingerprint> sardeenz-sif-signing.pub

oc create secret generic sardeenz-sif-signing-key \
  --from-file=private.asc=sardeenz-sif-signing.private.asc \
  -n sardeenz
```

Add `--from-literal=passphrase='<passphrase>'` when the private key is encrypted. Distribute the
public key to the control plane and workers as described in `deployment/sif-runner/README.md`, then
run with `SIGN_SIF=true`.

Unsigned catalog imports require `SARDEENZ_VERIFY_SIF=false` on both the control plane and workers.
Use that only in a trusted PoC environment; an unsigned SIF bypasses the integrity check normally
applied before import and execution.

## Run the pipeline

Use a unique `PIPELINE_NAME` for every attempt. This example builds the vLLM runner from a feature
branch, publishes an explicitly tagged OCI image, and publishes an unsigned pre-release SIF:

The shortest reproducible path is a parameter file:

```bash
cp deployment/librarian/params.example.env /tmp/vllm-021-rc1.env
# Edit the copy: use a unique PIPELINE_NAME and set the branch, destinations/tags,
# SIF name, and real SIF_BUILDER_IMAGE digest.

oc process -f deployment/librarian/job.yaml \
  --param-file=/tmp/vllm-021-rc1.env \
  | oc create -f - -n sardeenz
```

The equivalent fully expanded command is:

```bash
PIPELINE_NAME="vllm-021-rc1-$(date +%Y%m%d%H%M%S)"

oc process -f deployment/librarian/job.yaml \
  -p PIPELINE_NAME="$PIPELINE_NAME" \
  -p GIT_URI=https://github.com/rh-aiservices-bu/school-of-sardeenz.git \
  -p GIT_REF=feature/new-vllm \
  -p CONTEXT_DIR=. \
  -p CONTAINERFILE=containers/runner-vllm/Containerfile \
  -p OCI_REPOSITORY=quay.io/rh-aiservices-bu/sardeenz-runner-images/vllm \
  -p OCI_TAG=0.21-rc1 \
  -p SIF_NAME=vllm-0.21-rc1 \
  -p ORAS_REPOSITORY=quay.io/rh-aiservices-bu/sardeenz-runners/vllm \
  -p ORAS_TAG=0.21-rc1 \
  -p SIGN_SIF=false \
  -p SIF_BUILDER_IMAGE=quay.io/rh-aiservices-bu/sardeenz-worker-base@sha256:<digest> \
  | oc create -f - -n sardeenz
```

Follow the complete pipeline from the Job log:

```bash
oc logs -f "job/$PIPELINE_NAME" -c build-oci -n sardeenz
oc logs -f "job/$PIPELINE_NAME" -c publish-sif -n sardeenz
```

The first stage reports the exact source commit and digest-pinned OCI reference. The second stage
reports the pushed ORAS reference. OpenShift retains the native Build for diagnostics, while the
completed Job is automatically removed after seven days.

Useful failure diagnostics:

```bash
oc describe "job/$PIPELINE_NAME" -n sardeenz
oc get "build/$PIPELINE_NAME-oci" -o yaml -n sardeenz
oc logs "build/$PIPELINE_NAME-oci" -n sardeenz
```

After publishing, resolve the ORAS tag to its registry manifest digest and put the digest-pinned
reference in `runners.yaml`; the catalog intentionally rejects mutable-only references.

## Resource tuning

The defaults give the native OCI build 2 CPU, 8/16 GiB memory, and 50/100 GiB requested/limited
ephemeral storage. SIF conversion gets 2 CPU, 8/16 GiB memory, and 60/100 GiB scratch. Override the
corresponding `OCI_BUILD_*` or `SIF_BUILD_*` parameters when a runner needs more.

OCI unpack is hardlink-heavy. SIF scratch must remain node-local `emptyDir`; do not point
`APPTAINER_TMPDIR` at RWX/NFS storage.
