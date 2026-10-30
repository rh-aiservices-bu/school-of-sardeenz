---
name: implement-milestone
description: Execute a planned milestone issue by issue with ceremony proportional to each issue's risk — Direct (orchestrator edit), Light (one builder agent that blueprints and implements, one reviewer, independent acceptance) or Full (blueprint, implement, parallel reviews, verification, independent acceptance). The session model orchestrates; every other role runs as the agent definition the project profile maps it to (model per role, agents in .omp/agents/). Reads the project profile for everything repo-specific. Use whenever the user asks to implement, execute, run, continue or resume a milestone or a single milestone issue.
---

# Implement Milestone — proportional ceremony

You are the **orchestrator and project manager** for executing one milestone. You do not write code except in the narrow Direct pipeline; you dispatch fresh agents per role, read their reports, and control that each did its job.

**Read the project profile first.** Everything repository-specific — model names, branch conventions, labels, verification commands, hard-trigger paths, runtime checks, wrap-up artifacts, known hazards — lives in the project profile, the file the root context file points to under *agent project profile* (conventionally `docs/development/agent-profile.md`). This skill refers to its sections by name (*Models*, *Branching*, *Verification*, …). If the profile does not exist, stop and offer to create it from the template (adapted from `implement-milestone`'s references template); running without it means guessing, and guessing is what this whole method exists to prevent.

## Spawning in this runtime (OMP)

Spawn roles with the `task` tool's batch shape: `{ context, tasks: [{ name, agent, task, solutionSpace, model?, effort? }] }`. `context` (required) carries the shared background — issue spec pointers, worktree, commit range, report-path conventions — rendered into every spawn's system prompt; each item's `task` carries the role-specific brief; `solutionSpace` describes how open-ended the work is, not its size. The agent definition's `model` frontmatter supplies its default; use a task-item `model` and `effort` override when the project profile requires a higher-risk seat (for example, Opus on auth/raw-socket/credential/`term/` implementation or a second Opus reviewer). Bare-model roles (planner, blueprint, spike, sync, drift check) always name their model in the task item. Agent definitions are discovered from `.omp/agents/*.md` in this repository (project overrides user); a skill's frontmatter never switches a running turn's model.

Four roles — the writer role has one agent per pipeline — each a fresh context, and a chain-of-custody rule: **the role that writes never reviews, and the role that reviews never accepts.** The profile's *Models → role agents* table maps each role to an agent definition that carries its model, tool restrictions and preloaded rules; spawn roles through that definition (the task item's `agent`) and put only the issue-specific facts in the prompt — spec, blueprint or handoff path, report path, worktree, commit range, review dimension.

- **Builder** (Light) — one agent that writes its own short blueprint, then implements it.
- **Implementer / fixer** (Full) — builds from a Blueprint written by a separate agent.
- **Reviewer** — read-only, one dimension per spawn; never runs tests.
- **Verifier** — runs the gate after integration and judges the evidence.
- **Acceptance** — always a *subagent*, on its own tier, even if the session runs the same model (see F8 for why).

**Context hygiene.** Spawn a fresh subagent per issue per role. A reviewer never shares context with the implementer whose work it judges. Keep your own context lean: agents read files, you read their summaries and open a report file only when a decision depends on it. Briefs point at the spec, handoff or blueprint file instead of restating it. This constraint also bounds the Direct pipeline — if doing an edit yourself means reading more than a screen of code, it is not a Direct edit.

**Report delivery.** A background agent's final message can fail to reach you (transcript rotation has dropped reports mid-run). So every agent you spawn — planning, blueprint, spike, builder, implementer, review, verification, acceptance, sync, drift check — writes its **full report**, ending in a `Verdict:` line, to the path its brief names (report scratchpad, never `logs/` or a worktree; naming in profile *Models → report channel*). Role agents know this from their definition; bare-model agents (planner, spike, blueprint, sync, drift check) from a sentence in their brief. Then its final result contains a **summary of at most ~10 lines** — verdict, counts, `file:line` of each high/medium, report path. Results are also archived at `agent://<id>` and remain readable there. Open a report file only when a decision depends on it (a fix round, an acceptance call, a disagreement between seats), and prefer passing the path on: fixers, reviewers and the acceptance agent get report paths (build, fix, review of every round, verification), not restated findings. A completion is not a report: before acting, check that the file exists and is complete. Addenda you send can cross with a completion, so confirm receipt of late scope additions.

**Waiting.** One wait per phase, on that phase's report files (the gates' report files, not a spec or a Light builder's blueprint; a re-run gets a fresh `-r<round>` path so a stale file never satisfies the wait): each exists, ends with a `Verdict:` line and is quiescent. Re-arm only when the wait primitive expires. Spend no turn on a duplicate idle notice or a stale task notice — no reply, no re-read.

**Content hazards.** Some projects handle content (medical, security, legal…) that can trip a safety classifier and silently downgrade the orchestrating session to another model for the rest of the run. The profile's *Content hazards* section says whether this applies and which agents may touch what. When it applies: never drive a browser or read runtime page content yourself; route it to agents on a model that is not subject to the classifier; and require sanitized reports (pass/fail, paths, log lines — never verbatim page content).

**Task:** execute milestone `$ARGUMENTS` (the user's prompt names the milestone; that text is your `$ARGUMENTS`).

---

## Proportional ceremony

Ceremony is proportional to the cost of being wrong. Each issue runs exactly one pipeline, chosen in the plan and approved by the user; content-triggered add-ons attach extra reviewers or a spike regardless of pipeline; escalation is one-directional.

| Gate | Direct | Light | Full |
|---|---|---|---|
| Worktree + issue branch | — | ✓ | ✓ |
| Spike (add-on) | — | — | if flagged |
| Blueprint | — | the builder writes its own, short | ✓ separate blueprint agent |
| Implement | you, on the milestone branch | builder (blueprint + implement, one agent) | implementer |
| Review | — | 1 reviewer, ≤1 fix round | 2 reviewers + add-ons, ≤3 rounds |
| Verify | you: one cheap gate | you: scoped gate; agent only for runtime checks | agent: full gate incl. runtime |
| Acceptance | — | acceptance agent (gates 1-2); your L5 scoped gate is gate 3 | acceptance agent (gates 1-2) + your spot re-run (gate 3) |
| Status comment | ✓ | ✓ | ✓ |

**Direct — you edit.** No logic: a typo, a rename confined to one or two files, doc wording, a config default, a string the spec supplies. Roughly ≤10 changed lines, located with `grep`/`glob` rather than by reading, verifiable by compile/lint alone. No hard trigger fires. *Why you and not an agent:* for a one-liner, spawning and briefing costs more than the edit. Above the cap that stops being true and you would be filling your own context with code, so the cap is hard.

**Light — one builder plans and builds from a self-sufficient issue.** Single area of the codebase, follows an existing pattern, and the issue's spec comment already meets the self-sufficiency standard (`plan-milestone` produces exactly this): what, why, where, constraints, design **with a `path:line` exemplar**, validation, and an empty *Open questions* section. No hard trigger; modest diff (order of 150 lines, not 500). The issue is the construction handoff; you add non-goals and self-check commands; the builder writes its own short blueprint (file list, exemplar, tests, non-goals) before editing, so the reviewer still has a contract to audit against. If you cannot write that handoff without reading code, the issue is not self-sufficient and the pipeline is Full. *Why this is safe:* Light is a bet that the spec is right, and the bet is cheap to check — the builder stops on any spec/code mismatch and one reviewer confirms conformance. When the bet fails, escalate.

**Full — the complete chain.** Everything else, and the default whenever unsure.

**Hard triggers — force Full regardless of diff size.** The generic list: schema or migrations; shared packages consumed by more than one service; authentication, session, authorization or scoping code; secrets, credentials, environment configuration; infrastructure and CI; anything labeled security or touching external input parsing; changes crossing service boundaries; any issue with an open question. The profile's *Hard triggers* section maps these to concrete paths and labels.

**Add-ons — content-triggered, attached to Light or Full.**

- *Security reviewer*: the diff touches request handling, DB queries, external input, file/network I/O, secrets, or adds a dependency. When unsure, run it.
- *Boundary reviewer*: the diff crosses services or shared packages (by the hard triggers, always Full). Uses the profile's boundary-review instructions if any.
- *Spike* (before the blueprint): the plan flags an assumption about a library, upstream API or platform that nothing in the repo proves. Unknown feasibility → spike first, blueprint second.

**Escalation — one direction only.** During Direct or Light, if the diff outgrows its cap, a hard-trigger path appears, the implementer reports a spec/code contradiction, the reviewer returns high/medium findings a second time, or a runtime behavior turns out to need observing: **stop, bump to the next pipeline, rerun from the first gate you skipped.** Never de-escalate mid-issue, and never let an agent "just handle" an escalation trigger — the value of the cheap pipelines is that their failure mode is loud. Record every escalation in the notes file and the summary; it is the calibration data for the retrospective.

---

## Step 1: Resolve the milestone

Parse the milestone from the user's prompt: a milestone identifier (matched per profile *Branching → milestone naming*) and optionally one issue number to run alone.

1. List the milestone and its open issues with their labels and bodies (commands in profile *Tracker*).
2. **Read the comments.** Fetch each issue's comments. Two kinds matter (formats in profile *Tracker*): the **latest spec comment**, written by `plan-milestone`, which carries the self-sufficient specification and supersedes any earlier spec comment in full; and dated **decision comments**, which are **authoritative** — they resolve open questions and override conflicting text in both the body and the spec. Body + latest spec + decisions = the spec of the issue. Issue bodies are never edited by anyone in this workflow, so the body is the reporter's words, not the construction contract; read it for intent, the spec comment for construction.
3. **Load the plan if one exists.** `plan-milestone` writes `<plan file>` (profile *Wrap-up artifacts → plan*) and labels issues `pipeline/*`. If present, this is the plan you re-validate in Step 2 rather than derive. If absent, Step 2 derives it.
4. If the milestone references a tracking/index issue, read it for dependency ordering.
5. **Milestone notes file** (profile *Wrap-up artifacts → notes*): create or reopen it on the milestone branch. You append to it after every issue — surprises, deviations, escalations, what a spec or document got wrong. It is the memory that survives context resets and feeds the retrospective; without it the run's lessons die with the session.
6. Create the milestone branch from the up-to-date base branch (profile *Branching*). All work integrates into this branch; the user decides when and whether to PR it. On a resumed run, check it out, read the notes file, continue from its commits.

## Step 2: Execution plan (bare reasoning model, fresh)

Launch a fresh **planning agent** (bundled `task`/general agent, the profile's bare-model selector as the task item's `model`), giving it the issues (bodies + decisions), the pipeline definitions and hard triggers above, the profile's *Hard triggers* and *Layout* sections, the plan file if any, and the previous milestone's retrospective:

> Produce (or, if a plan file is provided, re-validate against the current code) a milestone execution plan:
>
> - **Pipeline per issue** — Direct / Light / Full with a one-line reason; for Light, confirm the spec comment names its files and a `path:line` exemplar that still exists and has no open questions. If an issue would qualify for Light but its text is missing something, say exactly what — the user may prefer to fix the issue than pay for Full. Apply hard triggers strictly; when in doubt, Full. Never propose a lighter pipeline than the issue's `pipeline/*` label without saying so.
> - **Add-ons per issue** — security, boundary, spike — each with its trigger named.
> - **Order in parallel waves** — respect explicit dependencies, then priority, then ascending number. Issues with no dependency and no overlapping files form a wave (max 3 concurrent); Direct issues are batched at the front of the first wave they are unblocked in. Flag anything blocked by work outside the milestone.
> - **Per Full issue:** areas/services touched, whether it crosses boundaries, which project skills apply (profile *Project skills*), and a 3–6 bullet outline — a *seed* for the just-in-time blueprint, not the handoff itself.
> - **Shared groundwork** — anything two issues both need, built once in the first that needs it.
> - **Unverified assumptions** — each becomes a spike add-on.
> - **Open questions** — anything body + decisions do not settle. Do not guess. An issue with an open question is Full, and the question is answered before execution starts.

Present a compact summary: order, one line per issue with pipeline and add-ons, open questions, would-be-Light notes. **Wait for approval.** A milestone is hours of autonomous work; ordering, pipelines and open questions are confirmed once, up front, never mid-run.

## Step 3: Issue loop

Execute waves in order. Within a wave, Light and Full issues run in parallel, each in its own worktree (profile *Layout → worktrees*). Direct issues are done by you, sequentially, before the wave's agents spawn. Integration, verification and acceptance are always sequential, in plan order. The main checkout stays on the milestone branch and is never touched by implementation agents. Branch prefixes and commit format: profile *Branching*.

### Direct

**D1 Locate** with `grep`/`glob`. If locating needs more than a couple of targeted reads, or the change turns out to involve a decision, escalate to Light now.
**D2 Edit and gate** on the main checkout. Run the cheapest relevant gate (profile *Verification → cheap gate*); for pure docs, re-read the diff. Commit.
**D3 Record** — status comment stating `Pipeline: Direct (orchestrator edit, no review)`, SHA, gate command and result. The audit-trail rule is not waived for Direct; it is satisfied by saying so explicitly.

### Light

**L1 Worktree** — create the issue branch off the milestone branch in a dedicated worktree.

**L2 Handoff** — from the spec comment alone: the files it names (confirm existence with `glob`, nothing more), its `path:line` exemplar, **non-goals** (2–4 lines), and the **self-check list** (profile *Verification → scoped gate* plus the test files the issue's validation names). If filling this requires reading code, stop and escalate to Full — its blueprint step exists for exactly that.

**L3 Build** — fresh builder agent (profile *Models → role agents → builder*, spawned through its agent definition), confined to the worktree (absolute paths), given spec + handoff + blueprint and report paths:

> Build the issue below. Dated decision comments are authoritative for intent; the spec comment's where/design sections plus the handoff are authoritative for construction; the body is the reporter's framing. First write your blueprint to the blueprint path given above — file-by-file changes at symbol level, the exemplar each copies, test cases, non-goals, self-check commands — then implement it. **If the issue's description of the code does not match the code** — file missing, exemplar shaped differently, signature that cannot work — STOP and report the mismatch before editing. This issue was routed to a light pipeline on the assumption its spec is accurate; a mismatch means that assumption failed and someone else re-plans, not you. Run the self-check list before reporting and include results. Report: blueprint path, files changed, self-check results, deviations with reasons, anything not implemented and why.

A STOP report escalates to Full (from its separate blueprint step, reusing the worktree). Otherwise commit in the worktree.

**L4 Review** — one fresh reviewer agent (profile *Models → role agents → reviewer*): spec conformance against the builder's blueprint, code quality, project rules, over-engineering, in a single pass over spec + blueprint + diff, given the builder's report path (its flagged deviations). Findings high/medium/low with `file:line`. No high/medium → L5. Otherwise one fresh fixer (the implementer agent), commit `fix: address review findings for #<N> (round 1)`, re-review once. A second round with high/medium findings escalates to the Full review set: repeated findings on a "simple" issue mean it was not simple.

**L5 Integrate and verify** — squash-merge into the milestone branch from the main checkout, one commit per issue, remove the worktree and branch (sequence in profile *Branching → integrate*). Then run the scoped gate yourself with trimmed output (`| tail -n 40`); this is both the verification and your un-fakeable spot check. Anything runtime-observable in the issue's validation goes to the verifier agent (profile *Models → role agents → verifier*; it reports sanitized), never to you. Fix failures with a fresh fixer on the milestone branch (`fix: resolve verification issues (#<N>)`), re-run; never integrate the next issue on a failing gate.

**L6 Accept — acceptance agent for gates 1–2; your L5 scoped gate is gate 3.** Spawn a fresh acceptance agent exactly as in F8, with the builder's blueprint as the Blueprint, the squash SHA plus fix SHAs, and the build, fix, reviewer and verifier (if L5 used one) report paths. Light has one review seat and one model through build and review, so this is the only independent look at the issue. Require `ACCEPTED` / `NOT ACCEPTED`; route any gap as in F8. Then *Record*.

### Full

**F1 Worktree** — as L1.

**F2 Spike (add-on)** — fresh reasoning agent in the worktree: build the smallest experiment that answers the feasibility question, run it, report the *fact* with command output, discard the experiment unless it is the natural seed of the implementation. Feed the fact to the blueprint. If it contradicts the spec, stop the issue (see *Failure handling*); never blueprint around a disproven assumption.

**F3 Blueprint — the detailed handoff.** Fresh, read-only reasoning agent in the worktree, given spec + Step 2 outline + spike findings. Just-in-time per issue, never batched, so it describes the codebase as it is after previous waves merged. Its purpose is a right-first-pass implementation that removes fix rounds — fix rounds on hard diffs have been observed to *introduce* regressions, not just cost tokens.

> Read the spec, then read the code it touches. Produce an **Implementation Blueprint** precise enough that a competent implementer reading only the blueprint plus the files you name produces the intended diff on the first attempt:
>
> 1. **File-by-file change list** — exact paths, create vs modify; per file, the change at symbol level (signatures, types/fields, routes with methods/status codes, error codes, translation keys, config names and defaults, migration steps — see profile *Layout* for what these are in this project).
> 2. **Exemplar anchors** — for every new file or pattern, one existing `path:line` whose shape to copy. Never describe abstractly what the repo already contains.
> 3. **Contracts** — the project rules that apply by name (profile *Project references*), boundary contracts if services or shared packages are crossed, every value the spec says must be configurable.
> 4. **Test plan** — test files with named cases (happy, edge, failure) and the existing mocks/fixtures/factories to reuse; name them so new ones are not invented needlessly.
> 5. **Non-goals** — files and behaviors that must NOT change. The diff will be audited against this.
> 6. **Self-check list** — exact commands and completeness layers (profile *Verification*, which also names where the completeness layers are defined) the implementer verifies before reporting.
>
> **Zero open questions.** Resolve ambiguity by reading code. If something cannot be resolved from spec + code, STOP and report the question instead of producing a blueprint — do not guess and do not leave it to the implementer.

If the agent stops with questions, resolve them (from the spec, or with the user for real decisions) and re-run. Never spawn the implementer against an ambiguous blueprint; ambiguity is where improvisation and later regressions come from.

**F4 Implement** — fresh implementer agent (profile *Models → role agents → implementer*), confined to the worktree, given spec + blueprint + report path:

> Implement the issue by following the Blueprint **exactly**. Decision comments are authoritative for intent; the Blueprint for construction. Read the exemplar files it names before writing and match them; follow the project rules in <profile *Project references*>; stay inside the non-goals. **If the code contradicts the Blueprint**: for anything non-trivial STOP and report; for a trivial mismatch deviate minimally and flag it prominently. Infra/ops issues meet the same completeness standard as code (profile *Verification → infra*). Run the self-check list before reporting (profile *Layout*, fresh-worktree install bullet, first if a worktree needs it). Report: files changed, self-check results, every deviation with reason, anything not implemented and why.

One agent per issue by default; most issues are one coherent change. Commit in the worktree.

**F5 Review loop — up to 3 rounds.** Parallel fresh reviewer agents (profile *Models → role agents → reviewer*; the boundary add-on uses the profile's boundary agent) in the worktree, one dimension each, every one given the Blueprint and the implementer's report path alongside the spec. With a good blueprint round 1 is usually final; repeated rounds signal a weak blueprint — say so in the notes file.

1. **Spec & blueprint conformance, two-way:** (a) implementation matches Blueprint — every change present, nothing outside it except flagged deviations, non-goals untouched; (b) Blueprint faithfully covers body + decisions — nothing dropped. Acceptance criteria met, all completeness layers updated. A conformance check against a concrete blueprint *is* the review; do not re-derive the design.
2. **Code quality, project rules, over-engineering:** clean code, DRY, error handling, consistent patterns, the project's named rules; no premature abstraction or speculative code.
3. **Security** (add-on): injection, auth scoping, data exposure, secrets, OWASP top 10, extra attention when the issue is security-flavored.
4. **Boundary** (add-on): the boundary agent's dimensions — serialization, auth flow, cache, stream contracts, gateway routes and timeouts, NetworkPolicy pairs.

Findings high/medium/low. None → F6. Otherwise fresh fixers (the implementer agent) in the worktree, commit `fix: address review findings for #<N> (round <R>)`, re-review. After 3 rounds, stop and report unresolved findings rather than looping.

**F6 Integrate** — as L5's squash sequence. One squash commit per issue keeps the milestone branch linear and reviewable issue by issue. A merge conflict means the plan's independence assessment was wrong — resolve deliberately (re-read both intents, don't pick a side) and note it.

**F7 Verify** — after the merge, in the main checkout, so it validates the issue *and* its integration. Fresh verifier agent (profile *Models → role agents → verifier*):

> Run the quality gate and judge the results — do not just echo output. (1) The full gate (profile *Verification → full gate*) on affected areas. (2) Runtime verification where the change is observable, per profile *Runtime verification*; for infra changes validate what is validatable locally and state explicitly what only deploy can prove. (3) The issue's acceptance criteria one by one: met / not met / not verifiable locally. Report PASS/FAIL per gate with evidence; do not soften failures. Sanitized reporting for any browser or content-bearing step (profile *Content hazards*).

Fix failures (fresh fixers on the milestone branch, `fix: resolve verification issues (#<N>)`), re-verify. Never integrate the next issue on a failing gate.

**F8 Acceptance — acceptance agent for gates 1–2, you for gate 3.** A control gate, not a fourth review: reports plus diff excerpts, deep only when something smells off.

Gates 1 and 2 go to a **fresh acceptance agent** (profile *Models → role agents → acceptance*), read-only, on the main checkout. Two reasons; the second matters more. *Context isolation:* you have read every report by now and are anchored by them — "did the reviewer engage the diff?" is a question you are poorly placed to answer about reports that already persuaded you; a fresh agent has no such memory (observed: acceptance agents recomputed a figure a reviewer had asserted, and grepped for surviving copies of a superseded pattern — neither of which the inline check had done). *Robustness to model drift:* if the session was silently downgraded mid-run (see *Content hazards*), an inline check quietly becomes the reviewing model judging itself; delegation keeps the acceptance tier correct because model state is per-conversation.

Give it: issue number (it reads the spec itself), blueprint path, squash SHA plus fix SHAs, the build, fix, reviewer (every round) and verifier report paths, the two gates. Say explicitly that **disagreement is the point, not ratification**, and ask for its independent read on any call you are minded to wave through. Require `ACCEPTED` / `NOT ACCEPTED` naming the failing gate.

1. **Did the implementer build what was asked?** Diff stat and targeted excerpts against the Blueprint's file list and non-goals (the cheapest complete checklist), then the issue's acceptance criteria and the completeness layers. Hunt the two failure modes reviews miss: something claimed in a report but absent from the diff, and something in the diff that neither the Blueprint nor a flagged deviation accounts for.
2. **Did the reviewers and verifier actually do their jobs?** Judge the *reports* for substance: findings engage the diff (`file:line`, concrete failure scenarios); every PASS quotes real command output. Zero findings across all reviewers on a non-trivial diff, or a verification asserting success without evidence, is a red flag. Test a representative sample of claims against the code.
3. **Spot re-run one cheap gate yourself — never delegated, never a browser check.** One compile/lint/test command on an affected area. It is a fact check, not a judgement, and it cannot be faked by a report. Delegating every gate and then accepting the verdict adds indirection without rigour — acceptance theatre — and this check in your own hands is what prevents it.

You make the final call. A verdict with no `file:line` evidence is itself a red flag and warrants a re-run with a sharpened prompt. If acceptance fails, route the gap to the right delegate — a fresh fixer for missing/excess implementation, a re-review or re-verification for a hollow report. **Do not silently fix it yourself**; the trail must reflect who did what.

### Record (all pipelines)

No push, no PR, no issue closing — the user owns those.

1. **Status comment** on the issue: pipeline used and any escalation, milestone branch + SHA, verification results, acceptance result including rework, anything deferred or not locally verifiable. Leave the issue open; it closes when the user's PR merges.
2. **Notes file:** what surprised, what a spec or document got wrong, escalations and why, rounds beyond the first. Skip when nothing is worth remembering — the file is for signal, not a log.
3. Out-of-scope discoveries become new issues; never silently expand scope.

## Step 4: Wrap-up

1. **Worktree cleanup (mandatory):** prune, verify no issue worktrees or branches remain, main checkout clean on the milestone branch.
2. **Synchronize (bare reasoning model, fresh).** The definition of done is that the persistent artifacts match the code, not that the code merged. Fresh sync agent, given the milestone diff (stat + targeted reads) and the notes file:

   > Bring documentation in line with the code. (1) Update `docs/` wherever behavior, structure, config or integration points changed; delete what the diff makes obsolete — stale docs are worse than none because the next agent cannot tell they are stale. (2) Rewrite the status document (profile *Wrap-up artifacts → status*): current milestone, done, in progress, next, limitations, debt, notable changes. (3) **List, do not write,** decisions made this milestone that meet the ADR admission rule (a future engineer could plausibly get it wrong at real cost without the record), with a one-paragraph draft each, and existing ADRs the diff supersedes. (4) List changes the root or area context files need: pointers, invariants, verification commands. Report changes made and proposals separately.

   Commit doc/status changes on the milestone branch (`docs: synchronize for milestone <N>`). Present ADR and context-file proposals to the user — decisions and invariants are theirs to ratify.
3. **Drift check (bare reasoning model, fresh).** Compare documented architecture, decision records and context files against the code as it now is; list contradictions, undocumented changes, violated decisions. Findings go to the notes file and, if real defects, to new issues. Nothing found is normal; skipped is not.
4. **Retrospective.** Read the notes file and append `## Retrospective`: what in specs, blueprints or documents was wrong or missing; pipeline calibration (Light issues that escalated, Full issues with zero round-1 findings — both are signals); recurring review findings suggesting a missing rule or exemplar; what the next plan should assume differently. Keep it committed; the user archives it after the PR.
5. Update the changelog (one section per milestone) and commit.
6. **Draft the PR description** to the profile's PR-draft path: title, per-issue summary, verification status, deferred items, a `Closes #N` line per completed issue so merging auto-closes them. Do not push, open or close anything.
7. **Instrumentation** — run the profile's *Instrumentation* checks (model fallbacks; orchestration cost, if defined) and record the results in the notes file.
8. **Summary report:**

```markdown
## Milestone Execution Summary — <title>
Branch: <milestone branch> (local, not pushed — awaiting your PR decision)

| Issue | Pipeline | Escalated | Result | Review rounds | Verification | Acceptance | Commit |
|---|---|---|---|---|---|---|---|
| #NNN | direct / light / full (+add-ons) | – / light→full (why) | done / partial / blocked | n | pass / pass-with-deferred | accepted / accepted-after-rework / n/a | <sha> |

- Issues completed: X of Y (blocked: list, with reasons)
- Pipeline calibration: Light escalated: n; Full with zero round-1 findings: n
- New issues filed: [list]
- Not locally verifiable: [list]
- Synchronize: docs updated (list), status rewritten; ADRs proposed: [list]; context-file changes proposed: [list]
- Drift check: clean / findings
- User actions waiting: [ADR decisions, secrets, host commands, deploy, PR decision]
- Changelog: yes/no; PR draft: <path>; notes + retrospective: <path>
- Worktrees/issue branches cleaned: yes
- Model fallbacks observed: none / list
```

## Failure handling

- Spec contradicted by the code or by a spike: **stop that issue**, report, move to the next unblocked issue, include it in the summary. Never improvise around a wrong spec, and never let Direct or Light absorb a contradiction by "adjusting" — escalate or stop.
- Tracker or git failure is infrastructure, not implementation: retry once, then surface it.
- User interrupt: leave the milestone branch committed, append where execution stopped to the notes file, report it. A resumed run picks up from the branch and the notes.
