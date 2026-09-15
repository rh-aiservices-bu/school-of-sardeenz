---
name: implement-milestone
description: Execute a Sardeenz v2 GitHub milestone issue by issue with isolated planning, implementation, review, verification, and acceptance agents. Use when invoked as `$implement-milestone M13` or with an optional issue number for rh-aiservices-bu/school-of-sardeenz.
---

# Implement Milestone

Execute milestone `$ARGUMENTS` as the orchestrator and project manager. The user's instructions take precedence over this skill.

Read [references/workflow.md](references/workflow.md) completely before taking any milestone action. Follow it as a required control workflow, including its approval pause, model assignments, worktree isolation, review loop, factual spot-check, changelog discipline, and prohibition on pushing or opening a PR.

This is an explicitly multi-agent workflow. Spawn fresh subagents for the roles required by the reference. Never let an implementer review or accept its own work, and never replace the orchestrator's own spot re-run with a delegated report.

Invocation remains compatible with the prior Claude skill:

```text
$implement-milestone M13
$implement-milestone 13 146
```
