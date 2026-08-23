# PR Draft — Milestone M8: Dashboard v1 Parity & UX

> Draft for the `milestone-M8` → `dev` PR. Delete this file after opening the PR.

**Title:** `Milestone M8: Dashboard v1 Parity & UX (#106, #67, #122, #123, #124, #126)`

---

## Summary

Executes all six M8 issues as one squash commit per issue on `milestone-M8`. v1-parity UX on the
v2 architecture: Chatbot Playground, worker-grouped GPU memory view, placement-board home with
inference URL, capability-driven deploy form, the NotificationProvider auth-gate fix, and the
engineArgs delivery rework (which also unblocks M9/#125).

Every issue went through the full quality loop: Opus blueprint → Sonnet implementation → 2–3
fresh Opus reviewers (spec conformance / quality+security / contract boundary) → fix rounds where
findings warranted (3 of 6 issues, one round each) → post-merge verification on the milestone
branch → independent Opus acceptance control with an orchestrator-run spot gate.

## Per-issue summary

| Issue | Commit | What shipped | Review rounds |
| ----- | ------ | ------------ | ------------- |
| #106  | `574fa9b` | `NotificationProvider` relocated inside the auth gate; live list capped at 200; all 5 swallowed API errors logged, history-load failure surfaced in the drawer | 1 (clean) |
| #67   | `9a300fd` | `WorkerInfo.runnerCapabilities` (contract, additive); deploy form runner/device options from live worker capabilities with fallback + reconciliation; reusable `useRunnerTypes()`/`useWorkerCapabilities()` | 2 (deviceType reconciliation fix) |
| #122  | `58bfe10` | Admin-only Chatbot Playground: BFF streaming passthrough `POST /api/inference/chat/completions`, fetch+reader SSE client, 1–2 independent panes, ACTIVE+SLEEPING sidebar, `SARDEENZ_INFERENCE_URL` | 2 (Stop-wedge HIGH + unmount-abort MEDIUM fixed) |
| #123  | `0ce97d8` | `/gpu-memory` page: per-GPU stacked per-model VRAM bars grouped by worker, sleeping hatch, deterministic colors; `memoryUsedBytes` populated from `requiredMemory`, labeled "(reserved)"; reusable `WorkerGpuSection` | 2 (panel legibility + tooltip honesty fixes) |
| #124  | `8788fff` | Home placement board composing `WorkerGpuSection` + placement summary; copyable inference URL banner via new secret-safe BFF `GET /api/config`; per-model curl on ModelDetail. **Move-model deferred → #146** | 1 (clean) |
| #126  | `e898f61` | `engineArgs: string[]` across both specs (engineConfig deprecated, kept), migration 004, delivered end-to-end to the engine argv after `--`; reserved-flag rejection incl. argparse-abbreviation hardening; flag-lines UI; **folds in the tensorParallel wiring fix** (multi-GPU was silently single-GPU) | 2 (abbreviation-bypass MEDIUM fixed) |

## Verification status

- `make typecheck` and `make lint` fully clean at the final tree (all legs, incl. `cargo check`
  / `cargo clippy -D warnings` — the proxy is untouched by M8 but the gates ran).
- Contracts: `validate` green; codegen drift zero (checked per contract-touching issue and at
  acceptance). No Rust-mirror changes needed — the proxy consumes none of the changed shapes
  (grep-verified twice).
- Root test suite at final tree: **1086/1086** (control-plane 389+, dashboard 511, dev-worker 179).
- **Live checks that passed:** `GET /api/v1/workers` shows `runnerCapabilities` end-to-end (#67);
  BFF inference route registered + pre-hijack 502 path live (#122); cluster-memory endpoint shape
  (#123/#124); **control-plane `test:integration` against live Postgres/Redis — migration 004 +
  `engine_args text[]` round-trip PASSED** (16/17; the 1 failure is pre-existing drift → #150).
- **Not locally verifiable** (container has no browser/Playwright; no GPU model): rendered UI for
  the playground/board/bars (themes, hatch, ClipboardCopy UX), real token streaming +
  wake-on-request UX, login-flow ACs of #106 (dev runs `AUTH_MODE=none`). Suggested manual pass
  after merge: open `/`, `/gpu-memory`, `/playground`, deploy a model with engine args, chat.

## User actions

- **Restart the dashboard dev server** — the running BFF pre-dates #124/#122 hot-reload boundaries
  (`/api/config` 404s until restart). The control plane already restarted; migration 004 is
  applied to the dev DB.
- Delete the six local issue branches after merging (kept per your instruction; each is fully
  contained in its squash commit): `fix/106-notification-provider-auth-gate`,
  `feat/67-deploy-form-capabilities`, `feat/122-chatbot-playground`, `feat/123-gpu-memory-viz`,
  `feat/124-placement-board`, `fix/126-engine-args`.
- Delete this draft file after opening the PR.

## Follow-up issues filed during execution

- #146 — Move-model action for the placement board (deferred from #124 by decision)
- #147 — Workers endpoints: emit full `WorkerRunnerCapability` + align instance-state filters
- #148 — Dashboard test infra: dual React installs break @testing-library rendering repo-wide
- #149 — Playground: cap concurrent inference streams
- #150 — Integration test drift: deploy-timeout assertion regex (pre-existing, surfaced by live run)
- #151 — Per-model VRAM: per-instance reservation map as the measurement seam (carries the
  #123-acceptance correction: reservations persist through sleep; only STOP releases)

## Notes for reviewers

- #123's `memoryUsedBytes` is the configured `requiredMemory` (labeled "(reserved)" in the UI) —
  the issue's `currentMemory` premise does not exist in code; see the #123 status comment and #151.
- #126's reserved-flag guard rejects proper-prefix abbreviations at both the dashboard and the
  launcher; the control plane caps `engineArgs` at 128 items / 512 chars each.

---

closes #106, closes #67, closes #122, closes #123, closes #124, closes #126

https://claude.ai/code/session_01P9gqCvG2byLKNxJeVYqNRE
