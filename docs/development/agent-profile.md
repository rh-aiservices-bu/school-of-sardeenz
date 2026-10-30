# Agent project profile — Sardeenz v2

Filled from the template at `.omp/skills/implement-milestone/references/project-profile.template.md`.
`plan-milestone` and `implement-milestone` refer to these sections **by
name**; keep every section filled or the skills stop and ask.

Keep it factual and short. This is project knowledge, so it lives in the
repository, not in anyone's personal memory. Rationale for a choice
belongs in a decision record; put the pointer here.

---

## Identity

- **Project:** Sardeenz v2 — high-density GPU workload orchestration
  platform (software-defined VRAM multiplexer at L7). Repository:
  `rh-aiservices-bu/school-of-sardeenz` (GitHub).
- The user owns pushes, PRs and issue closing (never the agent) — see
  `.omp/RULES.md`.

## Models

- **Orchestrator (session):** any capable session model; skills are
  model-agnostic. If the session model is silently downgraded
  mid-run (see *Known fallback behavior*), a fresh acceptance agent
  still catches the drift.
- **Role agents** (spawned through their `.omp/agents/*.md` definitions;
  the definitions carry model, tools and preloaded rules):

  | Role | Agent definition | Model alias | Tools |
  |---|---|---|---|
  | Builder (Light) | `blueprint-implementer` | `plan` | read, edit, write, glob, grep, bash, task, wait |
  | Implementer / fixer | `implementer` | `slow` | read, edit, write, glob, grep, bash, task, wait |
  | Reviewer | `reviewer` | `plan` | read, glob, grep, bash, write |
  | Boundary reviewer | `boundary-reviewer` | `plan` | read, glob, grep, bash, write |
  | Verifier | `verifier` | `plan` | read, glob, grep, bash, write |
  | Acceptance | `acceptance` | `slow` | read, glob, grep, bash, write |

  Model aliases resolve through `modelRoles` in the omp config
  (`default`/`plan`/`vision`/`slow`). Never pass explicit model IDs on a
  task item.
- **Bare-model roles** (planner, plan reviewer, grouper, item author,
  Full blueprint, spike, sync, drift check): pass `model: plan` on the
  task item (the planning role alias). For the spike role on a
  feasibility-critical question, `model: slow`.
- **Acceptance:** always a subagent, on the `slow` alias — a different
  tier from the `plan`-model reviewers.
- **Report channel:** a spawned agent writes its full report to
  `/workspace/.omp/reports/<role>-<id>[-r<R>].md` (gitignored scratchpad;
  never `logs/`, never a worktree) and returns a ≤10-line summary ending
  in the verdict as its final message; summaries also go to
  `agent://all` when peer messaging is enabled. Wait on report files
  (`/workspace/.omp/reports/…`) with a ≤300 s cap per wait, re-arming on
  expiry.
- **Known fallback behavior:** the omp runtime may fall back along the
  `retry.fallbackChains` in the config. Detect it in subagent transcripts
  via the model metadata in `agent://<id>` output; a mid-run downgrade is
  why acceptance is always a separate `slow`-model subagent.
- Rationale for the tiering: reviewers read (`plan`), writers and the
  acceptance gate get the stronger `slow` model.

## Tracker

- GitHub (`gh`). Milestones are named `Milestone M<N>: <title>`
  (e.g. `Milestone M13: Feature & Resilience Backlog`); older ones are
  `M<N>: <title>`. There is also `Parking Lot: Deferred / Non-Blocking`.
- Commands:
  - List milestones: `gh api repos/{owner}/{repo}/milestones --jq '.[] | "\(.number) \(.title)"'`
  - Open issues in a milestone: `gh issue list --milestone "<title>" --state open`
  - Issue with comments: `gh issue view <N> --json title,body,comments,milestone,state`
  - Comment: `gh issue comment <N> --body-file <file>`
  - Labels: `gh label list`; add: `gh issue edit <N> --add-label <label>`
- **Decision comments:** `**Decision (YYYY-MM-DD): …**` — authoritative;
  they override body and spec text.
- **Spec comments:** first line `**Spec (YYYY-MM-DD)**`, then the
  work-item template headings verbatim
  (`.omp/skills/implement/references/work-item-template.md`). The latest
  one supersedes earlier spec comments in full; decisions override it.
- Labels in use: `component/{proxy,contracts,control-plane,dashboard,devtools,docs}`,
  `priority/P0-critical … P3-low`, `area/{observability,security,correctness,testing,contracts,resilience}`,
  `bug`, `enhancement`, `documentation`. Pipeline labels
  (`pipeline/direct|light|full`) do not exist yet — create on first use.
- `$ARGUMENTS` matches a milestone by number or title substring
  (`M13`, `M13: Feature`, `13`).

## Branching

- Base branch: `dev` (integration). `main` is releases only. Branch from
  `dev`, PR back to `dev` (see `docs/development/setup.md`).
- Branch prefixes: `feature/`, `fix/`, `chore/` (existing convention:
  `fix/placement-tooltips-no-instance-id`).
- Milestone branch: `milestone/m<n>-<slug>` (new convention; create on
  first milestone run). Issue branch inside a worktree: `wt/<slug>`.
- Commit message format: conventional commits —
  `type(scope): summary` (e.g. `fix(control-plane): drain-stall on metrics scrape`).
  Milestone-issue commits carry `(#<N>)`; fix rounds
  `fix: address review findings for <slug> (round R)`.
- Integrate sequence (per issue): from the main checkout —
  `git merge --squash wt/<slug>` → `git commit -m "type(scope): summary (#<N>)"` →
  `git worktree remove <W>` → `git branch -f wt/<slug> <B>` →
  `git branch -d wt/<slug>`.

## Layout

- npm monorepo (`package.json` workspaces): `control-plane`,
  `dashboard` (with `dashboard/server` = BFF), `packages/*`
  (contracts, generated types, utils), `runners/dev-worker`. The Rust
  proxy is a cargo workspace rooted at `proxy/`. Python shims live under
  `runners/vllm`, `runners/mlserver`, `runners/conformance`.
- Shared packages: `packages/types` (generated from
  `packages/contracts`), consumed by control-plane, dashboard and BFF.
- Worktree location: `/workspace/.omp/worktrees/task-<slug>` (gitignored).
- Dependency install in a fresh worktree: `npm install` at the repo root
  (never pnpm — hardlink store breaks across the container/host mount).
- Where blueprints enumerate at symbol level:
  - OpenAPI specs: `packages/contracts/` (source of truth; TypeScript
    types generated via `make codegen` → `packages/types`; Rust types
    hand-maintained in `proxy/src/`).
  - DB migrations: `control-plane/migrations/*.sql`; stores in
    `control-plane/src/clients/`.
  - Control-plane routes: `control-plane/src/routes/`.
  - BFF routes/plugins: `dashboard/server/routes/`, `dashboard/server/plugins/`.
  - Dashboard UI: `dashboard/src/` (PatternFly 6).
  - Config/env definitions: per-service `config.ts`; `SARDEENZ_*` env
    prefix; wired through `deployment/` Kustomize manifests.
  - Error codes: `control-plane/src/utils/`, `dashboard/server/errors.ts`.
  - i18n strings: `dashboard/src/i18n/` (see `docs/development/i18n.md`).

## Verification

- **Cheap gate** (Direct): `npx tsc --build` (or `make lint` for
  spec/docs-only changes; for pure docs, re-read the diff).
- **Scoped gate** (Light): `make lint typecheck test` restricted to the
  touched workspace — `npm run lint -w @sardeenz/<ws>`,
  `npm run typecheck -w @sardeenz/<ws>` (dashboard:
  `tsc --noEmit -p tsconfig.app.json`; BFF has its own tsconfig),
  `npm test -w @sardeenz/<ws>`. One suite at a time; never `CI=true`.
- **Full gate** (Full): root `make lint typecheck test` (+ `make
  test-python` when the Python shims changed and a venv exists; `cargo
  check`/`cargo test` in `proxy/` when Rust changed and cargo is
  available; Postgres integration tests need `TEST_DATABASE_URL`).
- **Infra completeness:** Kustomize manifests render
  (`kustomize build deployment/overlays/school-of-sardeenz`), prereq
  manifests updated together with the component overlay, and
  `deployment/AGENTS.md`-relevant docs touched.
- Completeness layers (from root `AGENTS.md` + `.omp/` convention):
  contracts + generated types, DB migrations + stores, control-plane
  routes, dashboard + BFF, deployment (Kustomize), tests, docs,
  `CHANGELOG.md` under `[Unreleased]`, and `.omp/` agent config when
  behavior changed.

## Runtime verification

- `npm run dev` at the repo root starts proxy + control-plane + dashboard
  + BFF via concurrently; logs land in `logs/*.log`
  (`logs:proxy`, `logs:cp`, `logs:dashboard`, `logs:bff` targets tail
  them). Restart needed for control-plane/BFF config changes; Vite hot-
  reloads the dashboard.
- Dashboard URL: `http://localhost:5173` (override with
  `SARDEENZ_DASHBOARD_PORT`). Drive it with the Eval `browser` facade;
  interactive scenarios go through the `test-ui` skill
  (`dashboard/e2e/*.spec.ts` are the Playwright source of truth).
- Infra: `kustomize build deployment/overlays/<name>` and
  `kubectl apply --dry-run=client` validate locally; cluster admission,
  live SIF builds and GPU placement are deploy-only.

## Hard triggers

Force Full regardless of diff size, mapped to the generic list:

- Schema or migrations: `control-plane/migrations/**`,
  `control-plane/src/clients/**` (stores).
- Shared packages: `packages/contracts/**`, `packages/types/**`,
  `packages/utils/**`.
- Auth/session/scoping: `dashboard/server/plugins/auth.ts`,
  `dashboard/server/routes/auth.ts`, control-plane auth middleware.
- Secrets/env config: `**/config.ts`, `SARDEENZ_*` env wiring,
  `deployment/prereq/**`.
- Infra/CI: `deployment/**`, `.github/**`, `Makefile`, `containers/**`.
- Security label (`area/security`) or external input parsing
  (proxy request handling: `proxy/src/**` routes/body limits).
- Cross-service changes: proxy ↔ control-plane, control-plane ↔ BFF, or
  contract + consumer in the same diff.
- Any issue with an open question.

## Project references

- Named rule sets: root `AGENTS.md` (key facts + workflow rules),
  `.omp/RULES.md` (git permissions), `.omp/skills/domain-rules/SKILL.md`
  (11 rules — reviewers check them all),
  `docs/development/coding-standards.md` (TS/Rust/cross-language).
- Boundary-review instructions: the `boundary-reviewer` agent definition
  (`.omp/agents/boundary-reviewer.md`) carries its dimensions.
- Project skills implementation may invoke: `/scaffold-component`
  (dashboard component boilerplate), `/contract-codegen` (OpenAPI → TS
  types), `/test-ui` (browser scenarios), `/verify` (quality gate).
- Exemplar directories: `control-plane/src/routes/` (routes),
  `dashboard/server/routes/` (BFF routes), `dashboard/src/` (PatternFly
  components), `packages/contracts/` (spec files),
  `control-plane/src/routes/__tests__/` (route tests).

## Wrap-up artifacts

- **Plan file** (`plan-milestone` writes, `implement-milestone` reads):
  `/workspace/.omp/plans/m<n>-plan.md`.
- **Notes file** (per milestone): `/workspace/.omp/plans/m<n>-notes.md`.
- **Status document**: `docs/project/status.md` (rewrite when a phase or
  milestone closes).
- **Roadmap**: `docs/project/overall-plan.md`.
- **Decision records**: `docs/architecture/adrs/` (`adr-<NNN>-<slug>.md`;
  status vocabulary: `_(superseded by ADR-X)_`, `_(amended by ADR-X)_`,
  `_(refines ADR-X)_` — see `docs/architecture/adrs/README.md`).
- **Changelog**: `CHANGELOG.md`, `[Unreleased]` section per milestone.
- **PR draft**: `/workspace/.omp/plans/m<n>-pr.md` (existing convention).

## Content hazards

- None known. The project handles GPU orchestration configs, not
  safety-sensitive content. If a future run introduces such content,
  update this section before routing it through agents.

## Instrumentation

- Model fallbacks: inspect spawned agents' `agent://<id>` output for the
  model field after a run; match against the `plan`/`slow` aliases in
  *Models*.
- Orchestration cost: not defined; add a command here if the user asks
  for cost capture.

## Sizing heuristics (used by plan-milestone)

- A manageable milestone: 3–8 issues, one autonomous run of a few hours,
  at least one shared-groundwork item called out explicitly.
- A modest diff for Light: order of 150 changed lines, not 500; single
  component, follows an existing exemplar.

## Lessons

- 2026-10-30 — Agent definitions and skills were imported from another
  project (agents-jukebox) with wrong models (nonexistent IDs), wrong
  package manager (pnpm), wrong infra (helm), wrong auth (Keycloak) and
  wrong e2e layout (`dev-tools/e2e-scenarios/`); all rewritten for
  sardeenz in this session. The method (pipelines, roles, reports)
  carried over; repository facts did not.
