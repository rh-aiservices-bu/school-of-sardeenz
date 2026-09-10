# Runner catalog

The runner catalog lets operators browse a curated list of engine runners and **import** them
(pull their SIF onto the shared module store) from the dashboard — no need to build SIFs yourself.

## How it works

- **Official runners** are built + signed, then pushed to an OCI registry as **ORAS** artifacts
  (`apptainer push my.sif oras://quay.io/rh-aiservices-bu/sardeenz-runners/<engine>:<tag>`).
- A **catalog** file (`runners.yaml`) lists the available runners (title, description, engine,
  version, ORAS image, `sifName`, tags, `protocol`, `entrypoint`, …). `protocol` (required:
  `openai` | `oip`) names the proxy protocol family the runner's models are invoked under —
  `openai` for OpenAI-compatible engines (vLLM), `oip` for KServe V2 Open Inference Protocol
  engines (MLServer). `entrypoint` (optional argv) is the verbatim command the worker execs inside
  the SIF to launch the runner's management shim, falling back to the worker's
  `SARDEENZ_RUNNER_ENTRYPOINT` when absent. See [ADR-021](../architecture/adrs/adr-021-protocol-family-path-prefixes.md).
  The default catalog is the official
  [`school-of-sardeenz/runners.yaml`](https://raw.githubusercontent.com/rh-aiservices-bu/school-of-sardeenz/refs/heads/main/runners.yaml);
  point `SARDEENZ_RUNNER_CATALOG_URL` at your own to customize. The repo-root
  [`runners.yaml`](../../runners.yaml) is the dev source and the schema reference.
- The **control plane** loads the catalog, cross-references the module store, and serves a merged
  view (which entries are imported, whether an update is available, and any module-store SIFs not
  in the catalog). Manual **Refresh** bypasses HTTP and intermediary caches so a mutable catalog URL
  is re-read from its origin. The dashboard shows when that fetch completed and also refreshes live
  via the event stream during imports.
- **Import** resolves the digest-pinned OCI manifest, streams its single SIF layer directly onto
  the module store with byte-level progress, verifies the layer digest and SIF signature, and
  publishes it atomically. The imported image digest is recorded in a
  `<sifName>.sif.metadata.json` sidecar. If the catalog later advertises a different digest for the
  same engine version, the dashboard marks an update available; **Re-import** installs it. Legacy
  SIFs without sidecar metadata are conservatively marked as having an update until re-imported
  once. **Uninstall** deletes both files (blocked while a runner started from the SIF is running).
  The [librarian build pipeline](../../deployment/librarian/) remains for building your own SIFs.

## Configuration

| Var                               | Purpose                                                                                                                                                                               | Default                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `SARDEENZ_RUNNER_CATALOG_URL`     | Catalog source — http(s) URL, local path, or `file://`                                                                                                                                | official `school-of-sardeenz` raw URL |
| `SARDEENZ_ALLOW_INSECURE_CATALOG` | Allow an `http://` (plaintext) catalog source. Off by default — a plaintext catalog can be rewritten in transit. Prefer `https://` or a local path/`file://` instead of enabling this | `false`                               |
| `SARDEENZ_MODULES_DIR`            | Shared module store path                                                                                                                                                              | `/modules`                            |
| `SARDEENZ_SIF_IMPORTER`           | `oras` (real OCI SIF stream + verification) or `stub` (explicit dev/test placeholder that cannot execute)                                                                             | `oras`                                |
| `SARDEENZ_VERIFY_SIF`             | `apptainer verify` SIFs — at catalog import (control plane) and at exec (worker). Set `false` for unsigned experimentation only (see below)                                           | `true`                                |
| `APPTAINER_AUTH_FILE`             | Docker-format registry credential file used by OCI imports; credentials are sent only after an HTTPS registry authentication challenge                                                | unset (public registries only)        |

ORAS image references (`image: oras://...`) in the catalog must be digest-pinned
(`oras://<registry>/<repo>:<tag>@sha256:<digest>`). A mutable tag can be repointed after a catalog
entry was reviewed, silently changing what gets pulled onto the module store; entries without a
digest are skipped (logged) rather than imported. `scripts/build-sif.sh` enforces the same
digest-pinning requirement on its `--image` input.

Deployment requirements (RW module mount, `sardeenz-control-plane` SA, apptainer in the image,
signing public key) are in [`deployment/control-plane/`](../../deployment/control-plane/).

## Publishing an official runner (maintainers)

1. Build + sign the runner SIF (see [`containers/runners/vllm/0.21.0`](../../containers/runners/vllm/0.21.0) and the
   [librarian pipeline](../../deployment/librarian/), or `apptainer build` + `apptainer sign`).
2. Push it via ORAS: `apptainer push <engine>-<version>.sif oras://quay.io/rh-aiservices-bu/sardeenz-runners/<engine>:<tag>`.
3. Add an entry to the catalog `runners.yaml` (schema in the repo-root sample). `sifName` by
   convention follows the `<engine>-<version>` shape and must match `^[A-Za-z0-9_.-]+$` (it becomes
   the `runtimeModule` a worker execs).
4. Sign SIFs with the key whose **public** half is distributed to workers and the control plane, so
   `apptainer verify` trusts them at import and exec.

## Unsigned SIFs (experimentation only)

Signing/verification is defense-in-depth for a shared cluster, not a prerequisite for getting
runners working. During early experimentation — no CI, no librarian, no signing key yet — you can
skip it entirely and turn it back on later (it is a runtime toggle; nothing built now is wasted).

1. Use the parameterized librarian pipeline with `SIGN_SIF=false`, or build and push manually
   without `apptainer sign`:

   ```bash
   export APPTAINER_TMPDIR=/scratch APPTAINER_CACHEDIR=/scratch/cache
   apptainer build vllm-0.21.sif docker://quay.io/rh-aiservices-bu/sardeenz-runner-images/vllm:0.21
   apptainer push --allow-unsigned vllm-0.21.sif \
     oras://quay.io/rh-aiservices-bu/sardeenz-runners/vllm:0.21
   ```

2. Set `SARDEENZ_VERIFY_SIF=false` on **both** the control plane (skips verify after the OCI download)
   and the workers (skips verify before exec). Locally that is one line in `.env`, which drives both;
   on a cluster set the env var on the control-plane and worker Deployments.

Anyone with registry/store write access can then build and publish — no keys, no coordination.

> **Security trade-off.** Access control answers _who may write_; the signature answers _is this SIF
> byte-for-byte what was built_. With verification off, anything that gains write access (leaked
> credentials, a bad job, a half-written file) can run code on your GPUs unquestioned. SIFs on an RWX
> volume / ORAS artifacts also bypass the cluster's normal image-admission checks. Keep an unsigned
> instance inside a trusted sandbox, and re-enable `SARDEENZ_VERIFY_SIF` with a **shared signing key**
> (private half in CI/librarian, public half distributed to workers + the control plane — see
> [`deployment/librarian/`](../../deployment/librarian/)) before exposing or sharing the deployment.

### Example: an MLServer (OIP) entry

```yaml
- id: mlserver-1.7
  title: MLServer 1.7 (KServe V2)
  description: Seldon MLServer 1.7 — KServe V2 Open Inference Protocol, sklearn/HF-backed.
  engine: MLServer
  runnerType: mlserver
  version: '1.7'
  image: oras://quay.io/rh-aiservices-bu/sardeenz-runners/mlserver:1.7@sha256:<digest>
  sifName: mlserver-1.7
  protocol: oip
  entrypoint: [python3, -m, sardeenz_mlserver_runner]
  supportedModelTypes: [PREDICTIVE, LLM, EMBEDDING]
```

## Authoring your own catalog

Copy `runners.yaml`, host it anywhere reachable (an internal URL, a Git raw URL, or a file mounted
into the control plane), and set `SARDEENZ_RUNNER_CATALOG_URL`.

Entries that fail validation are skipped, but a missing or invalid `protocol` is now a **loud,
surfaced** validation error — such entries are excluded from the imported list, reported in
`RunnerCatalogView.invalidEntries`, and shown in the dashboard's "some catalog entries were
skipped" warning, rather than silently dropped. This keeps an out-of-date or malformed catalog from
presenting as "no runners available" with no explanation.

Importing a runner whose `protocol` the **running proxy does not advertise** fails at import time
with an actionable "proxy upgrade required" (409) error — the proxy publishes its supported
protocol set at the `{prefix}:proxy:protocols` Redis key on every (re)connect, and catalog import
checks it as a forward-compat guard (fail-open when the key is absent, e.g. the proxy hasn't
started yet). See [ADR-021](../architecture/adrs/adr-021-protocol-family-path-prefixes.md).
