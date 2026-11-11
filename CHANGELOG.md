# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Security

- **Dashboard BFF: JWT library bumped to clear the 6 open Dependabot alerts on the
  transitive `fast-jwt` verifier.** `@fastify/jwt` moves from `^10.1.0` to `^10.2.7`
  (same major, explicit security floor), which lifts `fast-jwt` from the pinned 6.2.4
  to 6.3.6 — outside every vulnerable range. The alerts (Dependabot #20–#25): 1 critical
  (incomplete CVE-2026-34950 patch, non-whitespace key-prefix re-enabling HS confusion),
  3 high (raw public JWK JSON treated as HMAC secret, unsigned-JWT acceptance, silent
  claim-validator bypass on array payloads), 2 medium (`clockTolerance: Infinity`
  bypassing exp/nbf, verifier cache accepting expired JWTs without iat). The sole
  importer is `dashboard/server/plugins/auth.ts` (register opts +
  `request.jwtVerify<JwtPayload>()`; `dashboard/server/routes/auth.ts` also signs via
  `app.jwt.sign`). `@fastify/jwt` 10.2.x introduces no breaking change on that surface
  (verified against the 10.1.0/10.2.7 tarballs — the runtime deltas are stricter option
  validation and a double-callback guard, neither reachable from the plugin's usage).

- **Control plane and dashboard BFF: `undici` bumped to clear the 29 open Dependabot alerts
  on the 7.x line.** The direct `undici` dependency in both workspaces moves from `^7.10.0`
  to `^7.30.1` (same major, explicit security floor), lifting the resolved 7.27.2 to
  7.30.1 — the highest published 7.x and the only release outside every vulnerable range on
  this line (10 high, 14 medium, 5 low). 7.29.1 is not sufficient: Dependabot alert #40
  (DoS via an unhandled error on excessive content-encodings, `>= 7.18.0 < 7.30.1`) is
  first patched in 7.30.1, which also restores TLS options dropped by `Agent`'s constructor
  clone (Dependabot alert #8 class) and fixes the TLS 1.2 renegotiation DoS. Consumers are
  the control-plane SIF importer (`control-plane/src/services/sif-importer.ts`, undici
  `fetch`/`Headers`) and the dashboard BFF Prometheus client
  (`dashboard/server/clients/prometheus.ts`, an `Agent` with `connect: { ca }` injected as
  the `dispatcher` fetch option); 7.30.1 changes no runtime dependency, engine constraint
  or type declaration on either surface, so no source edits are needed. The remaining open
  `undici` Dependabot alerts apply to the dev-tooling 6.24.1 copy pinned by
  `@redocly/respect-core` and are tracked in #227.

- **Dashboard: `react-router-dom` bumped to clear the open redirect alert on the 6.x
  line.** The direct dependency moves from `^6.28.0` to `^6.30.6` (same major, explicit
  security floor), lifting the resolved 6.30.4 to 6.30.6 — the final 6.x release and the
  patched version for Dependabot alert #1 (GHSA-jjmj-jmhj-qwj2 / CVE-2026-53668,
  moderate: protocol-relative open redirect — a
  `//evil.com` target given to `<Link>`, `<Navigate>` or `useNavigate` was resolved as an
  external URL, enabling an attacker-controlled redirect; vulnerable `>= 6.30.2 <= 6.30.5`,
  fixed 6.30.6). The sole behavioral change is a `resolvePath()` hardening in
  `@remix-run/router` 1.23.4: every resolved path is now double-slash-normalized, so
  external/protocol-relative navigations are treated as in-app paths — the dashboard's
  own `Link`/`Navigate`/`useNavigate` targets are app paths, but its login redirect
  derives `state.from` from `location.pathname` (reachable with a crafted SPA-fallback
  URL pre-patch), so the hardening closes that path too; no source edits are needed. No
  public API or type changes; 6.30.5 is a broken publish (its router dependency stayed
  1.23.3) and is never resolved under this range. Two Dependabot alerts remain open on
  `react-router` itself (#92 GHSA-337j-9hxr-rhxg — constructor injection via
  `deserializeErrors()` in SSR hydration, not applicable to this BrowserRouter SPA; #93
  GHSA-wrjc-x8rr-h8h6 — open redirect via backslash in `<Link>`/`useNavigate`, residual
  but not reachable here): they are fixed only in 7.18.0, v6 is EOL, and clearing them
  requires the v7 major upgrade tracked as a separate follow-up — this bump does NOT fix
  them.

- **Dev tooling and runtime bundles: transitive dependency sweep clears 87 of the 100
  Dependabot alerts firing against the base lockfile (GitHub shows 141 open rows — 136
  npm + 5 rust — because alerts already fixed by #224/#225/#226 stay open until
  re-scan; the 5 Rust rows are untouched here).** A root
  `npm update --package-lock-only` refresh (npm workspaces, no pnpm) lifts every
  alerted dependency reachable in-range to its Dependabot fix or beyond — 13 alerts
  remain on the refreshed tree: the residuals enumerated below plus the two
  `react-router` 6.x alerts (#92/#93) carried by the #226 entry above and tracked in
  #229. The one `dompurify` copy npm update cannot reach — `monaco-editor`'s nested
  copy — is collapsed via a scoped override, and the existing root `"dotenv": "^17.0.0"`
  override (the dotenv unification override) is preserved; the combined `overrides`
  object in root `package.json` is:

  ```json
  "overrides": {
    "dotenv": "^17.0.0",
    "monaco-editor": {
      "dompurify": "3.4.17"
    }
  }
  ```

  No direct dependency range changes and no source files change.
  Per-package outcomes (locked before → after; Dependabot floor where applicable):
  `@redocly/cli` 1.34.15 → 1.34.24, `handlebars` 4.7.9 → 4.7.10 (critical alert #28),
  `js-yaml` 4.2.0 (+3×4.1.1 nested) → 4.3.2 single copy, `undici` (the
  `@redocly/respect-core` 6.x copy) 6.24.1 → 6.29.1, `undici` (direct, hoisted to root)
  7.30.1 → 7.30.2, `vite` 7.3.5 (×3: dashboard + `vitest`/`vite-node` nested) → 7.3.8
  single copy, `esbuild` 0.27.7 (+ `tsx`-nested 0.28.1) → 0.28.2 single copy,
  `postcss` 8.5.15 → 8.5.32, `browserslist` 4.28.2 → 4.29.5,
  `baseline-browser-mapping` 2.10.37 → 2.11.35, `source-map-js` 1.2.1 → 1.2.2,
  `form-data` 4.0.4 → 4.0.6, `shell-quote` 1.8.4 → 1.12.0, `fast-uri` 3.1.2 → 3.1.9 root
  copy (new 4.2.3 nested under `@fastify/ajv-compiler` / `fast-json-stringify`, outside
  every alert range), `brace-expansion` 1.1.15 → 1.1.21, 2.1.1 → 2.1.7, 5.0.6 → 5.0.12,
  `dompurify` 3.4.15 (+ `monaco-editor`'s nested 3.1.7) → 3.4.17 single copy,
  `monaco-editor` 0.54.0 → 0.56.0. Three land above the issue's stated minimum: `vite`
  7.3.8 > 7.3.7, `baseline-browser-mapping` 2.11.35 > 2.11.0, and `@redocly/cli`
  1.34.24 > 1.34.17 — 1.34.17's `@redocly/respect-core` pins `undici` exactly at
  6.27.0, still inside the 6.x vulnerable ranges; only 1.34.24 pins 6.29.1, so all 11
  undici-6.x alerts clear together with the handlebars fix (1.34.17 still pins 4.7.9).
  This closes the loop on the #225 entry, which left the 6.x `undici` copy
  "tracked in #227": the 6.x copy is now 6.29.1 and all 11 undici-6.x alerts close.
  Two side-effect clearances ride the sweep: `fastify` 5.8.5 → 5.12.8 (first patched
  5.12.5 — 7 alerts: 4 high #135–#138, 3 medium #120/#121/#139) and `find-my-way`
  9.6.0 → 9.10.0 (first patched 9.7.0 — 1 alert, #91 high), shrinking the planned
  fastify-stack follow-up (#231) to `@fastify/static` + `glob`.
  The dompurify collapse clears every open dompurify alert, including #63 (low;
  `<= 3.4.6` — GitHub shows no first-patched version on that advisory, but 3.4.17 sits
  outside its range and the alert closes on re-scan). One residual rides inside that
  outcome: `monaco-editor` 0.56.0 also vendors its own DOMPurify 3.4.8 copy inside its
  published dist (`domSanitize` imports it), so the override fixes the dependency-graph
  alert only — the vendored in-bundle copy remains inside the #36 critical / #39 high
  windows but is not demonstrably exploitable through monaco's sanitizer configuration;
  the true fix is upstream (monaco unbundling DOMPurify), documented as a residual
  below.
  Scope disclosure: `npm update --package-lock-only` refreshes the whole in-range tree
  (~313 changed lock paths), not only the alerted packages. Several majors land only
  because their pullers bumped their own dependency ranges in the same refresh —
  `fastify` 5.12.x now declares `fast-json-stringify` `^7`, `react-i18next` 17.1.13
  now declares `html-parse-stringify` `^4`, and `style-to-object` rides a puller swap
  (`style-to-js` dropped for `hast-util-to-jsx-runtime`'s new `style-to-object ^2.0.0`)
  — and npm resolves the rest in-range under the pullers' declared ranges,
  npm-canonical, exercised by the deferred host gates below: `cookie` 1.1.1 → 2.0.2 (via
  `@fastify/cookie` 11.1.5, which now declares `cookie ^2.0.0`; consumed on the BFF
  `sardeenz_sse` cookie path), `fast-json-stringify` 6.4.0 → 7.3.4 (`fastify` response
  serialization), `style-to-object` 1.0.14 → 2.0.2 (markdown rendering in the chat path
  via `react-markdown`); `html-parse-stringify` 3.0.1 → 4.0.1 (dashboard i18n —
  `react-i18next` 17.0.8 → 17.1.13 now declares `^4.0.1`; `i18next` 26.3.1 → 26.7.2
  rides along), `@patternfly/chatbot` 6.7.1 → 6.9.0
  (this is what carried `monaco-editor` 0.54.0 → 0.56.0 via its `^0.56.0` peer),
  `@patternfly/react-{core,icons,styles,table,tokens,code-editor}` 6.6.1 → 6.7.0,
  `@patternfly/react-charts` 8.5.1 → 8.7.0 (the `@patternfly/react-*` wildcard
  doesn't cover it), `victory` 37.3.6 → 37.4.1, `posthog-js` 1.433.2 → 1.447.4,
  `set-cookie-parser` 2.7.1 → 3.2.2 (via `light-my-request`, now declaring
  `^3.0.1`, under `fastify`; the dev-chain root copy 2.7.1 stays pinned exactly
  by `@redocly/respect-core` 1.34.24), `sonic-boom` 4.2.1 → 5.0.2 (dev-chain
  `pino-pretty`, now declaring `^5.0.0`; the prod `pino` keeps the root 4.2.1),
  `@fastify/static` 9.1.3 → 9.3.0 (dashboard BFF static server; runtime).
  npm's dedupe also relocated or stepped down a few packages
  (`d3-format`, `d3-time-format`, `semver`, `react-dropzone`, `mobx-react`) — each
  resolves inside every puller's declared range and reopens no advisory.
  Residuals, documented not forced: `tinypool` 1.1.1 (2 critical alerts #140/#141) and
  the `vitest` 3.2.7 / `@vitest/mocker` alerts #2/#4/#33 (all medium) ride the same
  `vitest` 4 major in #228 — the fix ≥2.1.2 sits outside `vitest` 3's declared range,
  and `vitest` 4 drops `tinypool` entirely; `glob` 13.0.6 → 13.0.7 / 10.5.0
  unchanged (alert #156, medium) unreachable this sweep — their pullers
  `test-exclude` / `@fastify/static@9` cap below `glob` 14, so the fix is upstream
  plus #231; `@faker-js/faker` 7.6.0 (alert #119, high; fix ≥10.5.0 — deferred: only
  reachable via a 7→10 major-crossing override, confined to the dev chain's
  `redocly contract` fake-telemetry generation);
  `@fastify/static` 9.3.0 (alerts #46/#95, high; #47/#96, medium; fix ≥10.1.10 — the
  first-patched floor for these four is 10.1.2, but ≥10.1.10 also carries `glob` 14 and
  so closes #156, matching the #231 follow-up, a step this sweep has already shrunk: its
  `fastify` and `find-my-way` rows clear here); `monaco-editor` 0.56.0's vendored
  DOMPurify 3.4.8 (see above — the in-bundle copy inside the #36 critical / #39 high
  windows; this is a residual risk, not one of the 13; fix is upstream).
  `@redocly/cli` 1.34.24 is the terminal v1 release (`v1-archive`); the redocly v2 major
  migration is future work. Runtime verification (npm ci → dashboard client build →
  control-plane/dashboard/dev-worker suites → e2e → typecheck → scoped eslint → `npm ls`
  / `npm audit`) runs on the host by the user; nothing was executed in-container beyond
  the lockfile refresh and static assertions.

- **Dev tooling: vitest major bump clears the vitest, @vitest/mocker and tinypool
  alerts.** The root devDependencies `vitest` and `@vitest/coverage-v8` move from `^3.2.1`
  to `^4.1.12` in lockstep (`@vitest/coverage-v8@4.1.12` declares an exact `vitest: 4.1.12`
  peer, so the two cannot be bumped independently). This clears Dependabot alert #2
  (`@vitest/mocker` ≥2.1.0 <4.1.11), #4 (vitest, same range) and #33 (`@vitest/mocker`
  ≥2.1.0-beta.7 <4.1.12) via version, plus the two tinypool criticals #140/#141
  structurally: vitest 4 removed the tinypool-based worker pool, the new lock contains
  zero tinypool entries, and nothing in the tree depends on tinypool anymore.
  `@vitest/mocker` 4.1.12 no longer carries the vulnerable path (its dependencies are only
  `@vitest/spy`, `estree-walker`, `magic-string`). The lockfile change is bump-specific and
  its command must run under npm 11 (`npx -y npm@11 install --package-lock-only`; 11.21.2
  validated): npm 10.9.9 crashes in arborist strict mode on this exact resolution ("Cannot
  read properties of null (reading 'edgesOut')" in `#loadPeerSet`) — the crash is not
  caused by the repo's overrides block and is not expected to affect `npm ci`, but CI's
  npm 10 runs the first real execution of the new lock. A `--legacy-peer-deps` fallback
  was validated broken (silently drops required peers `@testing-library/dom` and
  `monaco-editor`, breaking the `monaco-editor.dompurify` override target, and jumps vite
  to 8.3.7 with a rolldown swap). Collateral, disclosed: `chai` 5.3.3 → 6.3.0 rides the
  bump as vitest's internal expect stack (the repo imports no chai directly); `vite` stays
  7.3.8 as a single copy (vitest 4.1.12's peer range `^6 || ^7 || ^8` keeps the existing
  hoisted 7.3.8); 23 top-level packages (37 lock entries) leave the lock — `tinypool`,
  `tinyspy`, `vite-node`, `test-exclude` and the vitest 3 pool/CLI chain, plus the
  istanbul/remapping coverage chain and the chai 5 support tree — replaced by `obug@2.2.1`
  and `@standard-schema/spec@1.1.0` (a new `@vitest/expect@4.1.12` dependency), with
  further version moves on the vitest chain (`ast-v8-to-istanbul` 0.3.12→1.0.8,
  `es-module-lexer` 1.7.0→2.3.2, `magicast` 0.3.5→0.5.5, `std-env` 3.10.0→4.3.0, `tinyexec`
  0.3.2→1.3.1, `tinyrainbow` 2.0.0→3.2.0). The lockfile shrinks 973 → 938 entries. One
  behavioral hardening rides along: vitest 4's default test excludes shrink to
  `node_modules` and `.git`, no longer skipping `dist/` — and CI runs `tsc --build` (which
  emits compiled `__tests__/*.test.js` into each composite project's `dist/`) before
  `make test`. The control-plane and dev-worker vitest configs gain an explicit
  `**/dist/**` exclusion so compiled copies of their test files are never discovered; a
  project-level exclusion is the effective mechanism because the root config's
  `test.exclude` is not merged into project configs when `test.projects` is set (root
  options only drive global behavior). The dashboard config already excluded `dist/**`
  explicitly and is unchanged; the control-plane integration config's src-scoped `include`
  glob cannot match dist. Residual: vitest 5.1.0 is the latest line (engines
  `^22.12 || ^24 || >=26` and vite ≥6.4.0 — both satisfied here) but is deliberately out
  of scope for this dev-chain-only bump; 4.1.12 is the terminal 4.1.x release and clears
  every open alert on the 3.x line. First real execution under vitest 4 (CI run 42711031269)
  surfaced three classes of runtime fallout, all fixed in test code only — no dependency or
  runtime-source changes: (1) `tsc --build` fails on 6 test files: `ReturnType<typeof vi.fn>`
  now resolves to `Mock<Procedure | Constructable>` (constraint instantiation; the untyped
  `vi.fn()` mock is neither callable as a concrete signature nor assignable to one), so the
  121 mock-type annotations across internal/model-logs/models/deploy-orchestration/
  reconciliation tests now use vitest's exported bare `Mock` type (= `Mock<Procedure>`, the
  exact v3 semantics) with `import type { Mock } from 'vitest'`; (2) `vi.restoreAllMocks()`
  no longer resets plain `vi.fn()` mocks (jest-aligned — it only restores spies), so the
  module-level `mockFetch` in worker.test.ts accumulates call history across tests and
  `mock.calls[0]` assertions read a previous test's request — fixed with an explicit
  `mockFetch.mockReset()` in `beforeEach`; (3) spy implementations are invoked via
  `Reflect.construct` when the spied site calls `new` (jest-aligned), so the
  `vi.spyOn(global, 'Date').mockImplementation(() => mockDate)` arrow replacement in
  notification.test.ts throws "not a constructor" on `new Date()` — replaced with
  `vi.useFakeTimers({ now })` (+ `vi.useRealTimers()` teardown), which also survives
  mid-test failure without leaking the mock into subsequent tests. A second CI wave (run
  43060242462 on the fix commit) surfaced a fourth: the type-aware eslint config flags
  `ReturnType<typeof vi.spyOn>` as `any` under v4 (same constraint-instantiation — v4's
  `spyOn` is generic over the spied property, so the resolved type is not the specific
  `MockInstance`), making `warnSpy.mockRestore()` an unsafe `any` call in memory-budget
  and worker-pool tests; those five declarations are now typed
  `MockInstance<(...args: unknown[]) => void>` with `import type { MockInstance } from
  'vitest'`. Verified in-container by
  staging the vitest 4.1.12 type/runtime closure from registry tarballs (no npm tree
  operations): `npx tsc --build` clean for all affected suites, scoped eslint clean, and
  the full `npx vitest run` at 98/98 files, 1502 passed + 1 skipped. The host gates remain
  the authority for `npm ci`-materialized trees (`npm ci`, integration suite,
  `npm ls vitest`, `npm audit`).

### Changed

- **Agent config triaged and adapted from another project.** The `.omp/` agents, skills and
  pre-tool safety hook imported from the agents-jukebox project kept their orchestration method
  (Direct/Light/Full pipelines, role agents, report-scratchpad custody) but every
  repository-specific reference was rewritten for sardeenz: role models resolve through
  `modelRoles` aliases (`plan`/`slow`) instead of nonexistent explicit IDs, npm instead of pnpm,
  Kustomize instead of Helm (helm block rule dropped from the safety hook), JWT auth on
  `dashboard/server/plugins/auth.ts` instead of Keycloak, Playwright e2e specs in
  `dashboard/e2e/` instead of `dev-tools/e2e-scenarios/`, and `.omp/RULES.md` pointing at
  `docs/development/setup.md`. The boundary reviewer and `domain-rules`/`test-ui`/`verify`
  skills were rewritten wholesale (OpenAPI contract drift, proxy↔control-plane↔BFF shapes,
  DB migrations, runner contract); the duplicate `work-item-template.md` under
  `plan-milestone/references/` was deleted in favour of the `implement/` copy. The previously
  missing `docs/development/agent-profile.md` (required by the milestone skills) was created
  from the shipped template. `.gitignore` gains the `.omp/` scratchpad paths
  (`reports/`, `plans/`, `worktrees/`, `profiles`).

### Added

- **vLLM 0.26 runner image (`containers/runners/vllm/0.26.0/`).** A second current vLLM line,
  built from `quay.io/vllm/vllm-cuda:0.26.0_rhaiv.9` pinned to the OCI index digest
  `sha256:a16d7271…` (amd64 runtime plus attestation, as with 0.24), with Python 3.12, CUDA
  toolkit 13.0.2 and torch 2.11.0+cu130. kvcached is pinned to v0.1.6 (`2235a9ec…`), the first
  release that supports vLLM 0.26 and later. This base no longer ships kvcached's `posix_ipc` and
  `wrapt` dependencies (the 0.24 base did), so the builder also emits their wheels
  (`posix_ipc 1.3.2`, `wrapt 2.4.0`) and the runtime stage keeps installing `--no-index` from
  `/wheels`. Build-time assertions cover `cuda-toolkit 13.0.2`, vLLM `0.26.0`, torch's CUDA 13.0
  build, the compiler/Ninja toolchain and `Python.h`; the driver-stub RPM pin is unchanged
  (`cuda-driver-devel-13-0-13.0.96-1`). `VLLM_USE_V2_MODEL_RUNNER=0` is baked into the SIF, and the
  worker now forces Model Runner V1 for every kvcached module in the 0.24+ range (`vllm-0.24`,
  `vllm-0.26`) because kvcached only patches Model Runner V2 from vLLM 0.28. The catalog entry is
  pinned to the published `vllm:0.26-rc1` SIF (`sha256:075b3057…`).

- **MLServer runner: ONNX models.** The MLServer 1.7.1 image now installs
  `onnxruntime-gpu[cuda,cudnn]==1.26.0` (last PyPI build for CUDA 12) and the shim ships its own
  MLServer runtime, `sardeenz_mlserver_runner.onnx_runtime.ONNXRuntimeModel`, since Seldon
  publishes no `mlserver-onnx`. A model directory holding a `*.onnx` export (and no sklearn or
  Hugging Face markers) is auto-detected; explicit `model-settings.json` can pin the artifact,
  execution providers (`parameters.extra.providers`, CUDA preferred with CPU fallback), provider
  options and session options. Tensors map to KServe V2 inputs/outputs by name; structured
  outputs (e.g. ZipMap classifier probabilities) come back as `BYTES` JSON. The `mlserver-1.7.1`
  catalog entry gains the `onnx` tag and is pinned to the rebuilt `mlserver:1.7.1-rc4` SIF
  (`sha256:c9c6f049…`), the first published build with the runtime, the #206 drain fix and the
  CUDA-library fix below.
  The runtime now checks the session's active providers after load: an explicit
  `parameters.extra.providers` list that onnxruntime could not initialise fails the load, and
  the default CUDA-then-CPU preference logs a `falling back to` warning instead of serving
  silently on CPU.

### Fixed

- **Dashboard: models placement — single model list per GPU card.** The card previously
  listed every model twice: once as the legend chips under the stacked bar, again as the
  per-model action rows. The legend chips row is removed; the action-row list is the single
  list and renders for every user (the sleep/wake/move/stop dropdown is admin-only). "Other"
  and "Free" ride at the bottom of that list as legend rows without a kebab, styled like the
  model rows. The now-unused `legend.segments`/`legend.viewModel` i18n keys are dropped.

- **MLServer SIF: ONNX models silently ran on CPU.** The `1.7.1-rc3` image installed the
  `nvidia-*-cu12` wheels for `onnxruntime-gpu`, but RHEL-family Python places those pure wheels
  under `/usr/local/lib/...` while `onnxruntime-gpu` sits under `/usr/local/lib64/...`, so
  `onnxruntime.preload_dlls` never found `libcudnn.so.9` and the CUDA provider degraded to CPU
  (0 B measured VRAM). The Containerfile now puts the cu12 `lib/` directories on
  `LD_LIBRARY_PATH`, `dlopen()`s every CUDA/cuDNN library at build time (the previous
  `preload_dlls` check only printed), and pins `torch==2.10.0` — the last CUDA 12 torch — since an
  unpinned torch pulled `nvidia-cudnn-cu13`, whose files clobber the cu12 cuDNN. Verified
  on-cluster: an ONNX model now loads with `CUDAExecutionProvider` and reports measured VRAM.
- **Dashboard: Models placement panel redesigned (#163 round two).** Worker cards now sit side
  by side in a responsive grid instead of one full-width collapsible section per worker — with
  one GPU per worker, the old layout left most of each row empty. The per-card model legend
  collapses into hover tooltips and model rows become one-line chips, cutting ~80px per card.
  A header toggle switches between the card view (default) and a compact one-row-per-worker
  view (~48px/worker, aggregate sleep-all/wake-all/stop-all kebab); the choice persists in
  localStorage. Models sort by measured size, largest first.
- **Dashboard: Models placement tooltips — model name only, no instance id (#206).** The card
  view's stacked bar now uses a custom tooltip that strips the `#instanceId` suffix from the
  nivo segment key, so hovering a colored segment shows the model name and measured bytes only.
  The compact view's inline bar gains the same hover tooltip as the cards: every model with its
  color, sleeping moon and bytes, plus Other/Free when present. Compact segments carry the
  served display name (`WorkerModelInfo.displayName`) instead of the raw model key.
- **CI: PRs run quality gates only; merges to dev publish impacted images.** PR CI
  (`ci.yml`) now runs typecheck/lint/tests/e2e without building container images. A new
  `publish-images.yml` runs on every merge to `dev`: it maps the merge's changed paths to the
  platform images they impact (`proxy/` → proxy; `control-plane/`, `dashboard/`, and their
  container dirs → their images; `packages/**` and root manifests → both service images;
  `containers/worker-base|worker/` → the digest-paired worker images), builds only those,
  tags them with the merge commit's short sha (`git log --oneline` form), and pushes to
  `quay.io/rh-aiservices-bu`. Worker always builds FROM the worker-base digest built in the
  same run (or the last published one for worker-only changes). Docs/CI-only merges publish
  nothing. The manual multi-image `publish-platform-images.yml` stays for explicit republishes.
  Fix: the first `publish-images.yml` runs failed at validation because `jobs.<job_id>.if`
  cannot reference the `matrix` context (github, needs, vars, inputs only); the build decision
  now gates each step's `if`, where `matrix` IS available.
- **MLServer runner draining stalls (#206):** the MLServer shim omitted `activeRequests` from
  `/health`, so the control plane's drain loop could never observe drain completion and every
  stop/sleep of an MLServer model burned the full sleep timeout (300s default) before timing out.
  The shim now scrapes MLServer's metrics listener for the REST server's
  `rest_server_requests_in_progress` gauge and reports it as `activeRequests` (unknown/omitted
  only when the scrape fails, never a fake 0), matching the vLLM shim's behavior.

### Fixed

- **Models placement legend tooltip (cards view).** Hovering the model legend showed the raw
  i18n key `overview.modelsPlacement.legend.segments` as its title: `cluster.json` carried two
  duplicate `"legend"` blocks and JSON parsing keeps the last duplicate, which lacked the
  `"segments"` entry. The duplicate block is removed (the survivor keeps all keys). The tooltip
  is also anchored per legend chip now — one Tooltip per chip/Other/Free entry — so the full
  VRAM breakdown appears right above the hovered chip, matching the stacked-bar tooltip
  behavior, instead of top-center of the legend row.

## [0.2.0] - 2026-09-15

First release of Sardeenz v2, the production-grade successor to the
[v1 prototype](https://github.com/rh-aiservices-bu/sardeenz). This section summarizes what the
platform delivers as of this release; the per-change history that accumulated during
development (Phases 0-4 and milestones M1-M14) is preserved in the git history of this file.

### Platform

- **Four decoupled components talking only through OpenAPI contracts** (ADR-002, ADR-005):
  a Rust routing proxy, a TypeScript control plane (Fastify, PostgreSQL, Redis/Valkey), a React +
  PatternFly 6 admin dashboard with a Fastify BFF, and engine runners. TypeScript types are
  generated from the specs in `packages/contracts/`; Rust types are hand-maintained.
- **Application-layer VRAM multiplexing.** Models are logical configurations with one or more
  instances (ADR-019); the control plane places them on workers and GPUs, sleeps idle models,
  wakes them on demand, and evicts to make room. Configuration name, served model name, and
  display name are distinct (ADR-020).
- **Measured-only GPU memory doctrine.** Every memory figure shown to users comes from NVML
  telemetry; `requiredMemory` is a placement input, never a user-facing "reserved" figure.
  kvcached pool statistics (prealloc / used / free) are reported end to end.

### Routing proxy

- OpenAI-compatible and Open Inference Protocol traffic on separate path families (`/openai`,
  `/oip`, ADR-021), weighted round-robin across instances with per-endpoint circuit breakers.
- **Wake-on-request parking.** Requests for a sleeping model are parked, a wake is triggered, and
  the request is forwarded once the model is ready; parked herds fail fast on wake rollback and
  never suppress the next wake trigger.
- Live routing map from Redis pub/sub with reconnect and backoff; request-ID tracing; hop-by-hop
  header filtering; configurable body cap, parking byte budget, forwarding concurrency limits, and
  upstream timeout.
- Prometheus metrics on a separate admin port: request counts and latency histograms, active and
  parked connections, parking duration, wake triggers, circuit-breaker state.

### Control plane

- Model lifecycle API: deploy, sleep, wake, stop, start, delete, and force-delete for stalled
  configurations; in-progress deployments can be cancelled; stopped configurations can be
  modified in place.
- **Resumable move-model operation** across workers and GPUs with weight-zero cutover, resumed
  after leader changes.
- Placement pipeline with capability filtering, VRAM budgeting with in-flight reservations, LRU
  eviction wired into deploy and wake, and a reconciliation loop that repairs ghost instances after
  worker restarts.
- Kubernetes Lease-based leader election; atomic Redis state transitions via Lua scripts;
  PostgreSQL migrations at startup.
- Durable, instance-scoped startup logs replayable from the dashboard.
- Runner catalog: digest-pinned ORAS imports of official runner SIFs with byte-accurate
  verification, digest-drift detection, and optional Apptainer signature checks.
- Server-sent events for model, worker, and memory changes; Prometheus metrics for models,
  workers, device memory, state transitions, evictions, and operation durations.

### Admin dashboard

- Cluster overview with a GPU placement board, per-GPU stacked per-model VRAM bars, and the
  cluster inference URL; model list with sorting, multi-instance worker links, and runner
  identification; model detail with startup-log replay; worker pages.
- Deploy form driven by live worker capabilities, with runtime-module (SIF) selection and a
  weights folder picker; compact per-model action menus (sleep, wake, move, stop) on GPU cards.
- **Chatbot Playground** built on `@patternfly/chatbot`: model sidebar grouped by GPU, session
  tabs, single / split / 2x2 layouts, streaming and non-streaming turns, latency / TTFT / tok/s
  per reply, persisted layout and sessions, and a per-user inference concurrency cap.
- **Metrics page** backed by Prometheus: request latency and throughput, active and parked
  connections, parking duration, wake triggers, state transitions, evictions, memory over time,
  and average operation durations, with preset and custom time ranges and auto-refresh. Works
  against OpenShift user-workload monitoring out of the box (Thanos Querier tenancy port with
  ServiceAccount token, service CA, and namespace tenancy).
- Notification drawer fed by SSE with degraded polling fallback; Redis fallback for all read
  routes when the control plane is unavailable.
- Authentication modes `none`, `simple`, and OpenShift OAuth with namespace-scoped
  `sardeenz-admin` / `sardeenz-admin-readonly` marker Roles; read-only users get a read-only UI.
- Accessibility audit fixes, i18n infrastructure, and a Playwright e2e suite against mock
  services, enforced in CI.

### Engine runners

- **Apptainer SIF runtime** (ADR-015 to ADR-018): engine images are converted to SIF files on a
  shared volume and executed by a slim worker image; official SIFs are distributed via ORAS from
  the `runners.yaml` catalog.
- Worker agent with NVML GPU detection, per-runner port blocks, runner lifecycle management with
  log streaming, multiple runner families per worker, and heartbeat memory reports.
- **vLLM runner shim** (vLLM 0.21 and 0.24 images, kvcached-enabled) and **MLServer runner
  shim** (MLServer 1.7.1) implementing the engine-runner contract: health, memory report, sleep
  and wake, and engine-parameter passthrough. A shared conformance suite runs against both.
- Runner container definitions organized by engine and exact upstream version under
  `containers/runners/<engine>/<version>/`.

### Deployment and operations

- Kustomize bases for the control plane, proxy, dashboard, worker (SCC, RBAC, PVCs, NetworkPolicy,
  PVC write protection), PoC PostgreSQL and Valkey backing services, OpenShift monitoring
  (ServiceMonitors, service-CA ConfigMap, metrics-reader Role), and a parameterized Librarian Job
  that builds, converts, and publishes runner SIFs on OpenShift.
- Canonical Quay repository layout and a manual GitHub workflow that builds and pushes all
  platform images.
- Defense in depth: bearer-token authentication on the control plane and worker agent, allow-list
  NetworkPolicies per flow, restrictive BFF security headers, proxy-aware rate limiting, SIF
  supply-chain checks, and secrets sourced from environment variables (ADR-013). Operator guides
  cover deployment security, OpenShift OAuth RBAC, MLServer model layouts, and the runner catalog.

### Development

- npm workspaces monorepo with a Makefile front door; `make lint typecheck test` gate; Podman
  Compose dev services; logged dev servers; integration tests on a dedicated `_test` database.
- CI: quality (lint, typecheck, unit and integration tests), dashboard e2e, Python runner and
  conformance suites, and service container build and smoke tests on every pull request.
- Architecture overview, 21 ADRs, per-component specs, and per-component `AGENTS.md` guides for
  AI-assisted development.
- Published documentation site (mkdocs-material, GitHub Pages) built from `docs/` by a
  `deploy-docs` workflow. Application docs only: project planning and ADRs stay in the repo, and
  links to them or to source files are rewritten to GitHub URLs at build time so
  `mkdocs build --strict` validates in-site links. Includes an interactive Architecture Flow
  Visualizer (`docs/architecture-visualizer.html`) animating eight flows: cluster bootstrap, model
  deployment, inference hot path, park-and-wake, LRU eviction, instance move, control plane
  failover, and runner catalog import.

### Notable fixes folded into this release

Development surfaced and fixed a long tail of correctness issues before release, including:
runner processes not terminated on delete, stop, or eviction; VRAM reservations cleared
prematurely or leaked; move and delete races; parked-connection and circuit-breaker leaks in the
proxy; routing entries corrupted on sleep; integration tests wiping the dev database; MLServer
failing on read-only images; OAuth identity and RBAC lookups on OpenShift; and proxy histograms
rendered as summaries, which left latency panels empty; sidebar GitHub star and fork counts
blocked by the Content Security Policy in production (now proxied through a cached BFF route);
and a flaky dashboard e2e accessibility test whose readiness check matched both the sidebar nav
link and the Workers summary card.
