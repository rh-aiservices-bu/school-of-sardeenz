---
name: verify
description: Run the repository quality gate on the changed paths — docs and agent-config gates (link sweep, frontmatter parse, `git diff --check`) plus the npm workspace gates (eslint, prettier, tsc, Vitest, OpenAPI spec validation, Python shims when a venv exists) — then fix what it finds. Use after implementing a feature, fixing a bug, or before committing. Runs as a `task` spawn (not by the orchestrator) with the target argument in the task text.
---

# Verify — Sardeenz v2 Quality Gate

You run as a spawned subagent (so command output stays out of the invoking
session) with no conversation history: the task text and `git diff` are your
whole brief. You fix what you find (edits land in the shared working tree),
so the invoking session sees only your report: return the pass/fail table,
the failing lines and every file you edited with a one-line reason — not
the raw output. This skill edits; the `verifier` agent (milestone pipeline)
never does.

The gates live in the Makefile and `docs/development/setup.md`. Read those
sections first. Run only the gates whose area the diff touches; a gate you
cannot run here (no `node_modules`, no venv, no database) is reported N/A
with the reason, never PASS.

## Step 1: Scope

The task text names the target:

- **Paths or "all"**: verify the changed files.
- **Empty**: the files touched by the diff.

```bash
git diff --name-only --diff-filter=d HEAD
```

## Step 2: Gates (docs / agent config, always available)

Run sequentially, one command per call:

1. **Docs link sweep** — for each changed `.md` file under `docs/`,
   `AGENTS.md`, `CHANGELOG.md`: extract markdown links
   and verify each relative target exists:

   ```bash
   grep -oP '\]\(\K[^)#]+' <file> | while read -r p; do test -e "$(dirname <file>)/$p" || echo "BROKEN: <file> -> $p"; done
   ```

2. **Frontmatter parse** — for each changed `.omp/skills/*/SKILL.md` and
   `.omp/agents/*.md`: the YAML frontmatter must parse and carry `name` +
   `description` (a description containing a bare `X: Y` colon inside a
   plain scalar fails the parse — quote it or use an em-dash).
3. **Reference sweep** — grep the changed symbols/paths across `.omp/` and
   `docs/` to confirm no stale references remain (a renamed file must not
   survive as a reference anywhere).
4. **Whitespace:** `git diff --check`.

What to check for:

- No broken relative links; no references to files that do not exist.
- No stale cross-references between skills, agents and docs after a
  rename.
- Frontmatter `name` matches the directory/agent filename.
- ADR status vocabulary consistent (`_(superseded by ADR-X)_` /
  `_(amended by ADR-X)_` style, matching `docs/architecture/adrs/README.md`).

A failure is a FAIL unless its signature is proven environmental.

## Step 3: Code gates

Run per the Makefile for the touched area — sequentially, one suite at a
time, never in parallel with another suite, build or install:

- **Spec validation + lint:** `make lint` (eslint + OpenAPI spec
  validation; clippy only when cargo is available).
- **Typecheck:** `npx tsc --build` (+ `npm run typecheck:e2e -w @sardeenz/dashboard`
  when e2e code changed).
- **Tests:** `npm test` (Vitest workspaces). Postgres integration tests
  need `TEST_DATABASE_URL` set — without it they skip; report that.
- **Python shims:** `make test-python` only when a venv exists
  (`.venv/bin/python3 -m pytest runners/vllm/tests runners/mlserver/tests
  runners/conformance`); report N/A when it does not.
- **Rust proxy:** `cargo check` / `cargo test` in `proxy/` only when
  `CARGO` is available.

A gate whose runtime is absent is N/A with the reason.

## Step 4: Over-Engineering Check

Review changed docs and config for unnecessary complexity:

- A section no skill or agent references (dead weight — prune it).
- Duplicated content that drifted apart (one source of truth — the
  contracts workflow is `docs/development/contracts.md`; coding standards
  are `docs/development/coding-standards.md`).
- Ceremony beyond what the skill references (an agent that reads five
  sections to do one job).

The right amount of documentation is the minimum that satisfies the
referencing consumers.

## Step 5: Runtime

- Runtime checks: `npm run dev` (root — proxy + control-plane + dashboard
  + BFF via concurrently; logs under `logs/*.log`) for stack changes;
  browser verification of changed UI in both themes reported sanitized
  (dispatch the `test-ui` skill for interactive scenarios); `kubectl
  apply --dry-run=client` / `kustomize build deployment/overlays/<name>`
  for Kustomize changes, with deploy-only effects stated as such.

## Step 6: Report

```markdown
## Verify Results
### Docs/config gates
- [ ] Link sweep: PASS/FAIL (X broken)
- [ ] Frontmatter parse: PASS/FAIL (X files)
- [ ] Reference sweep: PASS/FAIL (X stale)
- [ ] Whitespace: PASS/FAIL
### Code gates
- [ ] Spec lint: PASS/FAIL/N/A
- [ ] Typecheck: PASS/FAIL/N/A
- [ ] Tests: PASS/FAIL/N/A
- [ ] Lint: PASS/FAIL/N/A
- [ ] Python: PASS/FAIL/N/A
- [ ] Rust: PASS/FAIL/N/A
### Over-engineering
- [ ] Dead weight: PASS/FAIL
### Runtime
- [ ] Runtime checks: PASS/FAIL/SKIPPED (reason)
### Files edited (one-line reason each)
- <path> — <reason>
### Issues Found
[List each issue with file:line, description, and fix]
```

When a check fails, fix it, then list each issue with `file:line` and its
fix under *Issues Found*.
