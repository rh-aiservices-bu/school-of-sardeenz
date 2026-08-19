# Runner catalog

The runner catalog lets operators browse a curated list of engine runners and **import** them
(pull their SIF onto the shared module store) from the dashboard — no need to build SIFs yourself.

## How it works

- **Official runners** are built + signed, then pushed to an OCI registry as **ORAS** artifacts
  (`apptainer push my.sif oras://quay.io/<ns>/<repo>:<tag>`).
- A **catalog** file (`runners.yaml`) lists the available runners (title, description, engine,
  version, ORAS image, `sifName`, tags, …). The default catalog is the official
  [`school-of-sardeenz/runners.yaml`](https://raw.githubusercontent.com/rh-aiservices-bu/school-of-sardeenz/refs/heads/main/runners.yaml);
  point `SARDEENZ_RUNNER_CATALOG_URL` at your own to customize. The repo-root
  [`runners.yaml`](../../runners.yaml) is the dev source and the schema reference.
- The **control plane** loads the catalog, cross-references the module store, and serves a merged
  view (which entries are imported, whether an update is available, and any module-store SIFs not
  in the catalog). The dashboard refreshes on page entry, on a manual **Refresh**, and live via the
  event stream during imports.
- **Import** runs `apptainer pull <sifName>.sif oras://<image>` onto the module store, verifies the
  signature, and publishes it atomically. **Uninstall** deletes the SIF (blocked while a runner
  started from it is running). The [librarian build pipeline](../../deployment/librarian/) remains
  for building your own SIFs.

## Configuration

| Var | Purpose | Default |
|---|---|---|
| `SARDEENZ_RUNNER_CATALOG_URL` | Catalog source — http(s) URL, local path, or `file://` | official `school-of-sardeenz` raw URL |
| `SARDEENZ_MODULES_DIR` | Shared module store path | `/modules` |
| `SARDEENZ_SIF_IMPORTER` | `oras` (real `apptainer pull`) or `stub` (dev placeholder) | `stub` |
| `SARDEENZ_VERIFY_SIF` | `apptainer verify` pulled SIFs before publishing | `true` |

Deployment requirements (RW module mount, `sardeenz-control-plane` SA, apptainer in the image,
signing public key) are in [`deployment/control-plane/`](../../deployment/control-plane/).

## Publishing an official runner (maintainers)

1. Build + sign the runner SIF (see [`containers/runner-vllm`](../../containers/runner-vllm) and the
   [librarian pipeline](../../deployment/librarian/), or `apptainer build` + `apptainer sign`).
2. Push it via ORAS: `apptainer push <engine>-<version>.sif oras://quay.io/<ns>/<repo>:<tag>`.
3. Add an entry to the catalog `runners.yaml` (schema in the repo-root sample). `sifName` must be
   `<engine>-<version>` and match `^[A-Za-z0-9_.-]+$` (it becomes the `runtimeModule` a worker
   execs).
4. Sign SIFs with the key whose **public** half is distributed to workers and the control plane, so
   `apptainer verify` trusts them at import and exec.

## Authoring your own catalog

Copy `runners.yaml`, host it anywhere reachable (an internal URL, a Git raw URL, or a file mounted
into the control plane), and set `SARDEENZ_RUNNER_CATALOG_URL`. Entries that fail validation are
skipped (logged), so a single bad entry won't break the catalog.
