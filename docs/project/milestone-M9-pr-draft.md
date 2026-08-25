# PR draft — Milestone M9: Engine Expansion (MLServer)

> Draft description for the `milestone-M9` → `dev` PR. Delete this file after opening the PR.

**Title:** `M9: Engine Expansion — MLServer runner, protocol-family proxy surface (ADR-021)`

---

## Summary

Second engine runner proving the runner abstraction beyond vLLM, per #125 (the milestone's
single issue). One squash commit (`91c6408`), executed as four blueprint→implement→review
units plus one review-fix round.

### #125 — MLServer engine runner: image, shim, worker launch, KServe V2 proxy support, catalog and dashboard integration

- **Proxy (Rust):** inference surface moves to protocol-family prefixes — `/openai/v1/*` and
  `/oip/v2/*` (KServe V2: `infer`, `ready`, listing) — with the prefix stripped before
  forwarding and the bare `/v1/*` routes removed (pre-release, no deprecation). Path-based
  model extraction; listings filtered by a new required `protocol` tag on routing entries
  (spec + hand-maintained Rust mirror per ADR-005; dead `engineType` removed); `/ready`
  returns 503 for sleeping models **without** waking them; the proxy advertises its
  supported protocols in Redis (`{prefix}:proxy:protocols`).
- **Control plane:** catalog entries require `protocol` (missing → loud `invalidEntries`
  validation surfaced in the dashboard, not a silent skip) and may carry a per-runner
  `entrypoint` argv; catalog import fails fast (409 `PROXY_PROTOCOL_UNSUPPORTED`) when the
  proxy doesn't advertise the entry's protocol; `protocol` persisted on instance state and
  written into every routing entry; oip model names reject `/` at deploy;
  `model-settings.json` recognized as a model-directory marker.
- **Runners:** new `runners/mlserver/` shim (all 7 management endpoints; sleep/wake via the
  V2 repository unload/load API; served-name-enforced `model-settings.json` generation with
  model-directory containment; #116-correct memory attribution; engine bound 0.0.0.0),
  `containers/runner-mlserver/` image (mlserver + sklearn + huggingface), dev-worker
  `mlserver` stub serving canonical V2 routes, `runners.yaml` catalog entry.
- **Dashboard:** protocol-labeled inference base URLs (`…/openai/v1`, `…/oip`),
  protocol-aware per-model curl, mlserver fallback runner option, invalid-catalog-entry
  warning.
- **Docs/ADR:** ADR-021 (protocol-family path prefixes; amends ADR-020's "proxy untouched"
  consequence), docs sweep for the prefix change, runner-catalog guide updates.
- **Tests:** 7 new proxy integration cases (`test_oip_surface.rs`), shared engine-runner
  conformance suite (`runners/conformance/`, 8 cases × both shims) — which surfaced and
  fixed a pre-existing vLLM shim contract bug (`kvCacheElasticSharing` nested under
  `features` instead of top-level), MLServer shim pytest suite (24), Gate 11
  (Apptainer launch/health), regression coverage for `/openai/v1` and entrypoint fallback.

## Verification status

All local gates pass on `milestone-M9`:

| Gate | Result |
| ---- | ------ |
| `make typecheck` / `make lint` (incl. clippy `-D warnings`) | pass |
| `make lint-specs` + codegen-drift check | pass / clean |
| vitest: control-plane / dev-worker / dashboard | 438 / 194 / 522 — all pass |
| control-plane `test:integration` (live Redis+Postgres) | 24/24 |
| cargo test (+ `--features redis-integration`) | 48/48 (+133) |
| pytest: vLLM / MLServer / shared conformance | 17 / 24 / 16 |

Review: 4 parallel reviewers (spec, quality, security, boundary) + interim boundary reviews
per contract-touching unit → 1 medium finding (shim `parameters.uri` containment), fixed and
re-verified in round 1. Independent acceptance audit: ACCEPTED, no rework.

**Needs cluster/GPU (not locally provable):** real SIF build + sign + ORAS publish/import,
live MLServer deploy/infer/sleep-wake on GPU, SCC admission, dashboard→deploy→infer e2e,
Gate 11 Apptainer launch (`MLSERVER_SIF`). **Needs host run:** none — cargo gates ran locally.

## Deferred / follow-ups filed during execution

- #159 — vLLM engine binds `127.0.0.1` (latent multi-node gap; deliberately untouched here)
- #160 — OIP runner port-block allocation vs. fixed gRPC/metrics offsets
- #161 — CI does not run the shim pytest suites or the conformance suite

## Closes

closes #125
