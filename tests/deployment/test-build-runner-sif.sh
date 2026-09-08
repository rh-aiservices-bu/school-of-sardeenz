#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEST_DIR="$(mktemp -d)"
cleanup() { rm -rf -- "$TEST_DIR"; }
trap cleanup EXIT

mkdir -p "$TEST_DIR/bin" "$TEST_DIR/results" "$TEST_DIR/scratch"
export FAKE_OC_MANIFEST="$TEST_DIR/build.yaml"
export FAKE_BUILD_SIF_ARGS="$TEST_DIR/build-sif.args"

# shellcheck disable=SC2016 # The single-quoted strings are the generated fake executable.
printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail' \
  'case "$1" in' \
  '  create) tee "$FAKE_OC_MANIFEST" >/dev/null ;;' \
  '  logs) exit 0 ;;' \
  '  get)' \
  '    case "$*" in' \
  '      *status.phase*) printf Complete ;;' \
  '      *imageDigest*) printf sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ;;' \
  '      *revision.git.commit*) printf bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb ;;' \
  '      *) exit 1 ;;' \
  '    esac' \
  '    ;;' \
  '  *) exit 1 ;;' \
  'esac' >"$TEST_DIR/bin/oc"
chmod +x "$TEST_DIR/bin/oc"

PATH="$TEST_DIR/bin:$PATH" \
PIPELINE_NAME=vllm-rc1-test \
GIT_URI=https://github.com/example/sardeenz.git \
GIT_REF=feature/vllm-rc1 \
CONTEXT_DIR=. \
CONTAINERFILE=containers/runner-vllm/Containerfile \
OCI_REPOSITORY=quay.io/example/sardeenz-runner-vllm \
OCI_TAG=0.21-rc1 \
REGISTRY_SECRET=sardeenz-librarian-registry \
RESULTS_DIR="$TEST_DIR/results" \
  "$ROOT_DIR/scripts/build-runner-sif.sh" build-oci

rg -q 'ref: feature/vllm-rc1' "$FAKE_OC_MANIFEST"
rg -q 'name: quay.io/example/sardeenz-runner-vllm:0.21-rc1' "$FAKE_OC_MANIFEST"
rg -q 'dockerfilePath: containers/runner-vllm/Containerfile' "$FAKE_OC_MANIFEST"
rg -q '@sha256:a{64}' "$TEST_DIR/results/oci-image-ref"

# shellcheck disable=SC2016 # The single-quoted string is the generated fake executable.
printf '%s\n' '#!/usr/bin/env bash' 'printf "%s\n" "$@" >"$FAKE_BUILD_SIF_ARGS"' \
  >"$TEST_DIR/build-sif.sh"
chmod +x "$TEST_DIR/build-sif.sh"

PIPELINE_NAME=vllm-rc1-test \
SIF_NAME=vllm-0.21-rc1 \
ORAS_REPOSITORY=quay.io/example/sardeenz-runners/vllm \
ORAS_TAG=0.21-rc1 \
SIGN_SIF=false \
RESULTS_DIR="$TEST_DIR/results" \
SIF_WORK_DIR="$TEST_DIR/scratch" \
BUILD_SIF_SCRIPT="$TEST_DIR/build-sif.sh" \
  "$ROOT_DIR/scripts/build-runner-sif.sh" publish-sif

rg -q '^oras://quay.io/example/sardeenz-runners/vllm:0.21-rc1$' "$FAKE_BUILD_SIF_ARGS"
rg -q '^false$' "$FAKE_BUILD_SIF_ARGS"
rg -q "^$TEST_DIR/scratch/published$" "$FAKE_BUILD_SIF_ARGS"

if PIPELINE_NAME=vllm-rc1-test \
  SIF_NAME=vllm-0.21-rc1 \
  ORAS_REPOSITORY=quay.io/example/sardeenz-runners/vllm \
  ORAS_TAG=0.21-rc1 \
  SIGN_SIF=maybe \
  RESULTS_DIR="$TEST_DIR/results" \
  "$ROOT_DIR/scripts/build-runner-sif.sh" publish-sif >/dev/null 2>&1; then
  echo 'invalid SIGN_SIF value was accepted' >&2
  exit 1
fi

echo 'build-runner-sif tests passed'
