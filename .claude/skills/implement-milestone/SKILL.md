---
name: implement-milestone
description: Execute a GitHub milestone issue by issue for Sardeenz v2 — the Opus session orchestrates, Opus subagents plan/blueprint/review/verify/accept, Sonnet subagents implement. Reads each issue's decision and implementation-guidance comments as the authoritative spec. Use for working through milestones M1–M9 on rh-aiservices-bu/school-of-sardeenz.
model: opus
allowed-tools: Agent, Bash, Read, Write, Edit, Grep, Glob, TaskCreate, TaskUpdate, TaskList, TaskGet
argument-hint: '<milestone, e.g. M3 or 3> [issue-number]'
user-invocable: true
---

# Implement Milestone — Opus Orchestrates & Reviews, Sonnet Builds, Fresh Opus Accepts

You are the **orchestrator and project manager** for executing a GitHub milestone of
Sardeenz v2 (`rh-aiservices-bu/school-of-sardeenz`). The frontmatter pins this skill to
**Opus** — the model tiering below assumes it. Verify you are actually running on Opus
(the execution environment is Vertex AI and has no Fable access); if not, **say so and
stop**. Planning, blueprinting, review, and verification run on **Opus** subagents; code
writing on **Sonnet** subagents; and each issue is **accepted** only after a fresh
**Opus** agent independently controls that both did their jobs, plus a spot re-run you
perform yourself (step 3f).

**On the model chain (read this — it is deliberately honest about its limits).** This
environment has no third model family, so the writes→reviews→accepts chain does **not**
span three distinct models: Sonnet writes, Opus reviews, and a _fresh_ Opus accepts. The
acceptance gate therefore buys **context isolation** (a fresh agent with no memory of the
reviews that already persuaded you) but **not** cross-model blind-spot coverage — the
accepter shares the reviewer's model family and can share its blind spots. Because that
protection is weaker, **step 3f gate 3 — the un-fakeable spot re-run you run yourself —
carries more weight here, not less.** It is the one check in the loop that is a fact, not
a judgement, and it cannot be produced by a report. Never skip it.

**Model tiering is enforced through the Agent tool** (`model:` parameter), never assumed:
every planning/blueprint/review/verification/acceptance subagent is spawned with
`model: opus`; every implementation and fix subagent with `model: sonnet`. Reference
models by these aliases, never by explicit IDs.

**Context hygiene:** spawn a **fresh subagent per issue per role**. The review agent must
never share context with the implementation agent whose work it judges; the acceptance
agent must never share context with the reviewers whose reports it audits. Keep the
orchestrator context lean — subagents read files; you read their reports.

**Report delivery:** subagents run in the background and notify you on completion. An
agent _finishing_ is not the same as its report _arriving_ — before you act on any
completion, confirm you actually have the report's content. If a late scope addition you
sent may have crossed with a completion, confirm the agent received it rather than
assuming.

**Authority docs for every agent:** `CLAUDE.md`, `proxy/CLAUDE.md`, and the ADRs in
`docs/architecture/adrs/` are the source of truth. The non-negotiables:

- **ADR-005 — contracts:** the OpenAPI specs in `packages/contracts/specs/` are the
  single source of truth. Any contract change means: edit the spec → regenerate TS types
  (`npm run codegen -w @sardeenz/types`) → **hand-update the Rust mirror** in
  `proxy/src/generated/` → `make lint-specs`. Never edit generated TS types by hand;
  never let the Rust mirror drift silently.
- **Proxy is stateless:** all routing state comes from the Redis routing map published by
  the control plane; the proxy never calls the control plane except for wake triggers.
  VRAM budgeting and lifecycle are owned by the control plane alone.
- **ADR-015/016/017/018 — SIF runtime:** runners ship as signed Apptainer SIFs; workers
  mount the module store read-only; only the librarian and control plane write it.
- **Workflow rules (root `CLAUDE.md`):** `dev` is the integration branch; **update
  `CHANGELOG.md` under `[Unreleased]` before committing**; npm, never pnpm; stage
  specific files, never `git add -A`; fix all lint errors — no clean-slate exceptions.
- **Dashboard:** PatternFly 6 only — `pf-v6-` classes, `--pf-t--` semantic tokens; do
  NOT use Context7 for PatternFly docs; every user-facing string goes through i18n
  (`dashboard/src/locales/`).

**Environment caveat — verify the Rust toolchain.** Detect once at start:
`command -v cargo`. If present, cargo gates (`cargo check`,
`cargo clippy --all-targets -- -D warnings`, `cargo test`) run locally like every other
gate. If absent (execution environments vary), proxy (`proxy/`) issues are still
implemented and reviewed (review is read-based), but the cargo gates are recorded per
issue as **"needs host run"** in the status comment and the wrap-up summary, and the
user is asked to run them on the host before PRing. Never claim a Rust gate passed that
never ran.

**Task:** Execute milestone `$ARGUMENTS`

## Step 1: Resolve the Milestone

Parse `$ARGUMENTS`: a milestone identifier (`M3` or `3` — matches the GitHub milestone
whose title starts with `M<N>:`, e.g. `M1: CI & Test Integrity` … `M9: Engine Expansion
(MLServer)`) and optionally a single issue number to run alone.

1. **Precondition — issues must exist.** This skill executes GitHub issues; it does not
   invent them. Find the milestone and its open issues:

   ```bash
   gh api repos/rh-aiservices-bu/school-of-sardeenz/milestones --jq '.[] | {number, title, description, open_issues}'
   gh issue list --repo rh-aiservices-bu/school-of-sardeenz --milestone "<full milestone title>" --state open --json number,title,labels,body
   ```

   If the milestone has **no open issues**, stop and tell the user to create them first.
   Do not decompose the milestone description into ad-hoc work yourself.

2. **Read the full spec of every issue.** Fetch each issue's comments
   (`gh issue view <N> --comments`). Two comment kinds are **part of the spec**:
   - **Decision comments** — headed like `## … decisions … (project lead, YYYY-MM-DD)`
     or `**Decision (YYYY-MM-DD): …**`. These are **authoritative**: they resolve open
     questions in the body and override any conflicting text above them (e.g. #125
     carries its protocol-surface decisions this way).
   - **`## Implementation guidance` comments** — verified code anchors and recommended
     approaches; treat them as an extension of the body.

   The milestone **description** carries ordering rationale and cross-milestone
   prerequisites (e.g. M7 requires #79 from M2) — read it.

3. **Cross-issue dependencies** are recorded inside issue bodies ("lands before",
   "depends on", "companion issue", `#N` references). Collect them for the plan.

4. Create the milestone branch from an up-to-date `dev`. **All work for the milestone
   integrates into this branch** — the user decides later whether and when to PR it to
   `dev`:

   ```bash
   git checkout dev && git pull origin dev
   git checkout -b milestone-M<N>
   ```

   If the branch already exists (resumed run), check it out and continue from its
   current state.

## Step 2: Milestone Execution Plan (Opus)

Launch a **planning Agent with `model: opus`**:

> Read the issues listed below (bodies + decision/guidance comments provided). Produce a
> milestone execution plan:
>
> - **Order of execution, grouped into parallel waves** — respect explicit dependencies,
>   then priority labels (`priority/P0-critical` → `P3-low`), then ascending issue
>   number. Issues with no dependency between them and no overlapping files form a
>   **wave** (max 3 concurrent); issues sharing files or building on shared groundwork
>   are sequenced. Flag any issue blocked by work _outside_ this milestone (the
>   milestone description names known ones).
> - **Per issue:** affected components (`proxy` Rust / `control-plane` / `dashboard` +
>   BFF / `runners/dev-worker` / `runners/vllm` Python / `packages/contracts`+`types` /
>   `containers`+`deployment` / `docs`), whether it crosses a **contract boundary**
>   (OpenAPI specs, the hand-maintained Rust mirror, Redis-published shapes like the
>   routing map or WorkerInfo, the dashboard↔BFF↔control-plane API), which project
>   skills apply (`patternfly-6-development`, `contract-codegen`, `dataviz`,
>   `scaffold-component`), and a 3–6 bullet implementation outline derived from body +
>   decisions. (This outline seeds the per-issue Blueprint in step 3b — keep it
>   strategic; the detailed handoff happens there, just-in-time, against the code as it
>   actually exists.)
> - **Shared groundwork** — anything two or more issues both need (e.g. a contract field
>   both consume, a config value, a test harness), so it is built once, in the first
>   issue that needs it.
> - **ADR alignment** — flag any issue that would touch an Accepted ADR's decision; that
>   needs a superseding ADR, not an improvised change.
> - **Open questions** — anything the body + decision comments do not settle. Do not
>   guess.

Present the plan to the user as a compact summary (order, one line per issue, open
questions). **Wait for approval before executing** — a milestone is hours of autonomous
work; the ordering and any open questions must be confirmed once, up front. If there are
open questions, get answers now, not mid-run.

## Step 3: Issue Loop

Execute the plan's waves in order. Within a wave, issues run **in parallel** — each in
its own branch and worktree (3a–3c). Integration back into the milestone branch (3d),
verification (3e), and the acceptance check (3f) are always **sequential**, one issue at
a time in plan order. The main checkout stays on `milestone-M<N>` throughout and is never
touched by implementation agents.

### 3a: Issue Branch + Worktree

Map the issue's label to a prefix (`bug`→`fix/`, `enhancement`→`feat/`,
`documentation`→`docs/`; an issue labeled both bug and enhancement is `fix/`), then
create the issue branch off the milestone branch in a dedicated worktree (worktrees live
under `.claude/worktrees/`, which is gitignored):

```bash
git worktree add .claude/worktrees/issue-<N> -b <prefix><N>-<short-kebab-title> milestone-M<M>
```

### 3b: Blueprint (Opus, in the worktree) — the detailed handoff

Before any code is written, launch a **fresh blueprint Agent with `model: opus`**,
read-only, pointed at the worktree, with the full spec (issue body + decision/guidance
comments + the Step 2 outline). This runs **just-in-time per issue** — never batched in
Step 2 — so it describes the codebase as it actually is after previous waves merged. Its
output is the construction plan Sonnet follows; its purpose is a right-first-pass
implementation that removes fix rounds.

> Read the spec below, then read the actual code it touches. Produce an **Implementation
> Blueprint** precise enough that a competent implementer who reads only your blueprint
> plus the files you name produces the intended diff on the first attempt:
>
> 1. **File-by-file change list** — exact paths, create vs modify; per file, the change
>    at symbol level: exported functions and their signatures, OpenAPI schema fields
>    (with the codegen + Rust-mirror steps spelled out when a spec changes), route
>    method + path + status codes matching the contract, error codes, i18n keys to add
>    (per `dashboard/src/locales/`), `SARDEENZ_*` env var names and defaults (mirrored
>    into `.env.example`), SQL migration steps (`control-plane/migrations/NNN-*.sql`,
>    next free number).
> 2. **Exemplar anchors** — for every new file or pattern, name one existing file
>    (`path:line`) whose shape to copy. Never describe a pattern abstractly when the
>    repo already contains it (e.g. a new Fastify route copies an existing route module's
>    shape; a new dashboard page copies an existing page + its i18n namespace; a new
>    Lua routing-map script copies the existing atomicity pattern). If the repo has no
>    exemplar yet, say so and name the closest reference (the vendored v1 code under
>    `dashboard/reference/v1/` for v1-parity features).
> 3. **Contracts** — the architecture principles that apply, by name (ADR-005 contract
>    flow; proxy statelessness; control plane owns VRAM/lifecycle; SIF signing chain);
>    boundary contracts if a contract surface is crossed (what serializes, which side is
>    generated vs hand-maintained, Redis-published shapes); and every value the spec
>    says must be configurable.
> 4. **Test plan** — test files with named cases (happy path, edge, failure) and the
>    existing harnesses/mocks/fixtures to reuse — control-plane and dashboard and
>    dev-worker use **vitest** under `src/**/__tests__/`; the proxy has cargo
>    integration tests under `proxy/tests/` with `TestProxy`/`MockRunner`/
>    `MockControlPlane` helpers; `control-plane` has `test:integration` (needs
>    Postgres/Redis from `compose.yaml`); cluster-gated behavior goes to
>    `tests/gates/run-gates.sh`. Name them; don't let new ones be invented needlessly.
> 5. **Non-goals** — files and behaviors that must NOT change. Be explicit; the diff
>    will be audited against this.
> 6. **Self-check list** — the exact commands the implementer must run before reporting
>    (from the affected workspace's `package.json` scripts and the root `Makefile`:
>    `make typecheck`, `make lint`, `make lint-specs` when specs changed, targeted
>    vitest/pytest/cargo runs — noting which cargo gates are host-only if cargo is
>    absent), plus which acceptance criteria each covers.
>
> **Zero open questions allowed.** Resolve every ambiguity by reading code, the ADRs,
> and the issue's decision comments. If something genuinely cannot be resolved from
> spec + code + ADRs, STOP and report the question instead of producing a blueprint —
> do not guess and do not leave it to the implementer.

If the blueprint agent stops with questions, resolve them (yourself from the spec/ADRs,
or with the user if they are real decisions) and re-run — **never spawn the implementer
against an ambiguous blueprint**; ambiguity is where both improvisation and later
regressions come from.

### 3b′: Implement (Sonnet, in the worktree)

Launch a **fresh implementation Agent with `model: sonnet`**, instructed to work **only
inside `.claude/worktrees/issue-<N>`** (absolute paths), passing the full spec (issue
body + decision/guidance comments) **and the Blueprint**:

> Implement the GitHub issue by following the Implementation Blueprint below **exactly**.
> The decision comments are authoritative for intent; the Blueprint is authoritative for
> construction.
>
> Rules: read the exemplar files the Blueprint names before writing; match their
> patterns; follow the ADR-005 contract flow for any spec change (spec → codegen → Rust
> mirror — never hand-edit generated TS); keep the proxy stateless; PatternFly 6 only
> (`pf-v6-`, `--pf-t--` tokens) and i18n for every user-facing string; stay inside the
> Blueprint's non-goals. **If the code contradicts the Blueprint** (drift, missing
> exemplar, signature that can't work): for anything non-trivial STOP and report the
> contradiction instead of improvising; for a trivial mismatch, deviate minimally and
> flag the deviation prominently in your report.
>
> For infra/ops issues (Containerfiles, K8s manifests, compose, CI workflows, gate
> scripts): the same completeness standard applies — manifest + docs + any referenced
> runbook.
>
> Before reporting, install deps (`npm ci` at the repo root covers the workspaces) and
> run the Blueprint's self-check list and include the results verbatim.
>
> Report: files created/modified, self-check results, every deviation from the Blueprint
> with its reason, anything you could NOT implement and why.

Default to one agent per issue; most issues are one coherent change. Commit **in the
worktree**: `<type>(<scope>): <summary> (#<N>)` — types per the repo's conventional
history (`fix`, `feat`, `docs`, `chore`, `refactor`).

### 3c: Review Loop (Opus, in the worktree) — up to 3 rounds

Launch **parallel review Agents with `model: opus`**, each fresh, pointed at the worktree
path. **Every reviewer receives the Blueprint alongside the spec** — with a good
blueprint, round 1 should usually be final; treat repeated rounds as a signal the
blueprint was weak, and say so in the summary.

1. **Spec & blueprint conformance (two-way):** (a) does the implementation match the
   Blueprint — every listed change present, nothing outside it except flagged
   deviations, non-goals untouched? (b) does the Blueprint itself faithfully cover the
   body + decision comments — nothing in the spec that the Blueprint dropped?
   Acceptance criteria met?
2. **Code quality, architecture & over-engineering:** clean code, DRY, error handling,
   consistent patterns; adherence to the non-negotiables (contract flow per ADR-005,
   proxy statelessness, control-plane ownership of VRAM/lifecycle, PF6/i18n rules); no
   premature abstraction or speculative code. (Compose with the `code-review` and
   `simplify` built-ins.)
3. **Security:** injection (parameterized SQL, argv-array spawns — never shell strings),
   auth scoping (BFF JWT roles `admin` vs `admin-readonly`), data exposure in error
   bodies and logs, path containment under the weights/module roots, secrets handling —
   with extra attention to anything touching the SIF supply chain (signing, verify
   gates) or the unauthenticated internal surfaces tracked in #88/#108.
4. **Boundary reviewer** (only if changes touch `packages/contracts/`,
   `proxy/src/generated/`, Redis-published shapes, or the dashboard↔BFF↔control-plane
   API): spec ↔ generated TS ↔ Rust mirror all in agreement (`make lint-specs`,
   codegen diff clean), serialization of Redis payloads (including Lua/cjson
   empty-array hazards), auth flow, and SSE stream lifecycles.

Each classifies findings **high / medium / low**. If no high or medium findings → 3d.
Otherwise spawn **fresh Sonnet fix agents** (in the worktree), commit
`fix: address review findings for #<N> (round <R>)`, and re-review. After 3 rounds, stop
and report unresolved findings to the user rather than looping.

### 3d: Integrate (sequential)

One issue at a time, in plan order, from the **main checkout** on the milestone branch:

```bash
git merge --squash <issue-branch>
# add the issue's CHANGELOG entry under [Unreleased] before committing (project rule)
git commit -m "<type>(<scope>): <summary> (#<N>)"
git worktree remove .claude/worktrees/issue-<N>
git branch -D <issue-branch>
```

The CHANGELOG entry is added here — sequentially, on the milestone branch — precisely so
parallel worktrees never conflict on `CHANGELOG.md`. One squash commit per issue keeps
`milestone-M<N>` linear and reviewable issue by issue in the eventual PR. A merge
conflict here means the plan's independence assessment was wrong — resolve it
deliberately (re-read both issues' intents, don't just pick a side) and note it in the
summary.

### 3e: Verify (Opus, on the milestone branch)

Runs **after** the merge, in the main checkout — so it validates the issue _and_ its
integration with everything already merged. Launch a **verification Agent with
`model: opus`**:

> Run the quality gate for the changes on this branch and judge the results — do not
> just report command output.
>
> 1. `make typecheck` and `make lint` (these skip Rust automatically when cargo is
>    absent — say so explicitly when they do); `make lint-specs` if any spec changed,
>    plus a codegen-drift check (`npm run codegen -w @sardeenz/types` then
>    `git diff --exit-code packages/types/src/generated/`); vitest on affected
>    workspaces; pytest for `runners/vllm` changes; cargo gates if cargo exists,
>    otherwise record them as **needs host run**.
> 2. **Runtime verification** where the change is observable: the user runs dev servers
>    on the host with logs under `/workspace/logs/` (`npm run dev:logged`) — exercise
>    changed API paths with curl against the running services and read their logs; for
>    dashboard changes use Playwright against the dev server when available, otherwise
>    state what was not visually verified; `control-plane` integration tests
>    (`test:integration`) if Postgres/Redis are reachable; for container/manifest
>    changes validate what is validatable locally (`kustomize build`,
>    `docker compose config`, YAML review) and state explicitly what can only be proven
>    on a cluster.
> 3. Check the issue's acceptance criteria one by one: met / not met / not verifiable
>    locally.
>
> Report PASS/FAIL per gate with evidence (quote real command output). Do not soften
> failures.

Fix failures (Sonnet agents, directly on the milestone branch — commit
`fix: resolve verification issues (#<N>)`), re-verify. Do not integrate the next issue
on a failing gate.

### 3f: Acceptance Check (fresh Opus agent for gates 1–2, you for gate 3)

Before recording the issue as done, the delegates' work is independently controlled.
This is a control gate, not a fourth review — keep it lean (reports + diff excerpts, not
whole codebases), and go deep only when something smells off.

**Gates 1 and 2 are delegated to a fresh acceptance Agent spawned with `model: opus`**,
read-only, pointed at the main checkout. The reason is **context isolation**: you have
already read every review report by this point, so you are anchored by them — "did the
reviewer actually engage the diff?" is a question you are poorly placed to answer about
reports that have already persuaded you. A fresh agent arrives with no such memory.
(Note the honest limit stated at the top: this fresh agent shares the reviewers' model
family, so it does not add cross-model coverage — which is exactly why gate 3 below is
non-negotiable.)

Give the acceptance agent: the issue number (it reads body + decision comments itself),
the blueprint, the squash commit SHA plus any verification-fix SHAs, and the two gates
below. Tell it explicitly that **disagreement is the point, not ratification**, and ask
for its own independent read on any judgement call you are minded to wave through.
Require `ACCEPTED` / `NOT ACCEPTED` with the failing gate named.

1. **Did Sonnet build what was asked?** The squash commit's diff stat and targeted
   excerpts against the **Blueprint's file-by-file list and non-goals** (the cheapest
   complete checklist available), then against the issue's acceptance criteria. Hunt
   the two failure modes reviews miss: something claimed in a report but absent from
   the diff, and something in the diff that neither the Blueprint nor a flagged
   deviation accounts for.
2. **Did Opus actually review and verify?** Judge the review and verification _reports_
   for substance: findings must engage the actual diff (file:line references, concrete
   failure scenarios), and every PASS must quote real command output. A round with zero
   findings across all reviewers on a non-trivial diff, or a verification that asserts
   success without evidence, is a red flag — not a good sign. Test a representative
   sample of claims against the code rather than accepting the narrative.

3. **Spot re-run one cheap gate yourself — do NOT delegate this.** E.g.
   `npx tsc --build` for an affected TS workspace, or one targeted vitest file
   (`npx vitest run <file>`), or `make lint-specs` after a contract change. It is
   cheap, it is a fact check rather than a judgement, and crucially **it cannot be
   faked by a report.** With the accept tier on the same model family as the reviewers,
   this un-fakeable check in your own hands is the strongest independent signal in the
   loop — if you delegate every gate and then accept the agent's verdict, you have
   added indirection without rigour (acceptance theatre). Do it every issue.

**You still make the final call.** Judge the acceptance agent's report the same way you
judge any other — a verdict with no file:line evidence is itself a red flag, and
warrants re-running it with a sharpened prompt.

If acceptance fails: route the gap back to the right delegate — a fresh Sonnet fix agent
for missing/excess implementation, or a re-review/re-verification with a sharpened
prompt for a hollow report. **Do not silently fix it yourself** — the audit trail must
reflect who did what. Accept only when all three gates hold; note the acceptance result
(and any rework it triggered) for the status comment and summary.

### 3g: Record

**No push, no PR to `dev`, no issue closing** — the user owns all of those. Instead:

1. Add a **status comment** on the GitHub issue: integrated into `milestone-M<N>` at
   commit `<sha>`, verification results (including any "needs host run" cargo gates and
   anything only provable on a cluster), acceptance-check result (including any rework
   it triggered), anything deferred. **Leave the issue open** — it closes when the
   user's PR merges.
2. Anything discovered during the issue that is out of its scope: file a new issue
   (with the appropriate milestone and labels from the repo taxonomy), do not silently
   expand scope.

Then integrate the next issue, or start the next wave.

## Step 4: Milestone Wrap-Up

When the issue list is exhausted (or the single requested issue is done):

1. **Worktree cleanup (mandatory):** `git worktree prune`; verify no `issue-*` worktrees
   remain under `.claude/worktrees/` and no issue branches remain (`git branch`); the
   main checkout is on `milestone-M<N>` with a clean tree.
2. Verify `CHANGELOG.md` coherence — every integrated issue has its `[Unreleased]`
   entry (added at 3d); consolidate wording if entries overlap, commit as
   `docs: consolidate changelog for milestone M<N>` only if edits were needed.
3. **Draft the PR description** and save it to
   `docs/project/milestone-M<N>-pr-draft.md` (committed on the branch, deleted by the
   user after use): title, per-issue summary, verification status (with the explicit
   "needs host run" / "needs cluster" lists), deferred items, and a `Closes #N` line for
   every completed issue — so merging the user's PR to `dev` auto-closes them. **Do not
   push, do not open the PR, do not close the milestone** — the user decides.
4. **Summary report:**

```markdown
## Milestone Execution Summary — <title>

Branch: milestone-M<N> (local, not pushed — awaiting your PR decision)

| Issue | Result                   | Review rounds | Verification              | Acceptance                       | Commit |
| ----- | ------------------------ | ------------- | ------------------------- | -------------------------------- | ------ |
| #NNN  | done / partial / blocked | n             | pass / pass-with-deferred | accepted / accepted-after-rework | <sha>  |

- Issues completed: X of Y (blocked: list, with reasons)
- New issues filed during execution: [list]
- Not locally verifiable: [cargo gates needing host run; cluster-gated items]
- User actions waiting: [host cargo run, deploy steps, PR decision]
- CHANGELOG updated: yes; PR draft: docs/project/milestone-M<N>-pr-draft.md
- Worktrees/issue branches cleaned up: yes
```

## Failure Handling

- An issue whose spec is contradicted by what you find in the code: **stop that issue**,
  report the contradiction, move to the next unblocked issue, and include it in the
  summary. Never improvise around a wrong spec.
- An issue that would require contradicting an **Accepted ADR**: stop and surface it —
  that needs a superseding ADR (the ADR index is
  `docs/architecture/adrs/README.md`), decided by the user, not an improvised change.
- A cross-milestone prerequisite that turns out unmet (e.g. an M7 issue discovering #79
  unfixed): stop that issue and surface it; do not fix the prerequisite ad hoc.
- A `gh` or git failure is infrastructure, not implementation: retry once, then surface
  it.
- If the user interrupts, leave the milestone branch in a committed state and report
  exactly where execution stopped — a resumed run picks up from the branch's existing
  commits.
