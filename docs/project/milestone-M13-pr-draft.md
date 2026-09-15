# PR draft — Milestone M13: Feature & Resilience Backlog (partial)

> Draft description for the `milestone-M13` → `dev` PR. Delete this file after opening the PR.

**Title:** `M13: resilience and dashboard hardening (#149, #178, #179, #181)`

---

## Summary

This branch integrates four independently reviewed and accepted M13 issues. Two milestone issues,
#146 and #187, are deliberately excluded because their review budgets ended with unresolved high
findings. Their recovery branches and worktrees are retained below.

### #181 — Scope worker ingress to runner traffic

- Permit control-plane access only to the worker management ports (`9101..9225`, step 4).
- Permit routing-proxy access only to the engine HTTP ports (`9102..9226`, step 4).
- Keep runner gRPC and metrics ports outside the allowed ranges.
- Pin the relevant deployment environment and document the NetworkPolicy and namespace-label
  trust boundary.
- Add manifest tests covering allowed and denied port/source combinations.

### #149 — Cap concurrent Playground inference requests per user

- Add a dashboard BFF concurrency limiter with a strict positive-integer environment setting,
  `SARDEENZ_BFF_MAX_CONCURRENT_INFERENCE_REQUESTS_PER_USER` (default: 4).
- Key authenticated requests by verified username and anonymous requests into a shared bucket.
- Return 429 before contacting the upstream proxy when the per-user limit is reached.
- Release capacity idempotently across response completion, errors, aborts, and disconnects.
- Document that limits are maintained independently by each BFF replica.

### #178 — Include public assets in the dashboard build-freshness guard

- Recursively compare `dashboard/public/` with the built dashboard output before bare Playwright
  runs.
- Include directory timestamps so deletions and renames invalidate stale output.
- Reject symlinks, cycles, and empty source trees instead of silently accepting ambiguous input.
- Add isolated coverage for the freshness guard's public-asset cases.

### #179 — Cover notification-drawer accessibility

- Add semantic styling for the subtle notification token.
- Add a typed mock notification endpoint for dashboard end-to-end tests.
- Exercise the populated notification drawer and inline actions with a whole-page axe scan.
- Label the notification region and action menu for assistive technology.

## Verification status

All combined local gates pass on `milestone-M13`:

| Gate                                              | Result                                |
| ------------------------------------------------- | ------------------------------------- |
| `make lint` / `make typecheck`                    | pass                                  |
| Vitest via `make test`                            | 1,345 passed, 1 intentionally skipped |
| `cargo test -q`                                   | 124 passed (37 + 39 + 48)             |
| #181 focused deployment-manifest test             | 3 passed                              |
| #149 focused limiter and inference tests          | 20 passed                             |
| #178 focused Playwright freshness tests           | 7 passed                              |
| #179 focused axe test and dashboard e2e typecheck | pass                                  |

Each included issue passed independent review, verification, and acceptance. #181 and #179 each
needed one review-fix round; #149 passed its first review; #178 passed after one review-fix round.

**Needs a live cluster:** validate #181 against the deployed CNI and namespace-label governance.

## Stopped and not included

### #146 — Move a running model between workers

Review stopped after three rounds with unresolved high findings around ambiguous runner-start
failures and the missing proxy-propagation/quiescence barrier before draining the source runner.
Cross-leader fencing and crash recovery also need further hardening.

- Recovery branch: `feat/146-move-model-action`
- Recovery worktree: `/workspace/.claude/worktrees/issue-146`
- Latest coherent commit: `50b9454`

### #187 — Service-container build CI

Review stopped after three rounds because the new `.mjs` runtime-packaging verifier is not covered
by the repository's ESLint override and therefore makes the required quality gate fail. Docker,
Podman, and Buildah were also unavailable locally, so container-runtime verification remains for a
capable host after the lint blocker is fixed.

- Recovery branch: `feat/187-service-container-ci`
- Recovery worktree: `/workspace/.claude/worktrees/issue-187`
- Latest coherent commit: `a497d59`

## Closes

closes #149
closes #178
closes #179
closes #181
