# worker

The production `sardeenz-worker` image. It layers the compiled TypeScript agent from
`runners/dev-worker` on top of `worker-base` and runs that same agent in `apptainer` mode. The
name `dev-worker` is historical: stub mode is used for local development, while apptainer mode is
the production worker implementation.

The resulting image contains:

- rootless Apptainer, FUSE helpers, Node.js 22, and diagnostics from `worker-base`;
- `runners/dev-worker/dist`;
- production Node dependencies, including the NVML binding; and
- the runtime `@sardeenz/types` package.

It does not contain an inference engine. Engines remain independently versioned SIF artifacts.

## Build

Build both images from the repository root. The final build must be able to pull the base image by
the value passed to `WORKER_BASE_IMAGE`; use a registry reference for a remote/OpenShift build and
prefer an immutable digest.

For an OpenShift-side build, create the two binary BuildConfigs once, then submit builds. Only the
source archive is uploaded from the workstation; all package installation and compilation happen
in cluster:

```bash
oc new-build --name=sardeenz-worker-base --binary --strategy=docker \
  --dockerfile="$(<containers/worker-base/Containerfile)" \
  -n sardeenz
oc start-build sardeenz-worker-base \
  --from-dir=containers/worker-base --follow \
  -n sardeenz

WORKER_BASE_IMAGE="$(oc get istag/sardeenz-worker-base:latest \
  -o jsonpath='{.image.dockerImageReference}' -n sardeenz)"

oc new-build --name=sardeenz-worker --binary --strategy=docker \
  --dockerfile="$(<containers/worker/Containerfile)" \
  --build-arg="WORKER_BASE_IMAGE=$WORKER_BASE_IMAGE" \
  -n sardeenz
oc start-build sardeenz-worker \
  --from-dir=. --follow \
  --exclude='(^|/)(\.git|node_modules|dist|coverage|test-results|logs)(/|$)|(^|/)\.env(\..*)?$' \
  -n sardeenz
```

The resulting internal reference is available with `oc get istag/sardeenz-worker:latest`. Patch
the Deployment to that reference or mirror it to the registry used by the target environment.

The equivalent local/container-tool build is:

```bash
podman build \
  -f containers/worker-base/Containerfile \
  -t quay.io/rh-aiservices-bu/sardeenz-worker-base:latest .
podman push quay.io/rh-aiservices-bu/sardeenz-worker-base:latest

podman build \
  --build-arg WORKER_BASE_IMAGE=quay.io/rh-aiservices-bu/sardeenz-worker-base@sha256:<digest> \
  -f containers/worker/Containerfile \
  -t quay.io/rh-aiservices-bu/sardeenz-worker:latest .
podman push quay.io/rh-aiservices-bu/sardeenz-worker:latest
```

Set the resulting `sardeenz-worker` reference in the deployment overlay. The base image alone is
only a reusable runtime/building block and cannot run the worker Deployment.
