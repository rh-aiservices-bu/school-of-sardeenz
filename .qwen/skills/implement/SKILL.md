---
name: implement
description: Implement a phase or feature with the full quality process — plan, implement, independent review/fix loop, verify. Use for any development work that needs the same rigor as phase development.
argument-hint: '<phase number or description of what to implement>'
allowedTools:
  - task
  - run_shell_command
  - read_file
  - write_file
  - edit
  - grep_search
  - glob
  - todo_write
  - ask_user_question
  - skill
---

# /implement — Full Quality Development Process

You are implementing a phase or feature for the **Sardeenz v2** project. Every change goes through an independent review loop before it is considered done.

**Task:** `<the text the user passed to /implement>`

> **Note on invocation:** you are already inside the loaded `implement` skill — do not call the `skill` tool to re-invoke it. The `<skill-args>` note at the end of these instructions carries the exact argument string; treat that as the task.

## Ground rules (non-negotiable, project-wide)

These come from the root `AGENTS.md` and the ADRs. They hold for every step below, including inside subagents and forks — repeat them into every agent/fork prompt you spawn.

- **`dev` is the integration branch; `main` is for releases only.** Create feature/fix/chore branches from `dev` and PR back to `dev`. Never branch feature work from `main`.
- **CHANGELOG:** always update `CHANGELOG.md` under `[Unreleased]` *before* each commit.
- **Package manager:** use npm, never pnpm (pnpm's hardlink store breaks across the container/host mount boundary).
- **Commit hygiene:** run lint/typecheck before marking work complete. Stage specific files — never `git add -A`.
- **ADR-005 (contracts):** the OpenAPI specs in `packages/contracts/specs/` are the single source of truth. A contract change means: edit the spec → regenerate TS types (`npm run codegen -w @sardeenz/types`) → **hand-update the Rust mirror** in `proxy/src/generated/` → `npm run validate -w @sardeenz/contracts` (or `make lint-specs`). Never hand-edit generated TS; never let the Rust mirror drift.
- **Proxy is stateless:** all routing state comes from the Redis routing map published by the control plane; the proxy never calls the control plane except for wake triggers. VRAM budgeting and lifecycle are owned by the control plane alone.
- **Dashboard:** PatternFly 6 only — `pf-v6-` classes and `--pf-t--` semantic design tokens; do **not** use Context7 for PatternFly components (use PatternFly.org instead); Context7 is fine for React, Axios, React Router, Vitest, and other non-PF libraries. Every user-facing string goes through i18n (`dashboard/src/locales/`).
- **Types:** use shared types from `packages/types/` (TS) or `proxy/src/generated/` (Rust) — never duplicate type definitions.

**Environment caveat — verify the Rust toolchain.** Detect once at start: `command -v cargo`. If present, the cargo gates run locally like every other gate. If absent, `proxy/` work is still implemented and reviewed (review is read-based), but the cargo gates are recorded as **"needs host run"** in the summary and the user is asked to run them on the host before PRing. Never claim a Rust gate passed that never ran.

## Step 1: Branch setup

Check the current branch:

```bash
git branch --show-current
```

- **If on `dev`:** create and check out a new feature branch with a descriptive name using a conventional-commit prefix (`feature/phase5-kvcached-oversubscription`, `fix/parking-race-condition`, `chore/update-dependencies`). `main` is the release branch — do **not** use it as a base for feature work.
- **If already on a feature/fix/chore branch** (e.g. `feature/...`, `fix/...`): proceed on the current branch.
- **If on some other branch:** stop and ask the user which branch to work on, rather than guessing.

Record the base branch and the SHA the new branch diverged from — you will diff against it in Step 5.

## Step 2: Understand the task

Before writing any code:

1. **Determine task scope.**
   - If the argument references a **phase number**, read the phase document at `docs/project/phase<N>.md` — it carries the full task breakdown, scope, approach, and definition of done.
   - If the argument references a **GitHub issue** (e.g. `fix issue #123`), fetch it first: `gh issue view <N> --json title,body,labels`, and read the comment thread (`gh issue view <N> --comments`). The issue body + comments **are the task spec** — treat any decision comments as authoritative. Identify the affected components from the issue, and reference it in commit messages (e.g. `fix: <description> (closes #<N>)`).
   - If the argument is a **feature description**, identify which components are affected.

2. **Read the relevant context.** Launch parallel `Explore` agents (thoroughness "medium"–"very thorough") as needed to read, in parallel:
   - `AGENTS.md` at the repo root (project-wide rules)
   - the phase document, if applicable
   - `docs/architecture/overview.md` when changes cross component boundaries
   - the existing code in the areas that will be modified
   - the relevant OpenAPI specs in `packages/contracts/specs/` when the work touches API contracts
   - the relevant ADRs in `docs/architecture/adrs/` for design decisions that constrain the implementation

   Keep this research in subagents where practical — you want the orchestrator context lean.

3. **Identify affected components and their toolchains:**

   | Component     | Directory             | Language         | Build                                | Test                                  | Lint                                              | Format                   |
   | ------------- | --------------------- | ---------------- | ------------------------------------ | ------------------------------------- | ------------------------------------------------- | ------------------------ |
   | Routing Proxy | `proxy/`              | Rust             | `cargo build`                        | `cargo test`                          | `cargo clippy --all-targets -- -D warnings`       | `cargo fmt`              |
   | Control Plane | `control-plane/`      | TypeScript       | `npx tsc --build`                    | `npm test -w @sardeenz/control-plane` | `npm run lint`                                    | `npx prettier --write .` |
   | Dashboard     | `dashboard/`          | TypeScript/React | `npx tsc --build`                    | `npm test -w @sardeenz/dashboard`     | `npm run lint`                                    | `npx prettier --write .` |
   | Contracts     | `packages/contracts/` | OpenAPI YAML     | —                                    | —                                     | `npm run validate -w @sardeenz/contracts`         | —                        |
   | Types         | `packages/types/`     | TypeScript       | `npm run codegen -w @sardeenz/types` | —                                     | —                                                 | —                        |

## Step 3: Plan

Create an implementation plan using `todo_write`:

- Break the phase/feature into discrete tasks with clear deliverables.
- Use `blockedBy` to encode ordering where it matters.
- Each task should be completable and verifiable independently.
- For a phase, the task breakdown in the phase document is the starting point — adapt it based on what you learned in Step 2.

Present the task list to the user as a brief summary. If the task is ambiguous or has multiple valid approaches, ask for clarification with `ask_user_question` before proceeding.

## Step 4: Implement

Work through the tasks in dependency order. For each task:

1. **Mark it `in_progress`** with `todo_write` before starting.
2. **Read the existing code** in the area before writing new code — match existing patterns.
3. **Use the appropriate project workflow** when one matches (e.g. the contract-codegen flow after modifying an OpenAPI spec, the scaffold flow for a new component — both inlined below).
4. **Spawn implementation subagents** for well-scoped, independent tasks that don't require coordination. Top-level subagents run in the background by default and report results via a completion notification; set `run_in_background: false` when you need a result inline before continuing. Give concurrent subagents disjoint write scopes and launch them in a single message.
5. **Mark it `completed`** with `todo_write` only when the task's deliverable is verified.

Implementation rules:

- Use shared types from `packages/types/` (TS) or `proxy/src/generated/` (Rust) — never duplicate type definitions.
- The OpenAPI specs in `packages/contracts/` are the single source of truth (ADR-005).
- Follow existing code patterns in the component you're modifying.
- **Rust:** `thiserror` for error types, `anyhow` for propagation, `tracing` for logging.
- **TypeScript:** follow the patterns already in the workspace.

**Contract-codegen flow (when an OpenAPI spec in `packages/contracts/` changed):**
1. Validate the specs — `npm run validate -w @sardeenz/contracts`.
2. Regenerate TypeScript types — `npm run codegen -w @sardeenz/types`.
3. **Hand-update the Rust mirror** in `proxy/src/generated/` to match (never hand-edit generated TS).
4. Type-check — `make typecheck` (or `npx tsc --build`) to confirm the generated types compile and consumers are compatible.
5. Report which specs were processed and any breaking changes detected.
   - Never hand-edit files in `packages/types/src/generated/`. If a spec change breaks a consumer, fix the consumer, not the generated types.

**Scaffold flow (when creating a new component):**
- **TypeScript:** create `package.json` (name scoped under `@sardeenz/`, `"private": true`, `"type": "module"`, a dependency on `@sardeenz/types`, and `build`/`dev`/`test`/`lint`/`typecheck` scripts); `tsconfig.json` extending `../../tsconfig.base.json` (adjust path depth); `src/` and `tests/`; an entry point `src/index.ts`; then `npm install` from the root to link the workspace.
- **Rust:** create a `Cargo.toml` as a workspace member under `proxy/`; add a minimal `src/lib.rs` (or `main.rs`); register the crate in the proxy workspace members list.
- Follow the naming conventions in `docs/development/coding-standards.md`; TypeScript components use ESM; register every component in the root workspace config; use `@sardeenz/types` for any contract-derived types.

**Commit incrementally** as logical units complete, using conventional-commit messages. Always update `CHANGELOG.md` under `[Unreleased]` before each commit. Stage specific files (never `git add -A`).

## Step 5: Independent review loop

This is the critical quality step. Repeat **up to 3 times**. Stop early if no high- or medium-severity issues are found.

> **Why the review runs in a fork, not in your context.** The review is deliberately run by a **fresh `fork`** that produces only a compact findings report which comes back to you. Your orchestrator context stays lean and — importantly — is not the one being judged. This reproduces the review *pipeline* of the bundled `review` skill (its own fan-out of fresh review subagents, verification, and reverse audit) but over the **full branch diff**, keeping that review noise out of the orchestrator. This is the Qwen Code equivalent of the original cross-model review loop: **context isolation is real; cross-model coverage is not** (subagents and forks run on the same model as the main session — there is no way to pin a reviewer to a different model family here). The protection this buys is fresh reviewers with no memory of the implementation.
>
> **Why not just call the bundled `review` skill directly:** a bare `/review` reviews *uncommitted* working-tree changes and takes no base range. This skill commits incrementally (Step 4), so by the end the tree is clean and a bare `/review` would have nothing to review — yet the review must cover *everything since the branch diverged from `dev`*. A fresh fork that fans out its own review subagents over `git diff dev...HEAD` gives the same pipeline over the full range, without polluting the orchestrator.

### 5a: Review (in a fresh fork)

Launch a **fork** (`subagent_type: "fork"`) with `run_in_background: true` and a short `name`. The fork inherits this session, so it has the tools to capture the diff and spawn review subagents. In its prompt, instruct it to:

1. **Capture the full range.** From the main checkout (on the feature branch), capture everything changed since the branch diverged from `dev`: `git diff dev...HEAD --stat`, plus the working tree if anything is uncommitted. If the result is empty, stop and report "no changes to review" — do not invent findings.
2. **Fan out fresh, parallel review subagents** (the `agent` tool, `subagent_type: "general-purpose"`, `run_in_background: false` so each result comes back) — one per dimension, mirroring the bundled `review` skill:
   - **Correctness & concurrency** — logic bugs, data races, edge cases, missing error handling on failure paths.
   - **Security** — injection (parameterized SQL, argv-array spawns — never shell strings), auth scoping, data exposure in error bodies/logs, path containment, secrets handling, and anything touching the SIF supply chain.
   - **API contracts** (only if the diff touches `packages/contracts/`, `proxy/src/generated/`, Redis-published shapes, or the dashboard↔BFF↔control-plane API) — spec ↔ generated TS ↔ Rust mirror all in agreement; serialization hazards (incl. Lua/cjson empty-array); auth flow; SSE lifecycles.
   - **Code quality, architecture & over-engineering** — patterns, DRY, error handling; adherence to the ground rules (ADR-005 contract flow, proxy statelessness, control-plane ownership of VRAM/lifecycle, PF6/i18n); no premature abstraction.
   - **Test coverage** — are the important new/changed paths actually tested? Are there regression tests that would have caught the bug?

   Each subagent is **read-only** (no `edit`/`write_file`), gets the diff or the changed files plus the relevant context, and returns findings classified **high / medium / low** with `file:line` and a concrete, actionable description.
3. **Consolidate** into a single **compact findings report** — one section per severity, each finding as `file:line — severity — description`. If there are no high or medium findings, say exactly that (and list any low ones).
4. **Do NOT edit code** and **do NOT dump** raw command output, full logs, or the entire findings artifact into the report — that is precisely what must not leak into the orchestrator context.

Wait for the fork's completion notification. A fork *finishing* is not the same as its report *arriving* — confirm you actually have the findings content before acting on it.

> **If the fork path is unavailable** (older CLI with no fork support): run the same parallel review subagents directly from the current context as a **last resort**, and say so in the summary. This pollutes the orchestrator context, which is why it is the fallback, not the default.

### 5b: Assess

Collect all findings from the report and classify by severity:

- **High:** correctness bugs, security vulnerabilities, data races, contract violations, missing error handling on failure paths.
- **Medium:** performance issues, missing test coverage for important paths, inconsistent patterns, incomplete error messages.
- **Low:** style nits, optional optimizations, documentation suggestions.

If there are **no high- or medium-severity issues**, proceed to Step 6.

### 5c: Fix

If there are high- or medium-severity issues:

1. Create a todo item for every finding that needs fixing.
2. Work through the fixes — spawn subagents for independent fixes.
3. Run the component-specific verification for each fix (the Step 6 commands for the affected component).
4. Commit with message: `fix: address review findings (round <N>)` — and update `CHANGELOG.md` under `[Unreleased]` first.

Then **repeat from 5a** with the updated code.

## Step 6: Verify

Run the full verification suite for every affected component.

### Rust (`proxy/`)

```bash
cd proxy && cargo fmt --check
cd proxy && cargo clippy --all-targets -- -D warnings
cd proxy && cargo test
```

If `cargo` is not on the host, record these as **needs host run** (see the environment caveat) instead of skipping them silently.

### TypeScript (`control-plane/`, `dashboard/`, `packages/`)

```bash
npx tsc --build
npm run lint
npx prettier --check .
npm test   # runs tests across all workspaces
```

### OpenAPI contracts

```bash
npm run validate -w @sardeenz/contracts
```

### Runtime verification (if applicable)

- **Dev server logs:** check the `logs/` directory for errors from the host-side dev servers (the user runs dev servers from the host, not from this container).
- **Frontend (dashboard):** if changes affect the dashboard and a dev server is running, verify the UI at `http://localhost:5173` — check console errors, confirm components render, exercise the golden path. Use Playwright via an MCP server if one is configured; if not, state clearly what was not visually verified.
- **Backend services:** read `logs/<service-name>.log` for errors related to the change.
- Skip runtime verification when no dev servers are running or the change is purely structural.

Fix any issues found. Commit fixes with message: `fix: resolve verification issues`.

## Step 7: Documentation

1. **CHANGELOG.md** — verify all changes are captured under `[Unreleased]` (this should already be done from the incremental commits; confirm completeness).
2. **Phase document** — if implementing a phase, update the task statuses in `docs/project/phase<N>.md` to reflect completion.
3. **Architecture docs** — update or create docs under `docs/architecture/` if the implementation introduced a new design decision or changed existing behavior.
4. **AGENTS.md** — update project status if a phase milestone was reached.

Commit documentation updates with message: `docs: update documentation for <feature/phase>`.

## Step 8: Summary

Summarize what was accomplished:

```markdown
## Implementation Summary

### Task
[Brief description of what was implemented]

### Branch
[Branch name, and the base it diverged from]

### Changes by Component
- **Proxy (Rust):** [files changed or "n/a"]
- **Control Plane (TypeScript):** [files changed or "n/a"]
- **Dashboard (React):** [files changed or "n/a"]
- **Contracts (OpenAPI):** [files changed or "n/a"]
- **Types (generated):** [files changed or "n/a"]
- **Documentation:** [files changed or "n/a"]
- Total files created: [count]
- Total files modified: [count]

### Review
- Review iterations: [count]
- Review run via: [fresh fork / in-context fallback — and why]
- Issues found and fixed: [count by severity]

### Verification
- Rust (fmt/clippy/test): PASS / FAIL / NEEDS-HOST-RUN / N/A
- TypeScript (tsc/lint/prettier): PASS / FAIL / N/A
- OpenAPI validation: PASS / FAIL / N/A
- Tests: PASS / FAIL ([X] passed, [Y] failed)
- Runtime: PASS / FAIL / SKIPPED

### Phase Progress (if applicable)
- Tasks completed: [X/Y]
- Definition-of-done items met: [list]
- Remaining items: [list or "none"]

### Commits
[List of commits created during this implementation]
```
