---
name: fix-phase-issues
description: Fix all open GitHub issues for a given phase — dependency analysis, isolated worktree fixes, cross-model verification, merge, and close.
model: claude-opus-4-6
allowed-tools: Agent, Bash, Read, Write, Edit, Grep, Glob, TaskCreate, TaskUpdate, TaskList, TaskGet
argument-hint: '<phase number, e.g. "2">'
---

# Fix Phase Issues

You are the orchestrator. Your job is to fetch all open GitHub issues for a project phase, analyze their dependencies, fix them in safe order using isolated worktrees with cross-model verification, merge verified fixes, and close resolved issues.

**Phase:** $ARGUMENTS

## Step 1: Fetch Issues

Fetch all open issues for the phase:

```bash
gh issue list --label "phase/phase$ARGUMENTS" --state open --json number,title,body,labels --limit 100
```

Parse the JSON output. For each issue, extract:

- Issue number, title, full body
- Priority label (P0-critical, P1-high, P2-medium, P3-low)
- File paths mentioned in the body (look for backtick-quoted paths matching `*.ts`, `*.tsx`, `*.rs`, `*.yaml`, `*.json`, `Dockerfile`)
- Explicit references to other issues (`#NN`, "depends on", "blocked by", "after", "see related issue")

If no open issues are found, report "No open issues for phase $ARGUMENTS" and stop.

## Step 2: Dependency Analysis and Tier Assignment

Analyze dependencies between issues using three signals:

### Signal 1 — Explicit references

Scan each issue body for references to other open issues in this set. Build directed dependency edges.

### Signal 2 — File overlap

Compare file paths extracted from each issue. If two issues mention the same file, they have potential overlap and must be serialized. When file overlap is detected, read the file to understand whether the changes target disjoint sections — but default to serializing when uncertain.

### Signal 3 — Service/module coupling

If two issues modify the same service class (e.g., both touch methods in `MemoryBudgetService` or both modify `placement.ts`), serialize them even if they reference different methods. Semantic interaction risk is too high.

### Design decision detection

Flag an issue as "requires design decision" if its body:

- Explicitly presents multiple options without recommending one
- Contains phrases like "design question", "decision needed", "options:", "which approach"
- Asks a question that requires architectural judgment not answerable from the issue alone

### Tier assignment

- **Tier 0**: Issues with no dependencies on other open issues AND no file/service overlap with other tier-0 issues
- **Tier 1+**: Issues that depend on lower-tier issues, or that were bumped due to overlap
- **Skipped — design decision**: Issues requiring architectural choices
- **Skipped — depends on all fixes**: Issues that explicitly state they should happen after all other fixes (e.g., integration test suites)

Create a task for each issue using `TaskCreate`. Set `addBlockedBy` edges to reflect the tier structure. Mark skipped issues with a clear description of why they are skipped.

Present the tier plan as a summary table before proceeding:

```
Tier 0 (parallel): #NN (title), #NN (title)
Tier 1 (sequential after tier 0): #NN (title)
Skipped — design decision: #NN (title) — reason
Skipped — depends on all fixes: #NN (title)
```

## Step 3: Process Tiers

Process tiers in order (tier 0 first, then tier 1, etc.).

Within a tier:

- **Parallelize** issues with completely disjoint file sets AND disjoint services — spawn their fix-verify cycles concurrently using multiple Agent calls in a single message
- **Serialize** issues that share any file or service — process them one at a time

For each issue, execute Steps 4 through 8.

After all issues in a tier are merged, execute Step 9 (post-tier verification) before proceeding to the next tier.

## Step 4: Worktree Setup

For each issue being fixed, record the current branch name (you will need it for merging):

```bash
git branch --show-current
```

Create a worktree branch:

```bash
git worktree add .claude/worktrees/fix-issue-<NUMBER> -b fix/issue-<NUMBER>-<slug>
```

Where `<slug>` is derived from the issue title: lowercase, spaces to hyphens, max 40 chars. Example: `fix/issue-32-wake-path-atomic-claim`.

## Step 5: Fix Subagent

Spawn a subagent to implement the fix. Use `model: sonnet` for P1/P2/P3 issues, `model: opus` for P0-critical issues.

The subagent prompt **must** include:

1. **Full issue context**: number, title, and complete body text
2. **File paths**: all files mentioned in the issue body, plus any related files you identified during dependency analysis
3. **Working directory**: the worktree path (pass as the working directory context)
4. **Project commands**:
   - Build: `npx tsc --build`
   - Test: `npm test -w @sardeenz/control-plane`
   - Lint: `npm run lint`
5. **Inter-file relationships**: if the fix spans multiple files, explain how they interact
6. **Rules**:
   - Read the relevant files and existing tests before writing any code
   - Follow existing code patterns in the component
   - Use shared types from `@sardeenz/types` — never duplicate type definitions
   - Use npm, never pnpm
   - Write genuine regression tests that would have caught the original bug
   - Do NOT write fake implementations that exist only to satisfy test assertions
   - Do NOT write tautological tests (testing that mocks return what they were told)
   - Update `CHANGELOG.md` under `[Unreleased]` with a brief description of the fix
   - Stage specific files and commit with message: `fix: <description> (closes #<NUMBER>)`
   - **If the fix requires a design decision or architectural choice not specified in the issue, STOP and report what decision is needed instead of guessing**

## Step 6: Verification Subagent

After the fix subagent completes, spawn a **separate** verification subagent. Always use `model: opus` for verification (cross-model verification when the fixer used sonnet).

The verification subagent checks five dimensions:

### 1. Correctness

- Read the diff: `git diff main..HEAD` (or diff against the parent branch)
- Does the code change match what the issue asks for?
- Are edge cases handled?
- Could this fix introduce new bugs or regressions?

### 2. Honesty

- Are the tests testing actual behavior, or are they tautological?
- Does the implementation do real work, or does it just satisfy test assertions?
- If mocks are used, do they mock at the right boundary (external dependencies, not the code under test)?
- Are there placeholder implementations or TODOs?

### 3. Test coverage

- Is there at least one regression test that would have failed before the fix?
- Do tests cover the specific scenario described in the issue?
- Are error/edge cases tested?

### 4. Code quality

- Does the code follow existing patterns in the codebase?
- Are there type safety issues?
- Is error handling complete?

### 5. Build verification

Run and report results:

```bash
npx tsc --build
npm run lint
npm test -w @sardeenz/control-plane
```

The verification subagent must return a structured verdict:

- **PASS**: Fix is correct, honest, well-tested, and builds cleanly
- **FAIL**: List each issue with severity and specific, actionable feedback

## Step 7: Fix-Verify Loop

If verification returns **FAIL**:

1. Re-spawn the fix subagent in the same worktree, including the verifier's feedback in the prompt
2. The fix agent addresses the feedback, amends or adds a new commit
3. Re-run the verification subagent
4. **Maximum 2 retry iterations**. If verification still fails after 2 retries, skip the issue:
   - Remove the worktree: `git worktree remove .claude/worktrees/fix-issue-<NUMBER> --force`
   - Delete the branch: `git branch -D fix/issue-<NUMBER>-<slug>`
   - Record the failure reason in the task
   - Continue with the next issue

If verification returns **PASS**: proceed to Step 8.

## Step 8: Merge and Close

After a verified fix:

1. **Switch to the original branch:**

   ```bash
   git checkout <original-branch>
   ```

2. **Merge the fix branch:**

   ```bash
   git merge fix/issue-<NUMBER>-<slug> --no-ff -m "fix: <description> (closes #<NUMBER>)"
   ```

3. **Handle merge conflicts** if they occur:
   - Read the conflicting files to understand both sides
   - Resolve by combining both changes — you have context from the issue and from earlier fixes
   - After resolution, run the full verification suite:
     ```bash
     npx tsc --build
     npm run lint
     npm test -w @sardeenz/control-plane
     ```
   - Complete the merge commit

4. **Clean up the worktree:**

   ```bash
   git worktree remove .claude/worktrees/fix-issue-<NUMBER>
   ```

5. **Close the issue:**

   ```bash
   gh issue close <NUMBER> --comment "Fixed in $(git rev-parse --short HEAD) on branch $(git branch --show-current)."
   ```

6. **Update the task** to completed via `TaskUpdate`.

## Step 9: Post-Tier Verification

After all issues in a tier are merged, run the full suite:

```bash
npx tsc --build
npm run lint
npm test -w @sardeenz/control-plane
```

If any check fails:

1. Identify which merged fix caused the failure from the error output
2. Create a corrective worktree and run through Steps 5-8 for the correction
3. The corrective commit message should reference the original fix: `fix: correct regression from #<NUMBER> fix`

Only proceed to the next tier after post-tier verification passes.

## Step 10: Design Decision Handling

For each issue flagged as requiring a design decision:

1. Read the issue body thoroughly
2. Identify the specific decision needed
3. List the options presented in the issue
4. Explain why automated resolution is inappropriate (what could go wrong with a wrong choice)
5. Include this in the final summary for interactive discussion

## Step 11: Final Summary

Produce a structured summary report:

```markdown
## Phase <N> Issue Resolution Summary

### Fixed

| Issue | Title | Commit | Tests Added |
| ----- | ----- | ------ | ----------- |
| #NN   | ...   | abc123 | N           |

### Skipped — Design Decision Required

| Issue | Title | Decision Needed |
| ----- | ----- | --------------- |
| #NN   | ...   | ...             |

### Skipped — Verification Failed (after retries)

| Issue            | Title | Failure Reason |
| ---------------- | ----- | -------------- |
| (list or "none") |       |                |

### Skipped — Depends on Other Work

| Issue | Title | Blocked By |
| ----- | ----- | ---------- |
| #NN   | ...   | ...        |

### Verification

- TypeScript compilation: PASS/FAIL
- Lint: PASS/FAIL
- Tests: PASS/FAIL (X passed, Y failed)

### Commits Created

(list all commits in merge order)

### Issues Closed

(list all closed issue numbers)
```

After the summary, explain each skipped issue in detail so the user can make decisions or provide guidance for a follow-up pass.
