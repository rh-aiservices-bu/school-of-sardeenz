# ADR-034: CI Configuration Is Code-Owned, and a Self-Referential Gate States Its Ceiling

## Status

Accepted. Implements [#338](https://github.com/rh-aiservices-bu/school-of-sardeenz/issues/338)
(M22). Relates to [ADR-013](adr-013-secrets-management.md) (no long-lived secret is added) and
[ADR-030](adr-030-platform-image-signing-and-scanning.md) (the sibling case: an image gate whose
configuration can weaken it).

## Context

M22 added gates whose **own configuration is a bypass**:

- `.gitleaks.toml` decides what the secret scan ignores. A PR can add an allowlist entry — or a
  `# gitleaks:allow` trailer in any file — in the same diff as the secret it introduces.
- `.github/workflows/ci.yml` and `advisories.yml` decide whether the gates run at all, at which
  depth, and with which permissions.
- `runners/ci-constraints.txt` decides what the nightly `pip-audit` actually audits.
- `.github/dependabot.yml`, `containers/runners/` and `deployment/prereq/` decide what the coverage
  check and the digest pins consider valid.

No workflow can police the revision of its own configuration: a CI assertion that "the allowlist
diff must be empty" lives in the workflow the same PR can edit, so it is theatre. Meanwhile this
repository runs several agent sessions in parallel, each able to open a PR.

## Decision

1. **One `.github/CODEOWNERS` routes the gates' control surface to the maintainer**: `.gitleaks.toml`,
   `.github/workflows/`, `.github/dependabot.yml`, `runners/ci-constraints.txt`,
   `containers/runners/`, `deployment/prereq/` — **and `/.github/CODEOWNERS` itself.**
2. **Self-ownership is explicit.** GitHub evaluates the CODEOWNERS of the pull request's _head_
   branch, so a PR could otherwise delete the `.gitleaks.toml` rule and allowlist a secret in the
   same diff: the reviewers it removes cannot restore a rule they no longer see. Routing the file's
   own path closes that.
3. **The prerequisite is stated, not assumed.** CODEOWNERS requests a review; it blocks a merge only
   once a repository admin enables **Require review from Code Owners** for `dev`. Until then the
   file is documentation with a request attached. The docs say exactly that.
4. **The ceiling is stated too.** A PR that deletes the ownership rule _and_ the rule it protects in
   the same diff presents a CODEOWNERS that matches none of its changed files, so the required
   review is satisfied vacuously. No pattern can survive its own deletion. The remaining control is
   that such a deletion is a loud, reviewable diff (plus any non-CODEOWNERS branch protection).
5. **No CI self-assertion.** A step that fails when the allowlist changes would be deleted by the
   PR it is meant to catch; it is recorded here as rejected rather than implemented.

## Consequences

- Weakening a gate now costs a maintainer's review, which is the only control that does not depend
  on the PR's own revision.
- Every edit under those paths is slower by one review. That is the intended price; additions to the
  runner catalog, the prereq digests and the CI constraints are all security-relevant.
- If branch protection is never enabled, the file is inert — an honest, documented state, not a
  silent false assurance.
- The `# gitleaks:allow` trailer stays available for legitimate secret-shaped examples and stays a
  self-service bypass in any non-owned file; the docs name it as a residual, and `git log -S` leaves
  a trail.

## Non-goals

- A dedicated security owner group or a second approver tier (a repository setting, not a file).
- Protecting read paths that cannot weaken a gate (docs, tests that only report).
- Preventing a maintainer from deliberately changing a gate.
- Signature or attestation of workflow files (a platform capability, not a repository one).
