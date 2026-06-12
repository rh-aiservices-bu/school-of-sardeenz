---
name: implement
description: Implement a phase or feature with full quality process — plan, implement, cross-model review/fix loop, verify. Use for any development work that needs the same rigor as phase development.
model: claude-opus-4-6
allowed-tools: Agent, Bash, Read, Write, Edit, Grep, Glob, TaskCreate, TaskUpdate, TaskList, TaskGet, Skill
argument-hint: '<phase number or description of what to implement>'
---

# Implement — Full Quality Development Process

You are implementing a phase or feature for the Sardeenz v2 project. Every change goes through a cross-model review loop before completion.

**Task:** $ARGUMENTS

## Step 1: Branch Setup

Check the current branch:

```bash
git branch --show-current
```

- If on `main`: create and checkout a new branch with a descriptive name (e.g., `feat/phase2-control-plane`, `fix/parking-race-condition`, `chore/update-dependencies`). Use conventional commit type as prefix.
- If on any other branch: proceed on the current branch.

## Step 2: Understand the Task

Before writing any code:

1. **Determine task scope.** If the argument references a phase number, read the phase document at `docs/project/phase<N>.md` — it contains the full task breakdown, scope, approach, and definition of done. If the argument is a feature description, identify which components are affected.

2. **Read relevant context** — launch parallel Explore agents as needed:
   - Read `CLAUDE.md` at the repo root for project-wide rules
   - Read the phase document if applicable
   - Read `docs/architecture/overview.md` if changes cross component boundaries
   - Read existing code in the areas that will be modified
   - Read relevant OpenAPI specs in `packages/contracts/specs/` if the work touches API contracts
   - Read relevant ADRs in `docs/architecture/adrs/` for design decisions that constrain implementation

3. **Identify affected components and their toolchains:**

   | Component     | Directory             | Language         | Build                                | Test                                  | Lint                                        | Format                   |
   | ------------- | --------------------- | ---------------- | ------------------------------------ | ------------------------------------- | ------------------------------------------- | ------------------------ |
   | Routing Proxy | `proxy/`              | Rust             | `cargo build`                        | `cargo test`                          | `cargo clippy --all-targets -- -D warnings` | `cargo fmt`              |
   | Control Plane | `control-plane/`      | TypeScript       | `npx tsc --build`                    | `npm test -w @sardeenz/control-plane` | `npm run lint`                              | `npx prettier --write .` |
   | Dashboard     | `dashboard/`          | TypeScript/React | `npx tsc --build`                    | `npm test -w @sardeenz/dashboard`     | `npm run lint`                              | `npx prettier --write .` |
   | Contracts     | `packages/contracts/` | OpenAPI YAML     | —                                    | —                                     | `npm run validate -w @sardeenz/contracts`   | —                        |
   | Types         | `packages/types/`     | TypeScript       | `npm run codegen -w @sardeenz/types` | —                                     | —                                           | —                        |

   **Important:** Use npm, never pnpm. Do not use Context7 for PatternFly components (use PatternFly.org docs instead); Context7 is fine for all other libraries.

## Step 3: Plan

Create an implementation plan using **TaskCreate** to track each unit of work:

- Break the phase/feature into discrete tasks with clear deliverables
- Set up task dependencies with `addBlockedBy`/`addBlocks` where ordering matters
- Each task should be completable and verifiable independently
- For phases, the task breakdown in the phase document is the starting point — adapt it based on what you learned in Step 2

Present the task list to the user as a brief summary. If the task is ambiguous or has multiple valid approaches, ask for clarification before proceeding.

## Step 4: Implement

Work through tasks in dependency order. For each task:

1. **Mark in_progress** with TaskUpdate before starting
2. **Read existing code** in the area before writing new code — match existing patterns
3. **Use the appropriate project skill** when one matches (e.g., `/contract-codegen` after modifying OpenAPI specs, `/scaffold-component` for new components)
4. **Spawn implementation subagents with `model: sonnet`** for parallel independent tasks when the work is well-scoped and doesn't require coordination
5. **Mark completed** with TaskUpdate when the task's deliverable is verified

Implementation rules:

- Use shared types from `packages/types/` or `proxy/src/generated/` — never duplicate type definitions
- OpenAPI specs in `packages/contracts/` are the single source of truth (ADR-005)
- Follow existing code patterns in the component you're modifying
- For Rust code: use `thiserror` for error types, `anyhow` for propagation, `tracing` for logging
- For TypeScript code: follow the patterns in the workspace's existing code

**Commit incrementally** as logical units complete. Use conventional commit messages. Always update `CHANGELOG.md` (under `[Unreleased]`) before each commit.

## Step 5: Cross-Model Review Loop

This is the critical quality step. Repeat **up to 3 times**. Stop early if no high or medium severity issues are found.

### 5a: Review

Invoke the `/review-changes` skill to get a comprehensive review of all changes since the branch diverged from main:

```text
/review-changes done since branching from main
```

The review covers security, concurrency/correctness, API contracts, code quality, performance, and testing across all changed files.

### 5b: Assess

Collect all findings. Classify by severity:

- **High**: correctness bugs, security vulnerabilities, data races, contract violations, missing error handling on failure paths
- **Medium**: performance issues, missing test coverage for important paths, inconsistent patterns, incomplete error messages
- **Low**: style nits, optional optimizations, documentation suggestions

If there are **no high or medium severity issues**, proceed to Step 6.

### 5c: Fix

If there are high or medium issues, fix them systematically:

1. Create tasks for all findings that need fixing
2. Work through fixes — spawn subagents for independent fixes
3. Run component-specific verification after each fix (see Step 6 verification commands)
4. Commit with message: `fix: address review findings (round <N>)`

Then **repeat from 5a** with the updated code.

## Step 6: Verify

Run the full verification suite for all affected components:

### Rust (proxy/)

```bash
cd proxy && cargo fmt --check
cd proxy && cargo clippy --all-targets -- -D warnings
cd proxy && cargo test
```

### TypeScript (control-plane/, dashboard/, packages/)

```bash
npx tsc --build
npm run lint
npx prettier --check .
npm test  # runs tests across all workspaces
```

### OpenAPI contracts

```bash
npm run validate -w @sardeenz/contracts
```

### Runtime verification (if applicable)

- **Dev server logs**: Check `logs/` directory for errors from the host-side dev servers (the user runs dev servers from the host, not from this container)
- **Frontend (dashboard)**: If changes affect the dashboard and a dev server is running, use Playwright MCP to verify UI at `http://localhost:5173` — check console errors, verify components render, test golden path
- **Backend services**: Read `logs/<service-name>.log` for errors related to changes
- Skip runtime verification if no dev servers are running or changes are purely structural

Fix any issues found. Commit fixes with message: `fix: resolve verification issues`

## Step 7: Documentation

1. **CHANGELOG.md** — verify all changes are captured under `[Unreleased]` (this should already be done from incremental commits, but verify completeness)
2. **Phase document** — if implementing a phase, update task statuses in `docs/project/phase<N>.md` to reflect completion
3. **Architecture docs** — update or create docs in `docs/architecture/` if the implementation introduced new design decisions or changed existing behavior
4. **CLAUDE.md** — update project status if a phase milestone was reached

Commit documentation updates with message: `docs: update documentation for <feature/phase>`

## Step 8: Summary

Summarize what was accomplished:

```markdown
## Implementation Summary

### Task

[Brief description of what was implemented]

### Branch

[Branch name]

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
- Issues found and fixed: [count by severity]

### Verification

- Rust (fmt/clippy/test): PASS/FAIL/N/A
- TypeScript (tsc/lint/prettier): PASS/FAIL/N/A
- OpenAPI validation: PASS/FAIL/N/A
- Tests: PASS/FAIL ([X] passed, [Y] failed)
- Runtime: PASS/FAIL/SKIPPED

### Phase Progress (if applicable)

- Tasks completed: [X/Y]
- Definition of done items met: [list]
- Remaining items: [list or "none"]

### Commits

[List of commits created during this implementation]
```
