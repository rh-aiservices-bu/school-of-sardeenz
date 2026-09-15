#!/usr/bin/env bash
# build-sif.sh — convert a runner OCI image into a versioned SIF and optionally sign/push it.
#
# Runs in the librarian Job (deployment/librarian), NEVER on a serving worker (ADR-017): the
# OCI->SIF unpack is hardlink-heavy and needs node-local scratch + several GB of RAM (spike finding:
# a network-FS APPTAINER_TMPDIR fails the unpack with "unpriv.link ... too many links").
#
# Usage:
#   build-sif.sh --image <ref> --name <engine>-<version> [--oras-ref oras://registry/repo:tag]
#                [--sign true|false] [--modules-dir /modules] [--keyidx 0]
#
# Env:
#   APPTAINER_TMPDIR / APPTAINER_CACHEDIR   node-local scratch (set by the Job to /scratch)
#   APPTAINER_AUTH_FILE Docker-style registry authentication file (optional)
#   SIF_SIGNING_KEY   path to the private signing key to import (mounted from a Secret)
#   APPTAINER_PASSPHRASE  passphrase for the signing key (empty for a passphraseless key)
set -euo pipefail

IMAGE=""
NAME=""
ORAS_REF=""
MODULES_DIR="/modules"
KEYIDX="0"
SIGN_SIF="true"
AUTH_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --image) IMAGE="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --oras-ref) ORAS_REF="$2"; shift 2 ;;
    --sign) SIGN_SIF="$2"; shift 2 ;;
    --modules-dir) MODULES_DIR="$2"; shift 2 ;;
    --keyidx) KEYIDX="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$IMAGE" || -z "$NAME" ]]; then
  echo "Usage: build-sif.sh --image <ref> --name <engine>-<version> [--oras-ref oras://registry/repo:tag] [--sign true|false] [--modules-dir DIR] [--keyidx N]" >&2
  exit 2
fi

# Reject an accidental "-latest" tag in the SIF name — modules are always versioned (ADR-017).
if [[ "$NAME" == *latest* ]]; then
  echo "SIF name must be versioned (<engine>-<version>), not '$NAME'" >&2
  exit 2
fi

# Restrict NAME to a safe filename segment (no path traversal / separators).
if ! [[ "$NAME" =~ ^[A-Za-z0-9_.-]+$ ]]; then
  echo "Invalid SIF name '$NAME' (allowed: A-Z a-z 0-9 . _ -)" >&2
  exit 2
fi

# Require a digest-pinned image ref — mutable tags can be repointed after review, silently
# swapping what gets built into a signed SIF.
if ! [[ "$IMAGE" =~ @sha256:[a-fA-F0-9]{64}$ ]]; then
  echo "IMAGE must include a @sha256:<digest> suffix (mutable tags are not allowed)" >&2
  exit 2
fi
if [[ "$IMAGE" =~ :[^/@]+@sha256: ]]; then
  echo "IMAGE must use a digest-only reference; tag@digest references are not supported by Apptainer" >&2
  exit 2
fi

if [[ -n "$ORAS_REF" ]] && ! [[ "$ORAS_REF" =~ ^oras://[^[:space:]@]+:[A-Za-z0-9_.-]+$ ]]; then
  echo "Invalid ORAS destination '$ORAS_REF' (expected oras://registry/repository:tag)" >&2
  exit 2
fi
if [[ "$SIGN_SIF" != "true" && "$SIGN_SIF" != "false" ]]; then
  echo "--sign must be true or false" >&2
  exit 2
fi

: "${APPTAINER_TMPDIR:?APPTAINER_TMPDIR must point at node-local scratch}"
: "${APPTAINER_CACHEDIR:?APPTAINER_CACHEDIR must point at node-local scratch}"
if [[ -n "${APPTAINER_AUTH_FILE:-}" ]]; then
  AUTH_ARGS=(--authfile "$APPTAINER_AUTH_FILE")
fi

FINAL="${MODULES_DIR}/${NAME}.sif"
TMP="${MODULES_DIR}/.${NAME}.sif.tmp.$$"
LOCAL_SIF="${APPTAINER_TMPDIR}/${NAME}.sif"
cleanup() { rm -f "$TMP" "$LOCAL_SIF"; }
trap cleanup EXIT

if [[ "$SIGN_SIF" == "true" ]]; then
  echo "==> Importing signing key"
  if [[ -n "${SIF_SIGNING_KEY:-}" && -f "${SIF_SIGNING_KEY}" ]]; then
    apptainer key import "${SIF_SIGNING_KEY}"
  else
    echo "SIF_SIGNING_KEY not set or missing — refusing to sign SIF" >&2
    exit 1
  fi
else
  echo "==> Signing disabled (PoC mode)"
fi

echo "==> Building SIF from ${IMAGE} (scratch: ${APPTAINER_TMPDIR})"
# Build to a node-local temp first (LOCAL_SIF, declared above), then copy onto the module store:
# the build's hardlink-heavy unpack must not touch the network FS.
apptainer build --force "${AUTH_ARGS[@]}" "${LOCAL_SIF}" "docker://${IMAGE}"

if [[ "$SIGN_SIF" == "true" ]]; then
  echo "==> Signing SIF (keyidx ${KEYIDX})"
  # APPTAINER_PASSPHRASE (if set) is consumed non-interactively.
  apptainer sign --keyidx "${KEYIDX}" "${LOCAL_SIF}"

  echo "==> Verifying signature before publish"
  apptainer verify "${LOCAL_SIF}"
fi

echo "==> Publishing to ${FINAL} (write-new-then-rename, chmod 644)"
# World-readable: the librarian's write UID != the worker's arbitrary read UID (ADR-017).
install -m 0644 "${LOCAL_SIF}" "$TMP"
mv -f "$TMP" "$FINAL"   # atomic on the same filesystem
chmod 0644 "$FINAL"

echo "==> Done: ${FINAL}"
if [[ "$SIGN_SIF" == "true" ]]; then
  apptainer verify "$FINAL"
fi

if [[ -n "$ORAS_REF" ]]; then
  echo "==> Publishing SIF to ${ORAS_REF}"
  if [[ "$SIGN_SIF" == "true" ]]; then
    apptainer push "${AUTH_ARGS[@]}" "$FINAL" "$ORAS_REF"
  else
    apptainer push --allow-unsigned "${AUTH_ARGS[@]}" "$FINAL" "$ORAS_REF"
  fi
  echo "==> Published: ${ORAS_REF}"
fi
