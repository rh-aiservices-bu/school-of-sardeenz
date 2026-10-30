---
name: plan-milestone
description: Turn a backlog of issues into an executable milestone — group open issues into manageable milestones, write the detailed plan for the next one, have it attacked by an adversarial reviewer, then bring every work item to the self-sufficient standard (what/why/where/constraints/design with path:line exemplar/dependencies/validation/references) as a spec comment — issue bodies are never edited — and tag it with the execution pipeline it has earned; idempotent — re-running on an existing, already-populated milestone audits it and adjusts only what is missing, stale or contradicted. Use whenever the user asks to plan, re-plan, review, groom, organize, scope, triage, audit or prepare a milestone, to group or regroup issues into milestones, to write or refine work items, or before running implement-milestone on a milestone that has no plan file yet.
---

# Plan Milestone — backlog to executable plan

You are the **planning orchestrator** for the milestone the user names. You
do not write code; you read the tracker, group issues, write the plan, have
it attacked, and bring every work item to the self-sufficient standard as a
spec comment. Everything repository-specific — labels, branch conventions,
verification commands, sizing heuristics — lives in the project profile,
`docs/development/agent-profile.md`; read it first and refer to its sections
by name (*Tracker*, *Branching*, *Verification*, *Sizing heuristics*).

**Task:** plan milestone `$ARGUMENTS` (the user's prompt names the milestone;
that text is your `$ARGUMENTS`).

## Spawning in this runtime (OMP)

Spawn roles with the `task` tool's batch shape: `{ context, tasks: [{ name,
agent, task, solutionSpace }] }`. `context` (required) carries the shared
background; each item's `task` carries the role-specific brief. Model per
role comes from the agent definition's own `model` frontmatter; do not pass
a `model` on the task item unless the profile's *Bare-model roles* names the
role — for those (planner, plan reviewer, grouper, item author, Full
blueprint, spike, sync, drift check) set the item's `model` to the OMP
selector the profile gives. Bare-model agents write their full report to the
report path their brief names (profile *Models → report channel*) and send
an ≤10-line summary as their final result; results are also archived at
`agent://<id>`.

## Step 1: Read the milestone

1. Resolve the milestone from the user's prompt using the profile *Tracker*
   milestone naming. List its open issues with labels and bodies.
2. **Read the comments.** Fetch each issue's comments. Two kinds matter: the
   **latest spec comment** (profile *Tracker → spec comments*), which
   supersedes any earlier spec comment in full, and dated **decision
   comments** (profile *Tracker → decision comments*), which are
   **authoritative** — they resolve open questions and override conflicting
   text in the body and the spec. Body + latest spec + decisions = the spec
   of the issue.
3. If the milestone references a tracking/index issue, read it for
   dependency ordering.
4. **Load the plan if one exists** (profile *Wrap-up artifacts → plan*).
   Issues carry `pipeline/*` labels from a previous run; re-running on a
   populated milestone is an audit (Step 5), not a re-derivation.
5. Read the previous milestone's retrospective if any
   (profile *Wrap-up artifacts → notes*): recurring findings shape this
   plan's assumptions.

## Step 2: Group and order (bare reasoning model, fresh)

Spawn a fresh **grouper** (bundled `task` agent, profile *Bare-model roles*
selector as the task item's `model`), giving it the issues (bodies +
decisions), the profile's *Sizing heuristics*, *Hard triggers* and *Layout*
sections, the plan file if any, and the previous retrospective:

> Group the backlog into manageable milestones per the sizing heuristics and
> propose the execution order for the milestone named in the context:
>
> - **Milestone grouping** — which open issues belong to the milestone;
>   anything oversized or cross-cutting is its own issue, not a footnote.
> - **Dependency order** — respect explicit dependencies (by issue number),
>   then spike-gated ordering: an issue gated by an unrun spike comes after
>   the spike issue. Flag anything blocked by work outside the milestone.
> - **Shared groundwork** — anything two issues both need, called out to be
>   built once in the first that needs it.
> - **Risks and open questions** — anything the issue texts do not settle;
>   do not guess.
>
> Report: grouping, order in waves, groundwork, risks. Open questions are
> listed, never answered.

## Step 3: Plan and attack

1. **Write the plan** (profile *Wrap-up artifacts → plan*): the milestone's
   goal, ordered issues with dependencies and wave structure, shared
   groundwork, risks, and open questions. Commit it on a `chore/` branch if
   the working tree is clean, else present it first.
2. **Adversarial review.** Spawn a fresh **plan reviewer** (bundled `task`
   agent, profile *Bare-model roles* selector), giving it the plan, the
   issue texts and the profile's *Hard triggers*:
   attack the plan for hidden dependencies, wrong ordering, missing
   groundwork, issues that claim to be independent but share files, and
   sizing that ignores the hard triggers. Findings high/medium/low with
   `issue #` references; end with `Verdict: PASS | FINDINGS (n high, m
   medium)`.
3. Fix the plan per findings; re-run the reviewer once if it returned
   high/medium findings. A second round of high/medium findings goes to the
   user with both versions.

## Step 4: Bring items to the self-sufficient standard

For each milestone issue, one **item author** (bundled `task` agent,
profile *Bare-model roles* selector; batch them — the issues are
independent reads):

> Write the spec comment for issue `#<N>`: first line `**Spec (YYYY-MM-DD)**`,
> then the headings of the work-item template
> (`.omp/skills/implement/references/work-item-template.md`)
> verbatim — Summary, Why, Where, Constraints, Design, Dependencies,
> Validation, References, Open questions, Proposed pipeline. **Read the
> code** (or the docs, in a docs-only repository) to make every pointer
> concrete: real paths, a real `path:line` exemplar for each pattern to
> follow, the actual validation to run. Anything the issue text and the
> code cannot settle goes under *Open questions*; do not guess. Under
> *Proposed pipeline*, propose direct / light / full with the hard triggers
> applied strictly, each add-on (security, boundary, spike) with its
> trigger, and a one-line reason; an open question forces full. You are
> read-only on the repository: the spec text is your only deliverable.
> Post it as a comment with `gh issue comment <N> --body-file <file>` and
> report the comment URL.

Wait for the batch, then spot-check one spec comment per issue exists
(`gh issue view <N> --json comments`) before labeling.

## Step 5: Label and confirm

1. Apply the `pipeline/*` label each spec proposes — after the user agrees
   (labels: profile *Tracker*). Issues with open questions stay unlabeled
   until the questions are answered by a dated decision comment.
2. Present the compact summary: milestone grouping, order in waves, one
   line per issue with pipeline and add-ons, open questions,
   would-be-lighter notes. **Wait for approval** before anything beyond
   spec comments and labels.
3. On an existing, already-populated milestone, audit instead of derive:
   confirm each issue's spec comment is current (paths exist, exemplar
   lines still show what they claim), pipeline label still matches the
   hard triggers, and no issue lost its dependencies. Adjust only what is
   missing, stale or contradicted; report the audit.

## No push, no PR, no issue closing

The user owns pushes, PRs and issue closing (profile *Identity*). This
skill writes: the plan file, spec comments, pipeline labels, and nothing
else.
