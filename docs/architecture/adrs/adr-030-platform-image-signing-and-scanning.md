# ADR-030: Platform Images Are Digest-Pinned, Trivy-Gated and Cosign-Signed in CI

## Status

Accepted. Implements [#266](https://github.com/rh-aiservices-bu/school-of-sardeenz/issues/266)
(M19). Clarifies [ADR-017](adr-017-runner-image-pipeline.md) (runner image build & supply chain:
this ADR supplies the scan/sign half for platform images; SIF signing stays the apptainer keypair).
Relates to [ADR-013](adr-013-secrets-management.md) (no new long-lived secret is introduced) and
[ADR-026](adr-026-vap-activation-labeled-namespace.md) (module-PVC write protection is a different
control).

## Context

Four facts shape this decision:

- **Five platform images, two workflows.** Proxy, control plane, dashboard, worker-base and worker
  are published by `.github/workflows/publish-images.yml` (on merges to `dev`) and
  `.github/workflows/publish-platform-images.yml` (manual, parameterized tag).
- **No CI scan or signature, and movable bases.** Before this change none of the five was scanned
  or signed by CI, and seven `FROM` lines were tag-only — so a rebuild silently inherited whatever
  the tag pointed at, with nothing recording which bytes were published.
- **SIF signing does not cover source images.** SIF signing is an apptainer keypair
  (ADR-017, Decision 3-4), which covers SIFs only; the OCI image a runner SIF is converted from is
  outside it (#138).
- **Deployable references are pinned per environment in overlays (#247).** That makes the published
  digest the natural thing for an operator to verify before pinning it.

## Decision

1. **Every `FROM` of every image this repository builds is digest-pinned as `name:tag@sha256:<64>`**
   (tag kept for readability). `tests/container-images/verify-image-pins.mjs` enforces it in the CI
   `quality` job and via `make verify-image-pins`; stage aliases, `ARG` references and `scratch` are
   exempt. Freshness is Dependabot's (existing `docker` entries); exceptions: `vllm/0.21.0` (manual
   bump, no entry by decision) and the shared `node:22-slim` digest in two Dockerfiles.
2. **Every platform image is scanned post-push, by digest, with Trivy** (`--platform linux/amd64`
   because the digest is an index). A **CRITICAL** finding with a fix **fails the publish**
   (`severity: CRITICAL`, `ignore-unfixed: true`, `exit-code: 1`). CRITICAL-unfixed and **HIGH** are
   report-only, uploaded as SARIF to GitHub code scanning (`security-events: write`).
3. **`.trivyignore` is the only suppression channel** and every entry carries the image, a
   justification, the date and the removing issue. Unfixed findings need no entry (they are not
   gated).
4. **Every platform image is signed keyless with cosign after the scan passes**, by digest, never by
   tag: `id-token: write`, Sigstore public-good Fulcio/Rekor, and cosign's legacy referrers mode
   (`--registry-referrers-mode legacy`), which stores an ordinary `sha256-<digest>.sig` tag that the
   Quay robot can already write. The signed reference is the digest, never a tag:
   `cosign sign --yes <ref>@<digest>`. **No private key exists.**
5. **The trust anchor is the workflow identity plus the OIDC issuer**, not a key. The exact
   verification command (also in `containers/README.md` and `deployment/README.md`):

   ```bash
   cosign verify \
     --certificate-identity-regexp '^https://github\.com/rh-aiservices-bu/school-of-sardeenz/\.github/workflows/publish-(platform-)?images\.yml@refs/heads/dev$' \
     --certificate-oidc-issuer https://token.actions.githubusercontent.com \
     quay.io/rh-aiservices-bu/sardeenz-proxy@sha256:<digest>
   ```

   The identity string encodes the file name **and** the ref: renaming a publish workflow, or signing
   from a branch (a manual dry run), changes it. Verifying a dry-run artifact therefore requires
   `--certificate-identity-regexp` matching that branch's ref.

6. **Scope: the five platform images in both publish workflows**, including `worker-base` (it is the
   base of the deployable worker and of the librarian SIF-conversion container). Runner images are
   built by the OpenShift Docker build and converted to SIFs; their integrity is the SIF signature
   (ADR-017) — they are **not** cosign-signed by these workflows.
7. **Signed is a prerequisite for deployable**: overlays pin a tag/digest (unchanged, #247), and an
   operator verifies the digest before pinning it.
8. **Air-gapped clusters**: verification needs Fulcio/Rekor reachability, so a mirror verifies the
   digest at import time and records it; the cluster then trusts the pinned digest, not the online
   signature.

## Consequences

- **Positive:** the seven movable bases are frozen per digest and the gate names them; a compromised
  or retagged base cannot silently enter a rebuild; an operator can prove provenance without a
  shared secret; findings surface on the code-scanning board.
- **Negative/costs:** the publisher now depends on Sigstore public-good availability (a documented
  outage fallback is an _additional_ keypair signature later — additive, nothing re-signed);
  verification is online-only; a fixed CRITICAL in a freshly published base blocks the publish until
  the base digest is bumped (intended); HIGH findings can sit undismissed unless triaged.

## Non-goals

- SIF signing (apptainer keypair, ADR-017).
- Cosign verification of a SIF's source image (#138).
- Base-refresh automation beyond Dependabot.
- SBOM generation/Grype.
- Signature enforcement at Kubernetes admission (that is the overlay pin + cluster policy,
  #247/#235-slim).
- Signing from a non-`dev` ref.
