# ADR-018: Runner Catalog and ORAS Distribution

## Status

Accepted. Extends [ADR-015](adr-015-sif-runtime-packaging.md) (SIF runtime delivery) and
[ADR-017](adr-017-runner-image-pipeline.md) (build/supply chain) with a _distribution_ and
_provisioning-UX_ layer. Amends ADR-017's "the librarian is the only module-store writer" premise
(see Consequences).

## Context

[ADR-017](adr-017-runner-image-pipeline.md) makes Sardeenz build + sign SIFs in a librarian job.
That is sufficient for the maintainers who build engine images, but it forces **every operator** to
stand up the librarian pipeline (build a ~5–6 GB image, run a conversion Job with node-local scratch
and RAM headroom, manage signing keys) just to get a usable runner onto the module store. For a
platform meant to be adopted, "clone the repo and rebuild every SIF" is too high a bar.

Two facts make a lighter path possible:

- **A finished SIF is a single squashfs file** — it can be stored as an **OCI artifact** and pulled
  with `apptainer pull oras://…`. Unlike an OCI _image_ → SIF _conversion_ (hardlink-heavy unpack,
  node-local scratch, GBs of RAM — ADR-017), an ORAS **pull is a plain download** of the already-
  built file: no unpack, no scratch, no privilege.
- **Sardeenz must not assume Kubernetes.** It can run as independent containers on VMs via Podman.
  A provisioning mechanism that requires a K8s `Job` (as the librarian does) is therefore the wrong
  primitive for the common "import a published runner" path, and is also painful to test locally.

## Decision

**Official runners are published as signed SIFs to an OCI registry via ORAS and offered through an
in-app catalog; operators import them on demand. The librarian build pipeline (ADR-017) remains for
building your own.**

1. **Publish via ORAS.** Maintainers `apptainer push <engine>-<version>.sif oras://<registry>/<repo>:<tag>`.
   SIFs are signed at build (ADR-017) and verified at pull/exec.
2. **A catalog file (`runners.yaml`)** lists available runners (id, title, description, engine,
   runnerType, version, ORAS image, `sifName`, tags, `minVRAMGiB`, license, icon). The dev source /
   schema reference is the repo-root `runners.yaml`; the source is configurable via
   `SARDEENZ_RUNNER_CATALOG_URL` (http(s) URL or local file), defaulting to the official catalog.
3. **The control plane loads + serves the catalog**, merged against the module store (import state,
   `unmanagedModules`), and **performs the import itself** — no Kubernetes Job. On import it
   `apptainer pull oras://…`s the SIF onto the module store, `apptainer verify`s it, and publishes
   it atomically (temp file → `chmod 0644` → rename). Progress is reported on the SSE stream
   (`CATALOG_*` events). Uninstall deletes the SIF, guarded against in-use modules.
4. **The importer is pluggable** (`SifImporter`): `OrasImporter` (real; `apptainer pull` + verify)
   and `StubImporter` (dev/CI; writes a placeholder, no apptainer). This keeps the control plane
   runtime-agnostic (Kubernetes PVC _or_ Podman/VM bind mount) and locally testable.

## Consequences

- **The control plane becomes a second module-store writer** (alongside the librarian). This amends
  ADR-017's "only the librarian writes the module PVC": the write-protection mechanism (the
  module-PVC ValidatingAdmissionPolicy) now exempts **two** ServiceAccounts — `sardeenz-librarian`
  and `sardeenz-control-plane` — and both are legitimate writers. The signed-at-build /
  verify-at-exec supply chain is unchanged; the control plane also verifies at import.
- **The control-plane image needs the apptainer CLI** (unprivileged — pull/verify are download-only,
  no setuid/fuse/userns). The control plane mounts the module store **read-write**; workers still
  mount it read-only.
- **Distribution is decoupled from building.** Most operators never run the librarian; they import
  pre-built, signed SIFs. Building your own remains fully supported (ADR-017).
- **No Kubernetes dependency on the import path** — the same code path works under Podman/VM with a
  read-write bind mount, which also makes it unit-testable via the stub importer.
- **Versions are distinct, immutable modules** (`<engine>-<version>.sif`) that coexist; a newer
  version is a separate catalog entry, not an in-place update. Registry-digest staleness detection
  ("re-import to refresh a mutable tag") is a possible future enhancement; today the UI offers an
  explicit **re-import**.
- **In-use guarding is conservative.** A running model records `runnerType` but not the resolved
  module, so uninstall blocks on any running model of the same `runnerType` (sound but over-blocks
  across versions). Precise per-module guarding needs the resolved `runtimeModule` recorded on the
  model at deploy time — a future enhancement.

## References

- [ADR-015](adr-015-sif-runtime-packaging.md) — SIF runtime delivery
- [ADR-017](adr-017-runner-image-pipeline.md) — runner image build & supply chain (amended here)
- [Runner catalog usage guide](../../usage/runner-catalog.md)
- [`deployment/control-plane/`](../../../deployment/control-plane/) — control-plane import requirements
- Repo-root [`runners.yaml`](../../../runners.yaml) — catalog schema + dev source
