#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEST_DIR="$(mktemp -d)"
cleanup() { rm -rf -- "$TEST_DIR"; }
trap cleanup EXIT

mkdir -p "$TEST_DIR/bin" "$TEST_DIR/tmp" "$TEST_DIR/cache" "$TEST_DIR/modules"
export FAKE_APPTAINER_LOG="$TEST_DIR/apptainer.log"

# shellcheck disable=SC2016 # The single-quoted strings are the generated fake executable.
printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail' \
  'printf "%s\n" "$*" >>"$FAKE_APPTAINER_LOG"' \
  'if [[ "$1" == build ]]; then touch "${@: -2:1}"; fi' >"$TEST_DIR/bin/apptainer"
chmod +x "$TEST_DIR/bin/apptainer"
printf '{"auths":{}}\n' >"$TEST_DIR/auth.json"

PATH="$TEST_DIR/bin:$PATH" \
APPTAINER_TMPDIR="$TEST_DIR/tmp" \
APPTAINER_CACHEDIR="$TEST_DIR/cache" \
APPTAINER_AUTH_FILE="$TEST_DIR/auth.json" \
  "$ROOT_DIR/scripts/build-sif.sh" \
    --image quay.io/rh-aiservices-bu/sardeenz-runner-images/vllm:1@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    --name runner-1 \
    --oras-ref oras://quay.io/rh-aiservices-bu/sardeenz-runners/vllm:1 \
    --sign false \
    --modules-dir "$TEST_DIR/modules"

grep -Eq '^build --force --authfile .+/auth.json .+/runner-1.sif docker://' \
  "$FAKE_APPTAINER_LOG"
grep -Eq '^push --allow-unsigned --authfile .+/auth.json .+ oras://quay.io/rh-aiservices-bu/sardeenz-runners/vllm:1$' \
  "$FAKE_APPTAINER_LOG"
if grep -Eq '^(sign|verify|key import)' "$FAKE_APPTAINER_LOG"; then
  echo 'unsigned build unexpectedly used signing commands' >&2
  exit 1
fi

: >"$FAKE_APPTAINER_LOG"
printf 'private key fixture\n' >"$TEST_DIR/private.asc"
PATH="$TEST_DIR/bin:$PATH" \
APPTAINER_TMPDIR="$TEST_DIR/tmp" \
APPTAINER_CACHEDIR="$TEST_DIR/cache" \
SIF_SIGNING_KEY="$TEST_DIR/private.asc" \
  "$ROOT_DIR/scripts/build-sif.sh" \
    --image quay.io/rh-aiservices-bu/sardeenz-runner-images/vllm:1@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    --name runner-1 \
    --sign true \
    --modules-dir "$TEST_DIR/modules"

grep -Eq '^key import .+/private.asc$' "$FAKE_APPTAINER_LOG"
grep -Eq '^sign --keyidx 0 .+/runner-1.sif$' "$FAKE_APPTAINER_LOG"
grep -Eq '^verify .+/runner-1.sif$' "$FAKE_APPTAINER_LOG"

echo 'build-sif signing-mode tests passed'
