# Sardeenz Milestone Execution Workflow

## Purpose and control model

Run a GitHub milestone for `rh-aiservices-bu/school-of-sardeenz` issue by issue. Preserve this chain:

- The root Codex agent orchestrates, integrates, communicates with the user, and personally runs a factual acceptance check.
- Fresh `gpt-5.6-sol` agents at `xhigh` reasoning plan, blueprint, review, verify, and accept.
- Fresh `gpt-5.6-terra` agents at `high` reasoning implement and fix.

Set `fork_turns: "none"` whenever assigning a model or reasoning override. Supply every agent the exact context its role needs. This separation provides model-family diversity between construction and judgment plus fresh-context isolation between review and acceptance. Reports are not facts: the root agent's own spot re-run remains mandatory.

Codex has four concurrent slots including the root. Run at most three subagents at once. A wave may contain at most three issue agents or three reviewers. Use fresh agents per issue and role; never reuse an agent across implementation, review, verification, or acceptance.

Subagents share the filesystem. Give each an absolute worktree path and forbid writes outside it. Only the root agent changes the main checkout and integrates issue branches.

## Repository authority and invariants

At the start, read the root `AGENTS.md`, the `AGENTS.md` for every affected component, the milestone description, complete issue bodies and comments, and relevant architecture docs. Current code and docs override stale memory.

Preserve these invariants:

- OpenAPI specs under `packages/contracts/specs/` are authoritative. A contract change flows spec → `npm run codegen -w @sardeenz/types` → hand-maintained Rust mirror in `proxy/src/generated/` when applicable → `make lint-specs`. Never hand-edit generated TypeScript.
- Components remain contract-decoupled. The proxy is stateless; routing state comes from Redis and it calls the control plane only for wake triggers. The control plane owns VRAM budgeting and lifecycle.
- Runtimes are signed Apptainer SIFs distributed through the runner catalog. Use “runner,” never “plugin.”
- GPU memory exposed to users is measured-only. Never expose “reserved” VRAM; `requiredMemory` is only a placement input.
- Preserve the `modelName` / `servedModelName` / `displayName` / `modelPath` distinctions and `/openai` / `/oip` protocol split.
- Use npm, never pnpm. Stage specific files, never `git add -A`. Update `CHANGELOG.md` under `[Unreleased]` before every final issue commit. Root `make lint` and `make typecheck` are required; all lint failures block completion.
- Dashboard work uses PatternFly 6 and i18n for user-facing strings.
- Never use real or ignored project files such as `.env` as scratch. Use `/tmp` for temporary data.
- GitHub network operations use `gh` and HTTPS credentials, not SSH.

Detect `cargo` once. If absent, record Rust gates as “needs host run”; never claim they passed. Inspect `logs/` before asking the user for host dev-server output. Container access to host services may require `host.containers.internal` as documented by the repository.

## 1. Resolve and inspect

Parse `$ARGUMENTS` as a milestone identifier (`M13` or `13`) and optional issue number.

1. Use `gh` to list repository milestones and open issues for the matching full milestone title. Read the milestone description.
2. If there are no open issues, stop. This skill executes issue specifications; it does not invent work from a milestone description.
3. Fetch each selected issue's complete body, labels, and comments. Dated project-lead decision comments and `## Implementation guidance` comments are authoritative extensions of the specification and override conflicting earlier text.
4. Extract dependencies, priority, cross-milestone prerequisites, affected files/components, and issue references. Verify external prerequisites.
5. Inspect `git status`, branch, existing milestone worktrees, and `command -v cargo`. Do not disturb unrelated user changes. If the tree is dirty in overlapping paths, ask for direction.
6. Update local `dev` through the repository's HTTPS GitHub workflow. Create `milestone-M<N>` from updated `dev`, or resume its committed state. Never reset an existing branch.

Retry GitHub or network failures once. Then report the infrastructure block.

## 2. Plan and obtain approval

Spawn one fresh `gpt-5.6-sol`/`xhigh` planning agent. Give it the milestone description and complete selected issue specifications. Require:

- execution order grouped into waves of no more than three;
- explicit dependencies first, then priority, then ascending issue number;
- no parallel issues that overlap files or shared groundwork;
- per-issue affected components and contract boundaries;
- a strategic implementation outline and relevant repository skills;
- shared groundwork built once in the earliest dependent issue;
- Accepted ADR conflicts requiring a superseding ADR;
- every unresolved product or architectural question.

The root checks the plan against source material, presents a compact plan and open questions, and waits for explicit approval. Resolve material questions now. Approval does not authorize pushing, opening a PR, closing issues, or expanding scope.

## 3. Execute each wave

Issues in a wave may be prepared and implemented concurrently in separate worktrees. Integration, post-merge verification, and acceptance are sequential in plan order.

### 3.1 Branch and worktree

From the main checkout on `milestone-M<N>`, create each issue branch and absolute worktree at `/workspace/.claude/worktrees/issue-<N>`. Never place worktrees inside components.

Choose branch prefix from labels: bug (including bug+enhancement) → `fix/`; enhancement → `feat/`; documentation → `docs/`. Use `<prefix><N>-<short-kebab-title>`.

### 3.2 Blueprint

Spawn a fresh read-only `gpt-5.6-sol`/`xhigh` blueprint agent. Give it the worktree, full spec, Step 2 outline, and relevant `AGENTS.md` paths. Require:

1. File-by-file changes at symbol/schema/route level, including statuses, errors, i18n, env defaults, migrations, codegen, and Rust mirrors.
2. Existing exemplar anchors with paths and lines for every new pattern.
3. Applicable ADRs and crossed serialization/auth/contract boundaries.
4. Named tests and existing fixtures/harnesses to reuse.
5. Explicit non-goals.
6. Exact self-check commands mapped to acceptance criteria.

Zero open questions are allowed. If spec, code, and ADRs cannot resolve an ambiguity, pause and ask the user. Never send an ambiguous blueprint to implementation.

### 3.3 Implement

Spawn a fresh `gpt-5.6-terra`/`high` implementation agent. Give it the full spec, blueprint, absolute worktree, and relevant component instructions. Permit edits only in that worktree.

Require it to read exemplars, follow the blueprint, implement tests/docs, run checks, and report files, results, deviations, and omissions. It may minimally resolve trivial drift if reported; it stops on non-trivial contradictions.

It commits in the worktree as `<type>(<scope>): <summary> (#<N>)`. Do not edit `CHANGELOG.md` in parallel worktrees; the root handles it during integration.

### 3.4 Review loop

Spawn up to three fresh `gpt-5.6-sol`/`xhigh` reviewers in parallel. Give each the full spec, blueprint, diff, and worktree, with distinct remits:

1. Spec/blueprint conformance both ways, acceptance criteria, non-goals, omissions, and unexplained changes.
2. Correctness, error handling, repository patterns, architecture, simplicity, and speculative abstraction.
3. Security and boundaries: injection, argv safety, auth, secrets/logging, containment, SIF trust, contract/codegen/Rust agreement, Redis/Lua serialization, and stream lifecycles.

Require high/medium/low findings with file:line evidence and failure scenarios. No high or medium findings advances. Otherwise use fresh Terra/high fix agents, commit `fix: address review findings for #<N> (round <R>)`, and re-review with fresh agents. Stop after three rounds and report unresolved findings.

### 3.5 Integrate sequentially

In plan order, in the main checkout:

1. Squash-merge the issue branch without committing.
2. Add its concise `CHANGELOG.md` entry under `[Unreleased]`.
3. Inspect and stage only intended paths.
4. Commit `<type>(<scope>): <summary> (#<N>)`.
5. Remove the issue worktree.
6. Delete the issue branch only with the safe form. If squash history prevents it, leave it for the user; never bypass safeguards.

Resolve conflicts by re-reading both issue intents, and record the resolution.

### 3.6 Verify after integration

Spawn a fresh `gpt-5.6-sol`/`xhigh` verification agent on the milestone branch. It runs and judges, quoting output:

- root `make typecheck` and `make lint`;
- `make lint-specs` and codegen drift when specs changed;
- targeted workspace, Python, and Rust tests;
- cargo check/clippy/test when available, otherwise “needs host run”;
- integration tests when safe dedicated services are reachable;
- runtime checks against host services/logs where observable;
- Playwright/visual checks for dashboard changes when available;
- local manifest/container validation and explicit cluster-only deferrals;
- every acceptance criterion as met, unmet, or not locally verifiable.

Use only dedicated test databases/Redis DBs. A failure blocks the next integration. Route fixes to a fresh Terra/high agent on the milestone branch, commit `fix: resolve verification issues (#<N>)`, then re-verify freshly.

### 3.7 Independent acceptance

Spawn a fresh read-only `gpt-5.6-sol`/`xhigh` acceptance agent. Give it the full spec, blueprint, integrated/fix SHAs, reviews, and verification. Tell it disagreement is the purpose. Require `ACCEPTED` or `NOT ACCEPTED` with evidence for:

1. The diff contains everything requested and nothing unexplained, against blueprint, non-goals, and criteria.
2. Reviews and verification substantively engaged the diff and quote real evidence; sample their claims against code.

The root then personally runs one cheap representative gate—targeted test, TS build, or `make lint-specs`. Never delegate it. If acceptance or the spot gate fails, route code gaps to fresh Terra/high fixers or weak evidence to fresh Sol/xhigh reviewers/verifiers. Accept only when all controls hold.

### 3.8 Record without closing

Post a GitHub status comment with milestone branch/commit, verification and deferred gates, acceptance/rework, and scoped deferrals. Leave the issue open.

File a new issue for genuine out-of-scope discoveries with correct labels/milestone. Do not expand the current issue. Other external mutations remain unauthorized unless approved.

## 4. Wrap up

1. Prune worktree metadata. Verify a clean main checkout on `milestone-M<N>`. Report retained worktrees/branches and why; never force-delete.
2. Ensure each issue has an `[Unreleased]` changelog entry. Consolidate overlap only in a separate docs commit.
3. Create and commit `docs/project/milestone-M<N>-pr-draft.md` with title, per-issue summary, verification/deferred gates, follow-ups, and a separate `Closes #N` line per issue.
4. Do not push, open a PR, close issues, or close the milestone.
5. Report issue result, review rounds, verification, acceptance, and commit, plus totals, new issues, local verification gaps, user actions, changelog/PR-draft state, and cleanup state.

## Failure and interruption

- If code contradicts the issue, stop that issue and continue only with independent unblocked issues.
- If work contradicts an Accepted ADR, stop for a user decision and superseding ADR.
- If a cross-milestone prerequisite is missing, stop the issue; do not implement it ad hoc.
- If interrupted, commit only coherent work, leave the milestone branch recoverable, and report the exact resume point.
- Never call incomplete work complete because time or context is running low.
