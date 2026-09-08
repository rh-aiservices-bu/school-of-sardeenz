#!/usr/bin/env bash
# Orchestrate the two stages of the OpenShift runner publishing pipeline.
set -euo pipefail

MODE="${1:-}"
RESULTS_DIR="${RESULTS_DIR:-/results}"

require_var() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "$name is required" >&2
    exit 2
  fi
}

validate_common() {
  require_var PIPELINE_NAME
  if ! [[ "$PIPELINE_NAME" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] || [[ ${#PIPELINE_NAME} -gt 50 ]]; then
    echo "PIPELINE_NAME must be a DNS label of at most 50 characters" >&2
    exit 2
  fi
}

build_oci() {
  local phase digest source_ref quantity_name quantity_value name
  validate_common
  for name in GIT_URI GIT_REF CONTEXT_DIR CONTAINERFILE OCI_REPOSITORY OCI_TAG REGISTRY_SECRET; do
    require_var "$name"
  done

  if ! [[ "$GIT_URI" =~ ^https://[A-Za-z0-9.-]+(/[A-Za-z0-9._~-]+)+/?$ ]]; then
    echo "GIT_URI must be a credential-free https:// repository URL" >&2
    exit 2
  fi
  if ! [[ "$GIT_REF" =~ ^[A-Za-z0-9._/-]+$ ]] || [[ "$GIT_REF" == *..* ]]; then
    echo "GIT_REF contains unsupported characters or '..'" >&2
    exit 2
  fi
  if ! [[ "$CONTAINERFILE" =~ ^[A-Za-z0-9._/-]+$ ]] || [[ "$CONTAINERFILE" == /* || "$CONTAINERFILE" == *..* ]]; then
    echo "CONTAINERFILE must be a safe path relative to the repository root" >&2
    exit 2
  fi
  if ! [[ "$CONTEXT_DIR" =~ ^[A-Za-z0-9._/-]+$ ]] || [[ "$CONTEXT_DIR" == /* || "$CONTEXT_DIR" == *..* ]]; then
    echo "CONTEXT_DIR must be a safe path relative to the repository root (use . for root)" >&2
    exit 2
  fi
  if ! [[ "$OCI_REPOSITORY" =~ ^[a-z0-9.-]+(:[0-9]+)?/[a-z0-9._-]+(/[a-z0-9._-]+)*$ ]]; then
    echo "OCI_REPOSITORY must include a registry and repository, without a tag" >&2
    exit 2
  fi
  if ! [[ "$OCI_TAG" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]]; then
    echo "OCI_TAG is not a valid OCI tag" >&2
    exit 2
  fi
  if ! [[ "$REGISTRY_SECRET" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]]; then
    echo "REGISTRY_SECRET must be a DNS label" >&2
    exit 2
  fi
  if ! [[ "${OCI_BUILD_CPU_REQUEST:-2}" =~ ^([0-9]+|[0-9]+m)$ ]]; then
    echo "OCI_BUILD_CPU_REQUEST must be an integer core count or millicore value" >&2
    exit 2
  fi
  for quantity_name in \
    OCI_BUILD_MEMORY_REQUEST OCI_BUILD_MEMORY_LIMIT \
    OCI_BUILD_STORAGE_REQUEST OCI_BUILD_STORAGE_LIMIT; do
    quantity_value="${!quantity_name:-}"
    if [[ -n "$quantity_value" ]] && ! [[ "$quantity_value" =~ ^[1-9][0-9]*(Mi|Gi|Ti)$ ]]; then
      echo "$quantity_name must use an Mi, Gi, or Ti quantity" >&2
      exit 2
    fi
  done

  mkdir -p "$RESULTS_DIR"
  echo "==> Creating OpenShift Docker build ${PIPELINE_NAME}-oci"
  oc create -f - <<EOF
apiVersion: build.openshift.io/v1
kind: Build
metadata:
  name: ${PIPELINE_NAME}-oci
  labels:
    app.kubernetes.io/name: sardeenz-librarian
    app.kubernetes.io/part-of: sardeenz
spec:
  serviceAccount: builder
  completionDeadlineSeconds: 7200
  source:
    type: Git
    git:
      uri: ${GIT_URI}
      ref: ${GIT_REF}
    contextDir: ${CONTEXT_DIR}
  strategy:
    type: Docker
    dockerStrategy:
      dockerfilePath: ${CONTAINERFILE}
      pullSecret:
        name: ${REGISTRY_SECRET}
  output:
    to:
      kind: DockerImage
      name: ${OCI_REPOSITORY}:${OCI_TAG}
    pushSecret:
      name: ${REGISTRY_SECRET}
  resources:
    requests:
      cpu: "${OCI_BUILD_CPU_REQUEST:-2}"
      memory: ${OCI_BUILD_MEMORY_REQUEST:-8Gi}
      ephemeral-storage: ${OCI_BUILD_STORAGE_REQUEST:-50Gi}
    limits:
      memory: ${OCI_BUILD_MEMORY_LIMIT:-16Gi}
      ephemeral-storage: ${OCI_BUILD_STORAGE_LIMIT:-100Gi}
EOF

  # Stream when possible, then poll the Build API as the source of truth. The log command can
  # return early while the build Pod is still being scheduled.
  oc logs --follow "build/${PIPELINE_NAME}-oci" || true
  for _ in $(seq 1 720); do
    phase="$(oc get "build/${PIPELINE_NAME}-oci" -o jsonpath='{.status.phase}')"
    case "$phase" in
      Complete|Failed|Error|Cancelled) break ;;
    esac
    sleep 10
  done
  if [[ "$phase" != "Complete" ]]; then
    echo "OpenShift build finished in phase '$phase'" >&2
    oc get "build/${PIPELINE_NAME}-oci" -o yaml >&2
    exit 1
  fi

  digest="$(oc get "build/${PIPELINE_NAME}-oci" -o jsonpath='{.status.output.to.imageDigest}')"
  if ! [[ "$digest" =~ ^sha256:[a-fA-F0-9]{64}$ ]]; then
    echo "OpenShift build completed but did not report a sha256 output digest" >&2
    exit 1
  fi
  source_ref="${OCI_REPOSITORY}:${OCI_TAG}@${digest}"
  printf '%s\n' "$source_ref" >"${RESULTS_DIR}/oci-image-ref"
  printf '%s\n' "$(oc get "build/${PIPELINE_NAME}-oci" -o jsonpath='{.status.revision.git.commit}')" \
    >"${RESULTS_DIR}/git-commit"
  echo "==> OCI image published: $source_ref"
}

publish_sif() {
  local source_ref oras_ref sif_work_dir build_sif_script name
  validate_common
  for name in SIF_NAME ORAS_REPOSITORY ORAS_TAG SIGN_SIF; do
    require_var "$name"
  done
  if ! [[ "$ORAS_REPOSITORY" =~ ^[a-z0-9.-]+(:[0-9]+)?/[a-z0-9._-]+(/[a-z0-9._-]+)*$ ]]; then
    echo "ORAS_REPOSITORY must include a registry and repository, without scheme or tag" >&2
    exit 2
  fi
  if ! [[ "$ORAS_TAG" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]]; then
    echo "ORAS_TAG is not a valid OCI tag" >&2
    exit 2
  fi
  if [[ "$SIGN_SIF" != "true" && "$SIGN_SIF" != "false" ]]; then
    echo "SIGN_SIF must be true or false" >&2
    exit 2
  fi
  if [[ ! -s "${RESULTS_DIR}/oci-image-ref" ]]; then
    echo "OCI build result is missing" >&2
    exit 1
  fi
  source_ref="$(<"${RESULTS_DIR}/oci-image-ref")"
  oras_ref="oras://${ORAS_REPOSITORY}:${ORAS_TAG}"
  sif_work_dir="${SIF_WORK_DIR:-/scratch}"
  build_sif_script="${BUILD_SIF_SCRIPT:-/opt/librarian/build-sif.sh}"
  mkdir -p \
    "${sif_work_dir}/tmp" \
    "${sif_work_dir}/cache" \
    "${sif_work_dir}/home" \
    "${sif_work_dir}/published"
  echo "==> Converting immutable OCI image: $source_ref"
  "$build_sif_script" \
    --image "$source_ref" \
    --name "$SIF_NAME" \
    --oras-ref "$oras_ref" \
    --sign "$SIGN_SIF" \
    --modules-dir "${sif_work_dir}/published"
  echo "==> Source commit: $(<"${RESULTS_DIR}/git-commit")"
  echo "==> Catalog source: ${oras_ref}"
}

case "$MODE" in
  build-oci) build_oci ;;
  publish-sif) publish_sif ;;
  *) echo "Usage: build-runner-sif.sh build-oci|publish-sif" >&2; exit 2 ;;
esac
