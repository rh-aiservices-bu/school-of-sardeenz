# Containers & Deployment — AGENTS.md

Covers `containers/` (image definitions) and `deployment/` (Kustomize manifests). Both are small
today and will grow with each engine and cluster feature.

**Read first:** [`containers/README.md`](../containers/README.md) (image kinds, how a runner image
becomes a SIF) and [`deployment/README.md`](README.md) (Kustomize conventions, naming, cluster
prerequisites). **Decisions:** [ADR-015](../docs/architecture/adrs/adr-015-sif-runtime-packaging.md)
SIF delivery, [ADR-016](../docs/architecture/adrs/adr-016-sif-worker-security-posture.md) worker
security, [ADR-017](../docs/architecture/adrs/adr-017-runner-image-pipeline.md) build/sign
pipeline, [ADR-018](../docs/architecture/adrs/adr-018-runner-catalog-oras-distribution.md) ORAS
catalog, [ADR-013](../docs/architecture/adrs/adr-013-secrets-management.md) secrets.
**Operator guides:** [`docs/usage/deployment-security.md`](../docs/usage/deployment-security.md),
[`docs/usage/runner-catalog.md`](../docs/usage/runner-catalog.md).

## Layout

| Path                                                 | What                                                                    |
| ---------------------------------------------------- | ----------------------------------------------------------------------- |
| `containers/control-plane/`, `containers/dashboard/` | Service images (Dockerfile)                                             |
| `containers/worker-base/`                            | Slim worker host: UBI + Apptainer + FUSE, execs SIFs, no engine         |
| `containers/runner-<engine>/`                        | Engine image that is converted to a SIF (`vllm`, `mlserver`)            |
| `deployment/control-plane/`                          | NetworkPolicy for the control plane                                     |
| `deployment/sif-runner/`                             | Worker SCC, RBAC, PVCs, NetworkPolicy, Deployment, PVC write-protection |
| `deployment/librarian/`                              | Parameterized OpenShift OCI + SIF + ORAS publishing Job                 |
| `scripts/build-sif.sh`                               | OCI image → optional signed SIF conversion/publish                      |
| `runners.yaml` (repo root)                           | Official runner catalog consumed by `SARDEENZ_RUNNER_CATALOG_URL`       |

## Rules

- **Kustomize, plain YAML, no Helm.** One resource per file, `sardeenz-` prefix, namespace set
  by the overlay.
- **Security posture is a contract (ADR-016):** any change to the SCC, capabilities, seccomp,
  `/dev/fuse` annotation, or PVC write protection needs an ADR update and a note in
  `docs/usage/deployment-security.md`.
- **Runner images become SIFs:** a new `containers/runner-<engine>/` needs the shim package in
  `runners/<engine>/`, a `runners.yaml` entry (digest-pinned `image`, required `protocol`), and a
  gate in `tests/gates/` if it changes the launch path.
- **Production images are signed (ADR-017);** unsigned publishing is only for an explicitly
  verification-disabled PoC. Catalog entries remain digest-pinned even during a PoC.
- **NetworkPolicies allow-list ingress per flow** (control plane → worker agent port today).
  Add an explicit rule per new flow; the proxy → engine rule is tracked in #181.
- Ports and env var names must match the code defaults (`control-plane/src/config.ts`,
  `runners/dev-worker/src/config.ts`, `proxy/src/config.rs`) — do not invent new ones here.
