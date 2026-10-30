---
name: implement
description: Implement one ad-hoc task, no milestone issue; for an issue in an open milestone use the implement-milestone skill. Runs the task through implement-milestone's Direct (orchestrator edit, no author or review), Light or Full pipeline on the current branch — a fresh reasoning-model item author writes the spec, the user confirms spec and pipeline, then the same role agents, reviews, verification and acceptance apply. Use for any development work outside a milestone run.
---

# Implement — one task through the milestone pipelines

You orchestrate one ad-hoc task the way `implement-milestone` orchestrates one milestone issue: same pipelines, same role agents, same gates, same project profile (`docs/development/agent-profile.md`, read it first). You write code only in the Direct pipeline. Nothing is pushed, opened, merged or closed, and nothing is written to the tracker (profile *Identity*). You never drive a browser or read page content (profile *Content hazards*).

**Task:** the user's prompt text after the skill name is your task description. Quote it verbatim in the spec file as the task's source text.

## Step 1: Branch

1. **Resume.** The report scratchpad is wiped on session restart. First look for an existing `wt/*` branch or `/workspace/.omp/worktrees/task-*` worktree. If one exists, name its slug to the user and ask whether this invocation resumes it. If yes, reuse the slug. If the spec or blueprint file is gone from the scratchpad, ask the user for the original task text and, with their OK, discard `wt/<slug>` and re-run steps 2–4 (new spec, re-confirm, then L1/F1); never continue from its commits without the blueprint. Otherwise continue from the worktree's commits. If no, stop until the user discards it (one task at a time). Discard, from the main checkout and after the user confirms its uncommitted edits can go: `git worktree remove --force <W>` (an abandoned worktree usually holds uncommitted edits), `git branch -f wt/<slug> HEAD`, `git branch -d wt/<slug>`. On the *no* path, if the current branch then has no commits beyond `dev`, check out `dev` before step 4 so the new task does not land on the discarded task's branch.
2. **Issue number.** If the task text is only an issue number (`123` or `#123`), run `gh issue view <N> --json title,body,comments,milestone,state`. If it is a PR, tell the user and treat the PR's title and body as input text, not the number. If the issue is CLOSED, tell the user and wait for their answer. The JSON carries no milestone state: read openness from the profile *Tracker* open-milestones query. If the issue is in an open milestone (this repo's milestones are named `M<N> — <title>`), stop and tell the user to run the `implement-milestone` skill with that milestone — milestone issues go through the milestone pipelines with plan-file ordering, not ad-hoc. An issue in a closed milestone or in none is input text: the title, body and comments feed the spec only, with no comments, labels or other tracker writes, now or later.
3. **Clean tree.** `git status --porcelain` must print nothing. Otherwise stop and ask the user to commit or stash: a worktree forks HEAD, so uncommitted work is invisible to the builder and blocks `git merge --squash`.
4. **Branch.** Check the current branch:

   ```bash
   git branch --show-current
   ```

   - If on `dev`: create and checkout a new branch with a descriptive name following the project's branch naming convention (e.g., `feat/agent-create-modal`, `fix/requestid-retry`, `chore/update-workflow`). Use the conventional commit type as prefix.
   - If on any other branch: proceed on the current branch (the user has already set up their branch).

   Call the branch you end on `<B>`, the task `<slug>` (short kebab-case; the part after `<type>/` when you created the branch) and the worktree `<W>` = `/workspace/.omp/worktrees/task-<slug>` (absolute, valid from any checkout because all worktrees share one repo).

## Step 2: Spec

The spec lives at `<scratchpad>/spec-<slug>.md`, where `<scratchpad>` is the report scratchpad directory (default `/workspace/.omp/reports`; a fresh, gitignored directory — never `logs/`, which is for owner review only, and never inside a worktree). Spec and blueprint files never go in either forbidden location.

- **Direct-sized task** (roughly ≤10 changed lines, no logic, located with `grep`/`glob`, no hard trigger): write a short spec yourself, with the user's text quoted first, then *Where*, *Validation* and *Proposed pipeline*.
- **Otherwise** spawn a fresh item author (bundled `task` agent, the profile's bare-model selector as the task item's `model`, profile *Models*). Give it the user's text (plus the issue's title, body and comments from step 1, if any), the spec path, root `AGENTS.md`, the work-item template (kept with this skill's references), the profile's *Layout*, *Hard triggers*, *Project references* and *Verification* sections, and the pipeline definitions from the `implement-milestone` skill *Proportional ceremony*:

  > Write a self-sufficient spec for the task below to the spec path: the user's text quoted verbatim first, then the template's headings verbatim. An agent with no conversational history must be able to implement and validate the task from this file alone. **Read the code** to make every pointer concrete: real paths, a real `path:line` exemplar for each pattern to follow, the actual test files and fixtures to reuse, the actual verification commands. Anything the task text and the code cannot settle goes under *Open questions*; do not guess. Under *Proposed pipeline*, propose direct / light / full with the hard triggers applied strictly, each add-on with its trigger, and a one-line reason; an open question forces full. You are read-only on the repository: the spec file is the only file you write. There is no GitHub issue and nothing goes to the tracker. Report the spec path, the proposed pipeline and the open questions as your final result, and also write them to the report path you were given.

Wait on the author's result (check the report file exists and ends with the proposals), not a `Verdict:` line (spec files have none). Ask the user the open questions one at a time. Append each answer to the spec file as a `**Decision (YYYY-MM-DD): …**` line; decision lines override the rest of the spec, and a question with its Decision line counts as closed, so Light stays available.

## Step 3: Pipeline

Choose Direct, Light or Full by `implement-milestone`'s *Proportional ceremony* (all three tiers, Direct's hard ≤10-line cap, the add-ons, one-way escalation) and the profile's *Hard triggers*; when unsure, Full. Tell the user the spec path, the pipeline and each add-on with its trigger. If the pipeline is Light or Full for a task you sized Direct (the user's pick here, or escalation D1/D2), re-run step 2 with the item author for a full spec and re-confirm with the user before L1/F1. On D2 escalation mid-edit, revert the partial Direct edit on `<B>` first; the builder redoes the change inside the pipeline so every escalated line is reviewed. **Wait until the user confirms spec and pipeline** before anything in step 4 is spawned or edited.

## Step 4: Run

Read the `implement-milestone` skill: the role chain and invariants in *Spawning in this runtime (OMP)*, then in *Step 3: Issue loop* the chosen pipeline's gates (Direct D1–D3, Light L1–L6, Full F1–F8, F2 only with a spike add-on), *Record* and *Failure handling*. Follow them under the table below, which also governs the profile's *Branching*, *Layout*, *Tracker* and *Wrap-up artifacts*. Wherever those texts say "the issue", read "the task", including implement-milestone's "**Task:** execute milestone" line.

| In implement-milestone / profile / agent | Under this skill |
|---|---|
| milestone branch (Step 3 intro, D2, L1, L5, F6, F7; profile *Branching*) | `<B>`; the main checkout stays on `<B>` |
| issue branch `<prefix><N>-<title>` (L1, F1) | `wt/<slug>` off `<B>` (Step 1 already used `<type>/<slug>`) |
| worktree `/workspace/.omp/worktrees/issue-<N>` (profile *Layout*, integrate block) | `<W>` |
| integrate block `git branch -f <issue-branch> HEAD~0` | `git branch -f wt/<slug> <B>`, then `git branch -d wt/<slug>` |
| commit suffix `(#<N>)`; fix messages (L4, F5, L5, F7) | no suffix (conventional-commit form); `fix: address review findings for <slug> (round R)`, `fix: resolve verification issues for <slug>` |
| issue body | the user's task text, quoted in the spec file |
| spec comment + decision comments (Light definition, L2, L3, F3, F4, F8) | `spec-<slug>.md` and its dated Decision lines |
| Step 2 execution plan, F3 "Step 2 outline", "the plan flags an assumption", plan approval | the spec's *Design* and *Proposed pipeline*; the user's confirmation in step 3 |
| waves, plan order, "next issue", max 3 concurrent | n/a: one task |
| blueprint path (L3, F3) | `<scratchpad>/blueprint-<slug>.md`, always passed explicitly |
| issue number or issue facts in a role prompt (L3, L6, F4, F7, F8) | the spec path, `<slug>` as the id and, for agents that commit, the commit form above |
| status comment (ceremony table, D3, *Record* 1) | the end-of-run summary; Direct states "Pipeline: Direct (orchestrator edit, no review)" |
| notes file (escalation rule, F5, *Record* 2, interrupt) | the summary's *Pipeline* and *Calibration* sections |
| out-of-scope discoveries become new issues (*Record* 3) | listed in the summary as proposed issues; no tracker writes |
| *Failure handling* "move to the next unblocked issue"; interrupt note | stop and report to the user; the summary says where the run stopped |
| Step 4 *Wrap-up* | item 1 only (worktree cleanup); CHANGELOG only when the spec's *Where* names it |

Worktree and integration run from the main checkout, the checkout where `<B>` is checked out (`git rev-parse --show-toplevel`). Runtime verification follows the profile's *Runtime verification*. Run the profile's commands with `-C <main checkout>`, and `npm install` first if that checkout has no `node_modules`:

```bash
git worktree add -b wt/<slug> <W> <B>   # L1 / F1, then install deps per profile *Layout*
git merge --squash wt/<slug>            # L5 / F6
git commit -m "<type>(<scope>): <summary>"
git worktree remove <W>
git branch -f wt/<slug> <B>   # force-delete is blocked by the safety hook
git branch -d wt/<slug>
```

**Every role prompt** (blueprint, builder, implementer or fixer, reviewer, boundary-reviewer, spike, verifier, acceptance) names the spec path, the id `<slug>`, its report path (`<scratchpad>/<role>-<slug>….md`, profile *Models → report channel*) and, for agents that commit, the commit form.

## Step 5: Summary

```markdown
## Implementation Summary

### Task
[Brief description] — spec: [path] — result: done / stopped at [gate] ([why])

### Branch
[<B>, local, not pushed]

### Changes by Layer
- **Docs:** [files changed or "n/a"]
- **Agent config (.omp/):** [files changed or "n/a"]
- **Backend:** [files changed or "n/a"]
- **Frontend:** [files changed or "n/a"]
- **Infra (Kustomize):** [files changed or "n/a"]
- **Tests:** [files changed or "n/a"]
- Total files modified: [count]

### Pipeline
- Pipeline: [direct / light / full] + add-ons: [security / boundary / spike / none, each with its trigger]
- Escalations: [– / direct→light / direct→full / light→full (why)]
- Review rounds: [count]; findings fixed: [count by severity]; acceptance: [accepted / accepted after rework / n/a (Direct)]

### Verification
- [Each gate that actually ran: command, PASS/FAIL, quoted verdict line]
- Not locally verifiable: [list or "none"]

### Calibration
- Surprises and spec errors: [list or "none"]

### Proposed issues
[Out-of-scope discoveries and deferred low-severity findings, one line each; not filed]

### Commits
[List of commits created during this implementation]
```
