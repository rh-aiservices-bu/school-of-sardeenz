# Development Setup

## Prerequisites

Sardeenz development uses a containerized environment ([ccbox](https://github.com/guimou/ccbox)) that provides all required tooling. If working outside the container, install:

- **Node.js** >= 22 with npm (version pinned in `.nvmrc`)
- **Rust** stable toolchain (via [rustup](https://rustup.rs/)) with `rust-analyzer`, `clippy`, and `rustfmt` components
- **Podman** with `podman-compose` (or Docker with Docker Compose) — for dev services (Redis/Valkey, PostgreSQL)
- **direnv** (recommended — auto-switches Node version on `cd` via `.envrc`)
- **ripgrep** (recommended for fast code search)

## First-Time Setup

```bash
# If using direnv, trust the project .envrc (one-time)
direnv allow

# Install all npm workspace dependencies
# .npmrc enforces engine-strict — npm will refuse to install on Node < 22
npm install

# Create your local config (git-ignored) — see "Local configuration" below
cp .env.example .env

# Start dev services (Redis/Valkey, PostgreSQL — see "Dev Services" below)
podman compose up -d

# Verify the setup
make all        # Type-check + lint (includes OpenAPI spec validation)
make test       # Run test suites (Vitest)
make format-check  # Prettier + rustfmt (if Rust available)
```

## Local Configuration (`.env`)

All configurable ports and connection URLs live in a single git-ignored `.env` file at
the repo root. Copy [`.env.example`](../../.env.example) to `.env` and change only what you
need — every value has a built-in default, so an empty (or absent) `.env` reproduces the
stock ports. This is the place to resolve port clashes with other projects on your machine.

The file drives everything from one source:

- **`compose.yaml`** reads it automatically for the container **host-port mappings**
  (`SARDEENZ_REDIS_HOST_PORT`, `SARDEENZ_POSTGRES_HOST_PORT`) and Postgres credentials. Only
  the host side of a mapping changes; the in-container port stays fixed.
- **Application services** load it at startup: the Rust proxy via `dotenvy`, the Node
  services (control plane, dashboard BFF, dev worker) via a small per-service `loadRootEnv()`
  helper (built on `dotenv`), and the Vite dev server via `loadEnv()`.

Values already set in the real environment always take precedence over the file, so
per-process overrides still work (e.g. `SARDEENZ_WORKER_PORT=9200 make dev-worker`), and the
loaders are no-ops in production. Integration and E2E suites load the same `.env`, so they
connect to whatever host ports you configured.

> **Two knobs per backing service.** When you move Redis/Postgres to a non-default host
> port, update **both** the compose host-port mapping **and** the matching connection URL
> (`SARDEENZ_REDIS_URL` / `SARDEENZ_DATABASE_URL`) so the apps dial the new port.

> **Note on `SARDEENZ_LISTEN_ADDR`.** The proxy and control plane historically shared this
> name. They now read `SARDEENZ_PROXY_LISTEN_ADDR` and `SARDEENZ_CONTROL_PLANE_LISTEN_ADDR`
> respectively (each still falling back to the legacy `SARDEENZ_LISTEN_ADDR`), so a single
> `.env` can set both independently.

> **Tokens fail closed.** The control plane requires both `SARDEENZ_API_TOKEN` and
> `SARDEENZ_WORKER_TOKEN` at startup (the dev worker needs only `SARDEENZ_WORKER_TOKEN`);
> missing, empty or whitespace-only values fail the start. Set
> `SARDEENZ_ALLOW_UNAUTHENTICATED_API=true` in `.env` for local unauthenticated runs (dev only).

## Project Structure

The monorepo uses npm workspaces for TypeScript and a Cargo workspace for Rust:

```
sardeenz/
├── proxy/              # Rust — cargo workspace
├── control-plane/      # TypeScript — npm workspace
├── dashboard/          # TypeScript — npm workspace
├── packages/
│   ├── contracts/      # OpenAPI specs (source of truth)
│   ├── types/          # Generated TypeScript types
│   └── utils/          # Shared TypeScript utilities
```

## Running Components

Run `make` (or `make help`) to see all targets. Common combos (start `make services` first):

```bash
make dev-full       # whole stack + ONE worker (proxy, cp, dashboard, BFF, worker)
make dev            # stack only (proxy, cp, dashboard, BFF) — same as `npm run dev`; pair with your own worker
make dev-worker     # a single worker on its own (mode/ports from .env)
```

Or start pieces individually:

```bash
make dev-cp         # Control plane (Fastify dev server, :3000)
make dev-bff        # Dashboard BFF server (:4000) — the dashboard's /api backend
make dev-dashboard  # Dashboard Vite client (:5173) — needs the BFF too (dev-bff / dev)
make dev-proxy      # Proxy (cargo watch, requires Rust)
```

> The dashboard is two processes: the Vite client **and** the BFF. `make dev-dashboard` starts only
> the client (it proxies `/api` to the BFF), so run `make dev-bff` alongside it — or just use
> `make dev` / `make dev-full`, which start both.

## Dev Services

Backend services (Redis/Valkey and PostgreSQL) run via Podman Compose. The compose file is at the repo root (`compose.yaml`).

```bash
# Start all services in the background
podman compose up -d

# Check service health
podman compose ps

# View logs
podman compose logs redis

# Stop services (data is preserved in volumes)
podman compose down

# Stop and remove all data volumes (clean slate)
podman compose down -v
```

Docker Compose works identically — replace `podman` with `docker`.

### Services

Host ports are the defaults; override them in `.env` (see "Local configuration").

| Service    | Image             | Default host port | Host-port var                 | Used by                                                       |
| ---------- | ----------------- | ----------------- | ----------------------------- | ------------------------------------------------------------- |
| `redis`    | `valkey/valkey:8` | 6379              | `SARDEENZ_REDIS_HOST_PORT`    | Proxy (routing map), control plane (state), integration tests |
| `postgres` | `postgres:16`     | 5432              | `SARDEENZ_POSTGRES_HOST_PORT` | Control plane (model + budget state)                          |

The dev compose stack has no Prometheus. The dashboard's metrics page is instead exercised with
the Playwright e2e mock (`dashboard/e2e/mocks/prometheus.ts`). Production deployments query
Prometheus through OpenShift user-workload monitoring — see
[`deployment/dashboard/README.md`](../../deployment/dashboard/README.md).

### Connecting from code

The default connection URLs match the compose defaults with no extra configuration; change
them in `.env` if you remap the host ports above:

| Service      | Default URL                                              | Var                     |
| ------------ | -------------------------------------------------------- | ----------------------- |
| Redis/Valkey | `redis://localhost:6379`                                 | `SARDEENZ_REDIS_URL`    |
| PostgreSQL   | `postgresql://sardeenz:sardeenz@localhost:5432/sardeenz` | `SARDEENZ_DATABASE_URL` |

Local development stays passwordless: the compose services are reachable only from your
machine, while the cluster manifests carry Valkey AUTH (`sardeenz-redis-credentials`) and
default-deny NetworkPolicies.

### Integration tests and the database

The control-plane integration tests **TRUNCATE tables**, so they never touch your dev database.
They reach the same Postgres/Redis **server** as the apps (via `.env`) but on a **dedicated test
database**, derived by suffixing the dev DB name with `_test` (e.g. `sardeenz` → `sardeenz_test`)
and a separate Redis logical DB (`1`). The test database is **auto-created** on first run if you
have `CREATE DATABASE` privileges (the local compose `sardeenz` superuser does); otherwise the
integration suite skips. As a safety net, the harness **refuses to run against any database whose
name doesn't end in `_test`**.

| Purpose                              | Var                          | Default                                     |
| ------------------------------------ | ---------------------------- | ------------------------------------------- |
| Override test Postgres               | `SARDEENZ_TEST_DATABASE_URL` | `<SARDEENZ_DATABASE_URL>` with `_test` name |
| Override test Redis                  | `SARDEENZ_TEST_REDIS_URL`    | `<SARDEENZ_REDIS_URL>` on logical DB `1`    |
| Bypass the `_test` guard (dangerous) | `SARDEENZ_ALLOW_NON_TEST_DB` | unset (guard active)                        |

#### In CI

Every PR runs this suite in the `integration` job of `.github/workflows/ci.yml`: the job runs the
same vitest integration config through the control-plane package script (adding a JSON reporter)
and brings its own `postgres:16` and `valkey:8` service containers instead of the compose stack,
so it needs no local services. Because the suite skips itself when it cannot connect (and the
vitest config allows an empty run), a final `if: always()` step runs
`node control-plane/scripts/verify-integration-report.mjs` on that JSON report and **fails when no
test executed or any test was skipped** — a green integration job therefore means the tests ran,
not that they were skipped. Rollout: the job landed staged with `continue-on-error: true` and is
now **blocking** — its first green run (32/32 tests, 2026-11-25) followed the #322 cutover-barrier
fix (#325), and that one line was deleted. Since M21 the suite also carries scripted
**failure scenarios** (`failure-scenarios.integration.test.ts`: Redis loss vs the mass-divergence
guard, control-plane loss mid-wake, worker/runner loss mid-launch, concurrent wake triggers),
taking it to 44 tests.

## Common Commands

| Command                           | Description                                                                                                                                                                                                                                  |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `make` / `make help`              | List all targets with descriptions                                                                                                                                                                                                           |
| `make all`                        | Type-check and lint everything                                                                                                                                                                                                               |
| `make lint`                       | ESLint + clippy + OpenAPI spec validation                                                                                                                                                                                                    |
| `make lint-specs`                 | Validate OpenAPI specs only (Redocly)                                                                                                                                                                                                        |
| `make format`                     | Auto-format all files                                                                                                                                                                                                                        |
| `make format-check`               | Check formatting (CI-safe)                                                                                                                                                                                                                   |
| `make typecheck`                  | TypeScript `tsc --build` + `cargo check`                                                                                                                                                                                                     |
| `make test`                       | Run all test suites (Vitest + cargo test)                                                                                                                                                                                                    |
| `make test-python`                | Run the Python runner-shim (unit + app-level `tests/test_app.py`) + conformance suites (after `make test-python-deps` — which installs pinned test deps from `runners/ci-constraints.txt`; run inside a venv — system python3 lacks fastapi) |
| `make test-coverage`              | Run tests with V8 coverage                                                                                                                                                                                                                   |
| `make test-integration`           | Control-plane integration suite against local Postgres/Redis (`make services`); CI runs the same suite in its blocking `integration` job (green: 44/44 since M21)                                                                            |
| `make codegen`                    | Regenerate types from OpenAPI specs                                                                                                                                                                                                          |
| `make verify-image-pins`          | Verify every Dockerfile/Containerfile `FROM` is digest-pinned (ADR-030)                                                                                                                                                                      |
| `make verify-dependabot-coverage` | Verify every `containers/runners/<engine>/<version>/` directory has a Dependabot entry (or a documented skip) and the `deployment/prereq/` images are dated-tag + digest pinned                                                              |
| `make services`                   | Start dev services (Redis + Postgres)                                                                                                                                                                                                        |
| `make services-stop`              | Stop dev services                                                                                                                                                                                                                            |
| `make clean`                      | Remove all build artifacts                                                                                                                                                                                                                   |

`make test-python-deps` installs the shim test deps under `runners/ci-constraints.txt` — a
generated, CI-only pin file (`make python-constraints` regenerates it; it pins **only the CI/dev
install, not the SIF runtime trees**, where the shims install unpinned atop the vLLM/MLServer base
images). Any PR that changes a shim's `[test]` extras regenerates the file in the same PR. A green
advisory sweep over this set must not be read as "shipped images are audited" — SIF runtime
pinning/auditing is a separate boundary (#338).

## Security and supply-chain checks

Two CI checks cover the committed-code layer that Dependabot (version updates) and Trivy (published
images, ADR-030) leave open: a **blocking** secret scan on every PR and direct push, and a
**nightly, non-blocking** advisory sweep that reports through one GitHub issue instead of a red
Actions tab.

| Check                         | When                                                                     | Configuration                                                              |
| ----------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Secret scan (gitleaks 8.30.1) | Every PR and direct push to `dev`/`main` — the `secrets` job of `ci.yml` | `.gitleaks.toml`, `.github/workflows/ci.yml`                               |
| Dependency advisories         | Nightly 05:17 UTC, plus manual `workflow_dispatch` on `advisories.yml`   | `.github/workflows/advisories.yml`, `tests/security/report-advisories.mjs` |

The secret scan runs over the pushed commit range only (PR: base..head, push: before..sha; a new
branch or a rewritten-away base falls back to the pushed tip) with `--redact`, so a public build log
never prints the finding. Findings block; there is no `continue-on-error`.

### Run the checks locally

```bash
# Secret scan — whole history with the repo's reviewed allowlist (expect "no leaks found").
# Install gitleaks 8.30.1 from its release tarball or `go install github.com/gitleaks/gitleaks/v8`.
gitleaks git --config .gitleaks.toml --redact --log-opts="--all" --exit-code 1

# Prove the allowlist still catches a secret — in a scratch clone, never in this repo.
# The value is generated: this file is itself scanned, so no secret-shaped literal lives here.
git clone . /tmp/gl-rehearsal && cd /tmp/gl-rehearsal
printf 'aws_secret_access_key = "%s"\n' "$(head -c 20 /dev/urandom | od -An -tx1 | tr -d ' \n')" > seeded.txt
git add seeded.txt && git -c user.email=t@t -c user.name=t commit -qm seed
gitleaks git --config .gitleaks.toml --redact --log-opts="HEAD~1..HEAD" --exit-code 1

# Advisory sweep — the same three tools the nightly job runs.
npm audit --audit-level=high
cargo install --locked --version 0.23.0 cargo-audit && cargo audit --format json --file proxy/Cargo.lock
python3 -m venv .venv && PATH="$PWD/.venv/bin:$PATH" make test-python-deps
.venv/bin/pip freeze --exclude-editable > /tmp/requirements-runners.txt
pip-audit -r /tmp/requirements-runners.txt --format json   # venv with `pip install pip-audit==2.10.1`
pip-audit -r requirements-docs.txt --format json
```

Rehearse the issue rendering against the committed fixtures (write the outputs outside the checkout):

```bash
node tests/security/report-advisories.mjs --input tests/security/fixtures/clean        --out /tmp/audit  # exit 0
node tests/security/report-advisories.mjs --input tests/security/fixtures/findings     --out /tmp/audit  # exit 1
node tests/security/report-advisories.mjs --input tests/security/fixtures/failed-check --out /tmp/audit  # exit 2
node tests/security/report-advisories.mjs --input tests/security/fixtures/hostile      --out /tmp/audit  # exit 1
```

The `hostile` fixture carries upstream-controlled text the renderer must neutralise rather than pass
through: markdown link syntax in advisory titles and descriptions, `@`-mentions, a bare
`https://…`/`www.` (GFM autolinks both even in plain prose), a `\|` (a pre-escaped pipe — escaping
it again double-escapes and splits the row), a two-backtick run, a `)` in a link URL, an
`advisory.url` that points at another host (with and without a GHSA id — the npm link is rebuilt
from the sanitised id, never from that URL), a `javascript:` URL, a pipe in an npm package name and
hostile severity/patched strings.

The renderer never escapes that text into markdown. Every upstream field goes through a per-field
whitelist sanitiser before it reaches the table: advisory ids are `[A-Za-z0-9.-]` only, package names
`[A-Za-z0-9._@/+:-]`, versions `[A-Za-z0-9.+~<>=-]` with tag-shaped runs removed, and a value that
does not fit its identifier whitelist is dropped to `unknown` rather than repaired (a repaired id
could read as a different, real advisory); severity is a closed set
(`low|moderate|medium|high|critical|unknown`), and free text loses every markup-capable character,
gets its `https://` and `www.` autolink triggers broken and is truncated at 300 characters. Because
no field can then contain a pipe, a backslash or a backtick, the table cell assembly only normalises
newlines — there is no escape step left to double — and a link destination is never taken from the
tool: it is built from the sanitised id against a fixed host (`rustsec.org`, `github.com/advisories`,
`osv.dev`), so a crafted advisory URL cannot become a clickable destination, and the `http(s)`-only
scheme check remains as defence in depth.

The check below prints `hostile body ok` and exits 0, or lists what broke. It uses node core only
(no parser dependency): it counts the cells of every table line against the header, asserts each
hostile value's sanitised rendering, and asserts that no live link, mention, autolink, `javascript:`
target or tag-shaped markup survives anywhere in the body:

```bash
node --input-type=module -e '
import { readFileSync } from "node:fs";
const body = readFileSync("/tmp/audit/issue-body.md", "utf8");
const problems = [];
const table = body.split("\n").filter((line) => line.startsWith("|"));
if (table.length < 3) problems.push(`findings table missing (${table.length} table lines)`);
const columns = table.length > 0 ? table[0].split("|").length - 2 : 0;
if (columns !== 7) problems.push(`header has ${columns} cells, want 7`);
// A sanitised value carries no pipe, backslash or backtick, so every row splits into exactly the
// header cells and nothing in it needs — or performs — escaping.
for (const line of table) {
  const cells = line.split("|").length - 2;
  if (cells !== columns) problems.push(`${cells} cells, header has ${columns}: ${line}`);
  if (line.includes("\\") || line.includes("`")) problems.push(`escape or code span in a table row: ${line}`);
}
// Each hostile value, rendered: markup characters gone, autolink triggers broken, text still readable.
const literal = [
  "GHSA-1111-2222-3333 clickhttps: //evil.example maintainer",
  "GHSA-4444-5555-6666 See https: //evil.example/bare-url www .evil.example/www for detail",
  "unknown escape https: //evil.example attempt and two backticks",
  "RUSTSEC-2026-9997 cargo title with a pipe",
  "| unknown | 3.0.0 3.1.0 |",
  "unknown clickhttps: //evil.example maintainer | CVSS 7.5",
  ">=2.0.0, 9.9.9, separated",
  "skiphttps: //evil.example maintainer",
];
for (const value of literal) if (!body.includes(value)) problems.push(`not rendered: ${value}`);
// The npm Link column is rebuilt from the sanitised id, never from `advisory.url`: the row whose
// url points at another host must link to GitHub advisories, an id-less one must render plain text.
const linkRow = table.find((line) => line.includes("link-lib"));
if (linkRow === undefined) problems.push("attacker-url row missing");
else if (!linkRow.includes("[GHSA-abcd-efgh-ijkl](https://github.com/advisories/GHSA-abcd-efgh-ijkl)"))
  problems.push(`the npm link was not rebuilt from the id: ${linkRow}`);
const noidRow = table.find((line) => line.includes("noid-lib"));
if (noidRow === undefined) problems.push("id-less attacker-url row missing");
else {
  const link = noidRow.split("|")[7].trim();
  if (link !== "unknown") problems.push(`id-less advisory link cell is "${link}", want plain text`);
}
// The free-text cap: the over-long hostile title is cut at the limit and marked with an ellipsis.
const longRow = table.find((line) => line.includes("long-title-lib"));
if (longRow === undefined) {
  problems.push("long-title row missing");
} else {
  const advisory = longRow.split("|")[4].trim();
  if (!advisory.endsWith("…")) problems.push("the over-long title was not truncated");
  if (advisory.length > 330) problems.push(`the over-long title cell is ${advisory.length} chars, cap not applied`);
}
// Nothing hostile survives as live syntax: no mention, no autolinkable URL, no javascript: target,
// no tag-shaped run, and every link destination is a validated https URL.
if (body.includes("@")) problems.push("an @-mention survives");
if (/https?:\/\/evil|www\.evil|attacker\.example/i.test(body)) problems.push("an autolink trigger survives");
if (/javascript:/i.test(body)) problems.push("a javascript: URL survives");
if (/<(img|script)\b|onerror/i.test(body)) problems.push("tag-shaped markup survives");
for (const [, href] of body.matchAll(/\]\(([^)]*)\)/g)) {
  if (!href.startsWith("https://")) problems.push(`link destination is not https: ${href}`);
  if (/evil\.example|attacker\.example|javascript:/i.test(href)) problems.push(`hostile link destination: ${href}`);
}
if (problems.length > 0) { console.error(problems.join("\n")); process.exit(1); }
console.log(`hostile body ok: ${table.length} table lines, ${columns} cells each, every value sanitised`);
'
```

### Versions and the allowlist

The tool versions are pinned in the workflows as one-line, reviewable changes: gitleaks is
`GITLEAKS_VERSION` + `GITLEAKS_SHA256` in `ci.yml` (bump both together — the release tarball is
checksum-verified), `cargo-audit` and `pip-audit` are version arguments in `advisories.yml`.

`.gitleaks.toml` extends gitleaks' built-in default ruleset; it never copies or replaces the rules.
An allowlist entry must name the file (an anchored path regex) **and** the rule id it silences
(`targetRules`), and a PR adding one must state the finding it silences and why the value is not a
secret. Never allowlist a directory glob over source or tests. The two current entries cover the
credential _templates_ (`deployment/librarian/*.example.yaml`, `.env.example`) for `private-key` and
`generic-api-key` only, so a real AWS key, JWT or Slack token committed to the same file still
fails. Deliberate residual: a secret whose only matching rule is `generic-api-key`, committed inside
one of those two templates, passes — template credentials are placeholders by construction.

Because the gate scans everything committed, an intentional secret-shaped example in documentation
must be generated at run time (the rehearsal block above does) or carry a trailing
`# gitleaks:allow` on that line; never commit a literal that only "looks fake".

**Residual — the trailer is self-service.** `# gitleaks:allow` silences a finding in any file,
including files no owner reviews, and gitleaks has no per-path restriction on it: the scanner cannot
police the annotation that switches the scanner off, so it is deliberately not scoped or asserted
anywhere. The controls are visibility and review — the trailer sits in the diff, so a reviewer must
ask for one every time a diff adds it, and an unexplained trailer carries the same weight as an
allowlist entry — plus the greppable trail it leaves (`git log -S'# gitleaks:allow'`).

A PR can also weaken a gate in the same diff that trips it: `.gitleaks.toml` (an allowlist entry)
and `.github/workflows/` (the scan itself) are ordinary reviewed code, and a workflow cannot police
the revision of its own configuration. The control is mandatory owner review:
[`.github/CODEOWNERS`](../../.github/CODEOWNERS) routes itself, `.gitleaks.toml`,
`.github/workflows/`, `.github/dependabot.yml`, `runners/ci-constraints.txt`, `containers/runners/`
and `deployment/prereq/` to the maintainer. CODEOWNERS owns its own path because GitHub evaluates
the CODEOWNERS of a pull request's head branch: without that entry a PR could delete the
`/.gitleaks.toml` rule and allowlist a secret in one diff, and the reviewers it removed would never
be asked. **Prerequisite outside the PR:** it only bites once a repo
admin enables **Require review from Code Owners** for `dev` (Settings → Branches); until then the
file requests the review but a merge can proceed without it. A CI assertion that a diff leaves those
files untouched is deliberately not added — it would run from a workflow the same diff can edit, so
it would be theatre. **The ceiling:** a PR that deletes the ownership line and the rule it protects
in the same diff presents a CODEOWNERS matching nothing, so the request is satisfied vacuously (any
non-CODEOWNERS branch protection still applies), and the remaining control is that the deletion is a
loud, reviewable diff — the disappearing rules are visible evidence in a way a secret hidden in
added code is not.

### The tracking issue

Findings are filed in a single issue titled `Nightly dependency advisories`, labelled
`area/security`: created on the first finding, updated while findings persist, **closed** on an
all-clear sweep, and **reopened** (never duplicated) by the next finding. An open issue therefore
means "known-vulnerable dependencies right now", and the closed issue keeps the history. Advisories
leave the run green; a check that could not execute (missing/corrupt tool output, a crashed audit
leg) updates the issue _and_ fails the run, so a broken sweep is never silent. The workflow only
needs `issues: write` on the job that writes the issue; nothing else gains write access.

### Boundary

`pip-audit` audits the constrained CI/dev install (`runners/ci-constraints.txt`, built by
`make test-python-deps`), never the SIF runtime trees — those install unpinned atop the vLLM/MLServer
base images by design. Shipped images are Trivy's job in `publish-images.yml` (ADR-030): a green
nightly does **not** mean the shipped images are audited. `runners/conformance` needs no separate
invocation — its `dependencies = []` and the shims are installed editable alongside it, so the
constrained freeze already covers all three shim directories.

## Logs

Dev servers running on the host write their output to the `logs/` directory in the project root (gitignored). Since the project folder is bind-mounted into the ccbox container, Claude Code can read these logs directly to debug runtime issues without needing output pasted into the conversation.

`logs/` is excluded from ESLint (`.eslintrc`-style global `ignores` in `eslint.config.js` — ESLint 9 does
not read `.gitignore`, so `eslint .` would otherwise lint throwaway verification scripts parked
there) and from Prettier (`.prettierignore`). TypeScript and Vitest cannot see it at all: `tsc
--build` is reference-scoped to each project's `include`, and the root `vitest.config.ts` lists only
workspace projects. Scratch files in `logs/` therefore never affect `make lint`, `make format` or
`make format-check`.

Parallel sessions coordinate through the same directory — CPU lock, shared test database and a
message bus. See [`parallel-sessions.md`](parallel-sessions.md) before running a heavy gate while
another session is active.

### Starting dev servers with logging

```bash
# All components (proxy + control plane + dashboard + BFF) with file logging
npm run dev:logged

# All components without file logging (terminal only)
npm run dev

# Individual components with file logging
npm run dev:logged -w @sardeenz/control-plane
npm run dev:logged -w @sardeenz/dashboard
npm run dev:server:logged -w @sardeenz/dashboard
```

Each logged variant uses `tee` to write to both the terminal and a log file:

| Component     | Log file                    |
| ------------- | --------------------------- |
| Proxy         | `logs/proxy.log`            |
| Control plane | `logs/control-plane.log`    |
| Dashboard     | `logs/dashboard.log`        |
| BFF server    | `logs/dashboard-server.log` |

The proxy requires Rust/cargo — if not installed, it prints a warning and is skipped (the TypeScript components still start).

### Reading and clearing logs

```bash
npm run logs:proxy       # tail -f proxy logs
npm run logs:cp          # tail -f control-plane logs
npm run logs:dashboard   # tail -f dashboard logs
npm run logs:bff         # tail -f BFF server logs
npm run logs:all         # tail -f all log files
npm run logs:clear       # remove all log files
```

## Branching Strategy

The project uses `dev` as the integration branch and `main` as the release branch.

```
main ← stable releases only (PR from dev)
 └── dev ← active development (PR target for features and fixes)
      ├── feature/phase2-wake-orchestration
      ├── feature/dashboard-model-list
      └── fix/parking-timeout-race
```

**Rules:**

- **`main`** — always releasable. Only updated via PR from `dev`.
- **`dev`** — integration branch for all new work. Create feature and fix branches from `dev`, then PR back to `dev`.
- **Feature branches** — one per phase, feature, or fix. Branch from `dev`, PR to `dev`. Use prefixes: `feature/`, `fix/`, `chore/`.
- **Releases** — when `dev` is stable and tested, PR from `dev` to `main`. The merge to `main` marks a release.

**Workflow:**

```bash
# Start new work
git checkout dev
git pull origin dev
git checkout -b feature/my-feature

# ... develop, commit, push ...

# PR to dev (not main)
gh pr create --base dev

# After features accumulate on dev, release to main
gh pr create --base main --head dev
```

## Tooling Overview

| Tool               | Purpose                             | Config file                       |
| ------------------ | ----------------------------------- | --------------------------------- |
| TypeScript 5.x     | Type checking                       | `tsconfig.base.json`              |
| ESLint 9           | Linting (flat config)               | `eslint.config.js`                |
| Prettier           | Code formatting                     | `.prettierrc.json`                |
| Vitest             | Testing                             | `vitest.config.ts`                |
| Redocly            | OpenAPI spec validation             | `packages/contracts/redocly.yaml` |
| openapi-typescript | Generate TS types from specs        | —                                 |
| Cargo / clippy     | Rust build and linting              | `proxy/Cargo.toml`                |
| Docker Buildx      | CI service-image health smoke tests | `.github/workflows/ci.yml`        |
| gitleaks           | Secret scanning (blocking PR gate)  | `.gitleaks.toml`                  |
| cargo-audit        | Rust advisory sweep (nightly)       | `proxy/Cargo.lock`                |
| pip-audit          | Python advisory sweep (nightly)     | `runners/ci-constraints.txt`      |

## Versioning

The project uses a single version in the root `package.json`. Sub-packages are all `private: true` and do not carry their own version fields.

## IDE Configuration

The repo includes `.editorconfig` for baseline formatting. Most editors respect this automatically.

For VS Code (if not using ccbox), recommended extensions:

- ESLint
- Prettier
- rust-analyzer
- EditorConfig for VS Code
