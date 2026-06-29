#!/usr/bin/env bash
set -euo pipefail

LOGGED="${1:-false}"

if ! command -v cargo &>/dev/null; then
  echo "⚠ Rust toolchain not installed — skipping proxy (see docs/development/setup.md)"
  exit 0
fi

if ! cargo watch --version &>/dev/null 2>&1; then
  echo "⚠ cargo-watch not installed — skipping proxy (install with: cargo install cargo-watch)"
  exit 0
fi

cd "$(dirname "$0")/../proxy"

if [ "$LOGGED" = "--logged" ]; then
  mkdir -p ../logs
  cargo watch -x run 2>&1 | tee ../logs/proxy.log
else
  cargo watch -x run
fi
