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
   exempt. Freshness is Dependabot's (existing `docker` entries); the manual-bump exceptions with
   no entry by decision are `vllm/0.21.0` (the catalog is retiring it) and `vllm/0.24.0` (the
   runner entries track the catalog's current versions per #233), plus the shared `node:22-slim`
   digest in two Dockerfiles.
2. **Every platform image is scanned post-push, by digest, with Trivy** (`--platform linux/amd64`
   because the digest is an index). A **CRITICAL** finding with a fix **fails the publish**
   (`severity: CRITICAL`, `ignore-unfixed: true`, `exit-code: 1`). CRITICAL-unfixed and **HIGH** are
   report-only, uploaded as SARIF to GitHub code scanning (`security-events: write`). In the manual
   workflow the push lands on a **staging tag, `<tag>-staging`**, never on the requested tag: scans
   are post-push by construction, so the requested tag is only moved afterwards (decision 4).
3. **`.trivyignore.yaml` is the only suppression channel**, in Trivy's own YAML ignorefile schema
   (<https://trivy.dev/latest/docs/configuration/filtering/#trivyignoreyaml>). Every entry carries
   the id, a `statement` justification with the removing issue, and an `expired_at` date that Trivy
   enforces — suppression stops by itself, so a stale exception re-opens the gate instead of hiding
   a finding forever. Unfixed findings need no entry (they are not gated).
4. **Every platform image is signed keyless with cosign after the scan passes**, by digest, never by
   tag: `id-token: write`, Sigstore public-good Fulcio/Rekor, and cosign's legacy referrers mode
   (`--registry-referrers-mode legacy`), which stores an ordinary `sha256-<digest>.sig` tag that the
   Quay robot can already write. The signed reference is the digest, never a tag:
   `cosign sign --yes <ref>@<digest>`. **No private key exists.** If a publish reports the legacy
   `.sig` write rejected by the registry, that is the documented fallback: re-run with
   `COSIGN_EXPERIMENTAL=1` and `--registry-referrers-mode oci-1-1` (cosign 3.1.5 refuses that mode
   without the environment variable). **Then, and only then, the manual workflow promotes the
   requested tag onto that exact digest**: `docker buildx imagetools create -t <ref>:<tag> <ref>@<digest>`.
   `imagetools create` copies the already-pushed manifest list into a new tag, so
   the digest — and therefore the signature over it — is unchanged. A gate failure never reaches the
   promotion, so the requested tag keeps pointing at the previous image; the staging tag stays
   behind for inspection. The per-merge workflow keeps its immutable 7-char sha tags (not a deployed
   reference) and does not promote.
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
7. **A deployable reference is only ever scanned and signed**: the manual workflow moves the
   requested tag onto a digest only after the gate passed and that digest was signed (decision 4),
   and overlays pin a tag/digest (unchanged, #247) that an operator verifies before pinning it.
8. **Air-gapped clusters**: verification needs Fulcio/Rekor reachability, so a mirror verifies the
   digest at import time and records it; the cluster then trusts the pinned digest, not the online
   signature.
9. **Worker-base pairing consumes only a verified base**: both workflows' worker job runs
   `cosign verify` on the resolved worker-base digest — identity
   `^https://github\.com/rh-aiservices-bu/school-of-sardeenz/\.github/workflows/publish-(platform-)?images\.yml@refs/heads/dev$`,
   issuer `https://token.actions.githubusercontent.com` — **before** building `FROM` it, and the
   build is fail-closed: an unsigned or foreign base aborts the publish. The digest is the one the
   base job signed in that run (manual workflow) or the one the resolved sha/`latest` tag points at
   (per-merge); the per-run pair is therefore unchanged, but moving a tag with compromised robot
   credentials can no longer launder an unsigned base into a signed worker. `cosign verify` needs no
   `id-token`, so job permissions are unchanged.

## Consequences

- **Positive:** the seven movable bases are frozen per digest and the gate names them; a compromised
  or retagged base cannot silently enter a rebuild, and a worker publish refuses a base this
  repository did not sign on `dev`; the deployable tag never points at an image that failed the gate
  or lacks a signature; an operator can prove provenance without a shared secret; findings surface
  on the code-scanning board.
- **Negative/costs:** the publisher now depends on Sigstore public-good availability (a documented
  outage fallback is an _additional_ keypair signature later — additive, nothing re-signed);
  verification is online-only; a fixed CRITICAL in a freshly published base blocks the publish until
  the base digest is bumped (intended); HIGH findings can sit undismissed unless triaged; a
  worker-only merge fails until a **signed** `worker-base:latest` exists (a pre-#266 tag must be
  republished once); each manual publish leaves a `<tag>-staging` tag in the registry (kept for
  inspection after a failure).

## Non-goals

- SIF signing (apptainer keypair, ADR-017).
- Cosign verification of a SIF's source image (#138).
- Base-refresh automation beyond Dependabot.
- SBOM generation/Grype.
- Signature enforcement at Kubernetes admission (that is the overlay pin + cluster policy,
  #247/#235-slim).
- Signing from a non-`dev` ref.
- Registry-side tag immutability and staging-tag cleanup: a robot that moves a tag is out of scope
  here — the controls are the digest pins, the worker-base verification (decision 9) and Quay
  policy.
