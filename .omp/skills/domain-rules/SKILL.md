---
name: domain-rules
description: Sardeenz v2's hard invariants and documentation rules as a review checklist — OpenAPI contracts as the only cross-component wire, contract codegen never hand-edited, Kustomize deployment, SIF runners on shared RWX storage, NVML-measured VRAM only, requiredMemory as placement input, JWT auth on the BFF, secrets never committed, dev-branch git flow. Preloaded into the implementer, blueprint-implementer and reviewer agents via their autoloadSkills frontmatter; load it when writing or reviewing changes outside those agents.
hide: true
---

# Sardeenz v2 Domain Rules — Review Checklist

These are the non-negotiable rules for this repository. Every change must
comply. Violations break the product's integrity.

> **See also:** the `AGENTS.md` key facts and the ADRs in
> `docs/architecture/adrs/` (ADR-001 to ADR-021). Verified platform facts
> live in the ADRs and `docs/project/status.md`.

## 1. OpenAPI contracts are the only wire (ADR-005, ADR-002)

The four components (proxy, control plane, dashboard BFF, runners) talk
only through the OpenAPI contracts in `packages/contracts/`. Never add a
side-channel API, a private REST shape, or a hand-rolled serialization
between components.

**Check:** cross-component request/response shapes trace to a spec file
in `packages/contracts/`; TypeScript types come from `packages/types`
(generated); no new ad-hoc HTTP contract between services.

## 2. Generated types are never hand-edited (ADR-005, ADR-012)

TypeScript types are generated from the spec (`make codegen` →
`packages/types`); Rust types in `proxy/` are hand-maintained to mirror
the spec.

**Check:** a diff that edits files under `packages/types/` directly, or
that changes a contract without running codegen and updating consumers in
the same diff, is a high finding. A Rust type that drifts from the spec
is a high finding.

## 3. VRAM is measured-only; requiredMemory is a placement input (ADR-011)

VRAM shown to users is NVML-measured. `requiredMemory` is an input to
worker placement, never a user-facing "reserved" figure. No code path may
present `requiredMemory` as reserved capacity.

**Check:** UI text and API fields distinguish measured from required; a
"reserved" label on `requiredMemory` is a high finding.

## 4. Runners, not plugins; SIF delivery (ADR-010, ADR-015, ADR-017)

Engine abstractions are "runners". Runtimes ship as Apptainer SIF files
on shared RWX storage, executed by the slim worker; official SIFs are
distributed via ORAS from the `runners.yaml` catalog. Runner shim
dependencies stay unpinned in-repo (they install atop the SIF); CI pins
its own set.

**Check:** terminology is "runner" everywhere; no pinned shim dependency
without a comment; no second SIF build/distribution path outside
`scripts/build-sif.sh` + `deployment/librarian/` + `runners.yaml`.

## 5. Proxy paths split by protocol family (ADR-021)

Serving paths are `/openai/<...>` or `/oip/<...>`; configuration name and
served model name are distinct (ADR-020); a logical model has one or more
instances (ADR-019).

**Check:** a new engine joins the protocol-family table rather than
inventing a top-level prefix; config vs served-model naming is kept
distinct in routes, UI and stores.

## 6. BFF auth: JWT with a minimal public surface (ADR-013)

`dashboard/server/plugins/auth.ts` guards non-public routes with
`authenticate` / `requireRole`; `PUBLIC_PATHS` stays minimal; the SSE
`?token=` fallback paired with the `sardeenz_sse` cookie is the one
designed exception. `AUTH_MODE=none` is a dev-only posture.

**Check:** every new protected route registers `authenticate` or
`requireRole`; a new public path is a finding to justify; tokens never in
`localStorage`; no anonymous path to the control plane through the BFF.

## 7. Secrets never committed (ADR-013)

API keys and credentials live in deployment env (`SARDEENZ_*` prefix),
never in code, migrations, logs, committed config or dashboard state.

**Check:** no secret value in backend code, migrations, test fixtures
that commit real values, logs or `.env` files in the repo.

## 8. Git permissions (`.omp/RULES.md`)

Committing is allowed without asking — on the correct branch per
`docs/development/setup.md` (never `main`, never direct pushes to `dev`;
branch from `dev`, PR back to `dev`). Pushing to any remote and creating
a PR ALWAYS require the user's explicit permission in the current
conversation. NEVER force-push. NEVER amend and push a branch the user
has already reviewed without asking again.

**Check:** no push, no PR, no `git commit` on `main`/`dev`, no
force-push in any agent instruction or code path. Issue closing is the
user's.

## 9. Deployment is Kustomize (ADR-008, `deployment/`)

Manifests are Kustomize (`deployment/kustomization.yaml`, per-component
dirs, `deployment/overlays/`). No Helm charts; infrastructure changes
update the overlays and prereq manifests together.

**Check:** an infra diff adding a chart, a template engine, or editing
one overlay while leaving `prereq/` inconsistent is a finding.

## 10. Documentation is the project's memory (`AGENTS.md`, `docs/`)

`AGENTS.md` stays lean (index + key facts + instructions); knowledge
lives in `docs/` pointed at from there. ADRs are admission-gated and
superseded, never deleted. `docs/project/status.md` is rewritten when a
phase or milestone closes; `CHANGELOG.md` gains an `[Unreleased]` entry
before committing.

**Check:** a behavior/design change updates `docs/architecture/`,
`docs/project/status.md` and ADRs where admission applies; obsolete docs
are removed. A commit without a CHANGELOG entry under `[Unreleased]` is a
finding.

## 11. Verification discipline (root `AGENTS.md`)

`make lint typecheck test` is the pre-commit gate; `make test-python`
covers the Python shims. UI changes are verified in the browser. Runner
changes run the Python suites; contract changes run codegen and the
consumers' suites.

**Check:** completion claims carry gate evidence; a UI change without
browser verification is a finding (stated as not-locally-verifiable when
the runtime is absent).
