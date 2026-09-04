#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
dockerfile="${repository_root}/proxy/Dockerfile"
cargo_toml="${repository_root}/proxy/Cargo.toml"
clippy_toml="${repository_root}/clippy.toml"

docker_msrv="$(sed -nE 's/^FROM rust:([0-9]+\.[0-9]+)-bookworm AS deps$/\1/p' "${dockerfile}")"
cargo_msrv="$(sed -nE 's/^rust-version = "([0-9]+\.[0-9]+)"$/\1/p' "${cargo_toml}")"
clippy_msrv="$(sed -nE 's/^msrv = "([0-9]+\.[0-9]+)"$/\1/p' "${clippy_toml}")"

[[ -n "${docker_msrv}" ]] || {
  echo "proxy Dockerfile must pin a rust:<major>.<minor>-bookworm deps image" >&2
  exit 1
}
[[ "${docker_msrv}" == "${cargo_msrv}" ]] || {
  echo "proxy Dockerfile Rust ${docker_msrv} does not match Cargo MSRV ${cargo_msrv}" >&2
  exit 1
}
[[ "${docker_msrv}" == "${clippy_msrv}" ]] || {
  echo "proxy Dockerfile Rust ${docker_msrv} does not match Clippy MSRV ${clippy_msrv}" >&2
  exit 1
}

# Cargo validates the Linux locked dependency graph with the Dockerfile's exact
# Rust version, so a lockfile whose MSRV exceeds the image pin fails before
# BuildKit runs. The image build separately compiles the musl target.
cd "${repository_root}/proxy"
cargo "+${cargo_msrv}.0" check --locked
