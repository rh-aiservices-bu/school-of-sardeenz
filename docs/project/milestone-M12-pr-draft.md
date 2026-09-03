# Milestone M12: Runner & Engine Hardening — PR draft

> Draft PR description for `milestone-M12` → `dev`. Delete this file after opening the PR.

## Title

`M12: Runner & Engine Hardening — vLLM bind host, per-runner port blocks, Python CI gate (#159, #160, #161)`

## Summary

Three squash commits, one per issue, in milestone order. No OpenAPI spec, generated type,
Rust mirror, Redis-published shape, control-plane or proxy code changed across the milestone
(`git diff --stat ac2f98e..HEAD -- packages/ proxy/ control-plane/` is empty).

### #159 — vLLM engine bind host configurable, default `0.0.0.0` (`86e25de`)

- `runners/vllm` shim: new `--engine-host` flag (default `0.0.0.0`) threaded through `RunnerArgs`
  into `build_vllm_command`, replacing the hardcoded `--host 127.0.0.1`. Mirrors the MLServer shim
  exactly (plain flag, no env override, since MLServer has none). The dev-worker launcher passes
  nothing and relies on the default.
- `VllmEngine._base_url` (shim → own engine health/sleep/wake) stays on loopback.
- Regression tests: default host, custom host; test renamed to describe the new assertion.
- READMEs: vLLM (`--host 0.0.0.0`, configurable) and the now-stale MLServer cross-reference.

### #160 — Per-runner 4-port block; explicit MLServer gRPC/metrics ports (`c38b3e6`)

- Decision (project lead): uniform contiguous block for **every** runner —
  `(mgmt, engine, gRPC, metrics) = (base, base+1, base+2, base+3)`, protocol-agnostic, **no
  contract change** (`protocol` does not reach the worker and doesn't need to).
- `runners/dev-worker`: `allocatePorts` scans `[SARDEENZ_RUNNER_PORT_START, +SARDEENZ_MAX_RUNNERS*4)`
  with stride `PORTS_PER_RUNNER = 4`, whole-block `workerPort` skip, `probePort` on all four
  ports; `usedPorts` still tracks only `base`, so stop/crash cleanup is unchanged. `LaunchSpec` /
  `RunnerRecord` carry gRPC/metrics; the Apptainer launcher always injects
  `SARDEENZ_MLSERVER_GRPC_PORT` / `SARDEENZ_MLSERVER_METRICS_PORT` (vLLM ignores them).
  `StubLauncher`, `LaunchHandle`, `StartRunnerResponse` untouched.
- `runners/mlserver` shim: `+10000/+20000` offsets remain only as a **logged fallback** for
  standalone runs; the 65535 guard stays on that path (unreachable from a worker launch: max
  metrics port with defaults is 9228).
- `make dev-worker-2` caps each worker at `SARDEENZ_MAX_RUNNERS=24` (24 × 4 = 96 fits each
  worker's 100-port window; the wider stride would otherwise overlap worker-1's 9200 block).
- Docs: `runner-contract.md`, MLServer README, ADR-019 wording ("pair scan" → 4-port block),
  `.env.example` range formula.

### #161 — Python runner-shim + conformance suites gated in CI (`b0113b4`)

- New `python` GitHub Actions job (sibling of `quality`/`e2e`; `actions/setup-python` pinned by
  SHA, verified against the upstream `v5` tag; Python 3.12 via root `.python-version`; inherits
  `permissions: contents: read`; no `continue-on-error`). Installs only the shims' `[test]` extras
  (`pytest`, `fastapi`, `httpx` — never vLLM/torch/MLServer) and runs `runners/vllm/tests`,
  `runners/mlserver/tests`, `runners/conformance` (72 tests).
- Local: `make test-python-deps` → `make test-python`. **`make test` is unchanged.**
- Root `pytest.ini` sets `--import-mode=importlib` so the three suites collect in a single
  invocation despite both shims shipping `tests/test_core.py` (previously "import file mismatch");
  per-shim `cd runners/<x> && pytest` still uses that shim's own `pyproject.toml` config.
- Docs: conformance README (install command corrected to `[test]` extras, CI note), shim READMEs,
  `docs/development/setup.md` make-targets table.

## Verification status

All gates ran locally in the execution container (cargo present — **no host cargo run needed**):

| Gate | Result |
| ----- | ------ |
| `make typecheck` (tsc, e2e tsc, `cargo check`) | PASS |
| `make lint` (eslint, Redocly, `cargo clippy --all-targets -- -D warnings`) | PASS |
| `make lint-specs` / codegen drift | PASS (no-op — no spec changed) |
| `npm test` (all TS workspaces) | 87 files, 1324 passed, 1 skipped |
| `cargo test` (proxy) | 0 failed |
| Python: fresh venv → `make test-python-deps` → `make test-python` | 72 passed (vLLM 30, MLServer 26, conformance 16) |
| Runtime (#160): isolated stub worker from `c38b3e6` | ports `19101` → `19105` (stride 4); block reused after delete; MLServer env path `9103/9104`, fallback `19102/29102` + warning |
| Runtime (#159): `build_vllm_command` argv | `--host 0.0.0.0` default; `--host 10.1.2.3` with `--engine-host` |

Each issue passed three parallel Opus reviews (conformance / quality / security), one cosmetic
fix round, an Opus verification pass on the milestone branch, and an independent fresh-Opus
acceptance check plus an orchestrator spot re-run.

**Needs host run:** none.
**Needs cluster:** none of the M12 changes is cluster-gated. The `python` CI job itself is
validated structurally only (`act` unavailable) — its first real run is this PR's CI.

## Follow-ups filed during execution

- #181 (M13, `area/security`): the `sif-runner` NetworkPolicy allows only control-plane → 9100;
  off-node proxy → engine reachability (the goal #159 enables in code) still needs a
  proxy-scoped ingress rule — and with #160, gRPC/metrics now sit *inside* the engine port range,
  so a range-based rule would expose those unauthenticated servers too. Needs a security-doc note.
- #182 (Parking Lot): CI-only pip constraints file for the `python` job (test deps are unpinned).

## Deferred / not done

- Nothing from the three issues was deferred.
- Three local issue branches (`fix/159-vllm-engine-bind-host`, `feat/160-runner-port-block`,
  `feat/161-python-ci-gate`) are left for the maintainer to force-delete — squash merges are not
  "merged" to git and the local safety hook blocks force-deletes.

Closes #159
Closes #160
Closes #161

https://claude.ai/code/session_01Aqf1QagGfrUmtpwstkfM8F
