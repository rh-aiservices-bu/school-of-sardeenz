# Agent project profile — template

Copy this file to the path your root context file names as *agent project profile* (conventionally `docs/development/agent-profile.md`) and fill every section. `plan-milestone` and `implement-milestone` refer to these sections **by name**; an empty section means the skill will stop and ask rather than guess.

Keep it factual and short. This is project knowledge, so it lives in the repository, not in anyone's personal memory. Rationale for a choice belongs in a decision record; put the pointer here.

---

## Identity

- Project name, one-line purpose, repository host (GitHub / GitLab / …).
- Who owns pushes, PRs, issue closing (default: the user, never the agent).

## Models

- **Orchestrator (session):** model the skills expect the session to run on, and what to do if it is not (say so before starting).
- **Role agents:** a table mapping each role (builder, implementer/fixer, reviewer, boundary reviewer, verifier, acceptance) to its agent definition, model alias, effort and tool restrictions; `implement-milestone` spawns roles through these definitions.
- **Bare-model roles** (planner, plan reviewer, grouper, item author, Full blueprint, spike, sync, drift check): the model alias passed through the Agent tool's `model:` parameter.
- **Acceptance:** always a subagent, on a different tier from the reviewers.
- **Report channel:** where a spawned agent writes its full report (path pattern in a scratch directory, never a reviewed folder or a worktree; file-name words the runtime refuses), how it delivers its ≤10-line summary (e.g. a messaging tool + recipient, else its final message), and the wait primitive on report files with its time cap.
- **Known fallback behavior:** whether the runtime can silently switch the session's model, how to detect it, pointer to a memory entry or doc.
- Pointer to the rationale doc for the tiering.

## Tracker

- Commands to list milestones, list a milestone's open issues with labels and bodies, list the unplanned backlog, read comments, comment, add labels, create a milestone, edit a milestone description, assign an issue to a milestone. (No body-edit command: issue bodies are never edited by the skills.)
- **Decision comments:** the exact format that makes a comment authoritative (e.g. `**Decision (YYYY-MM-DD): …**`).
- **Spec comments:** the exact format `plan-milestone` uses for the self-sufficient specification (e.g. `**Spec (YYYY-MM-DD)**` as the first line, headings from the work-item template below it). The latest one is the spec; decisions override it.
- Tracking/index issue convention, if any.
- Labels: type labels and their branch prefixes; priority labels; `pipeline/direct|light|full`; the security label; any others the planner must respect.
- Milestone naming and how `$ARGUMENTS` matches a milestone.

## Branching

- Base branch for milestones. Milestone branch name pattern. Issue branch pattern (prefix from type label + number + kebab title).
- Commit message format.
- Integrate sequence (squash merge, commit message, worktree/branch removal).

## Layout

- Monorepo or not; workspaces/services and what each is; shared packages consumed by several services.
- Worktree location for issue branches.
- Dependency install step needed in a fresh worktree, if any.
- Where translations, schemas/migrations, config and env definitions, error codes live — the things a blueprint enumerates at symbol level.

## Verification

- **Cheap gate** (Direct): one compile/lint command.
- **Scoped gate** (Light): compile + lint + tests for one workspace, with the pattern for targeting a workspace.
- **Full gate** (Full): everything above across affected workspaces.
- **Infra completeness:** what "complete" means for infra/ops changes (chart + compose + docs + runbook, etc.).
- Completeness layers the implementer must touch (pointer to the context-file section that defines them).

## Runtime verification

- How to exercise a changed service locally (restart needed or hot reload; where logs are).
- How to drive the frontend (tool, URL, any proxy or setup command).
- What is validatable locally for infra changes and what only deploy can prove.

## Hard triggers

Concrete paths, globs and labels that force the Full pipeline in this repo, mapped to the generic list in `implement-milestone`: schema/migrations, shared packages, auth/session/scoping, secrets/env, infra/CI, security label, external input parsing, cross-service.

## Project references

- Named rule sets the implementer and reviewers must follow (path + how many rules, so a reviewer can check them all).
- Boundary-review instructions (path), if any.
- Project skills that implementation may invoke (`/name` — what it scaffolds).
- Exemplar directories: where the canonical examples of each kind of file live.

## Wrap-up artifacts

- **Plan file** written by `plan-milestone`, read by `implement-milestone`: path pattern.
- **Notes file** (per milestone): path pattern.
- **Status document**: path (the one the root context file points to).
- **Roadmap**: path.
- **Decision records**: directory, naming, status vocabulary.
- **Changelog**: path and convention (one section per milestone).
- **PR draft**: path pattern.

## Content hazards

- Does the project's runtime content risk tripping a safety classifier in the orchestrating session (medical, security research, legal, …)? If yes: which agents/models may touch it, what the orchestrator must never do (drive the browser, read screenshots, read page dumps), the sanitized-report rule, and the incident that established it.
- If no: say "none known".

## Instrumentation

- Command (if any) to detect model fallbacks in subagent transcripts after a run, and what to match on.
- Command (if any) to capture the orchestrator's message count and cache-read tokens for the run.

## Sizing heuristics (used by plan-milestone)

- What a "manageable" milestone is here: number of issues, expected autonomous run length, cross-cutting work that must be present.
- What a "modest diff" means for Light in this codebase (line order of magnitude).

## Lessons

Short, dated, one line each: incidents that changed a rule, with a pointer to where the rule now lives. This section is the reason the rules are trusted; keep it.
