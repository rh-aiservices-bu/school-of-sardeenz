# ADR-024: Worker Entrypoint Allowlist Seeds from the Configured Argv

## Status

Accepted. Implemented in M15 ([#238](https://github.com/rh-aiservices-bu/school-of-sardeenz/issues/238),
merged `46f204d`; design option B per the 2026-11-11 decision comment). The worker-agent
contract ([`packages/contracts/specs/worker-agent.yaml`](../../packages/contracts/specs/worker-agent.yaml))
records the constraint descriptively (version 0.1.3).

## Context

`POST /runners` executed a caller-supplied `entrypoint` argv verbatim under `apptainer exec`
inside the SIF. The worker API's `SARDEENZ_WORKER_TOKEN` plus the NetworkPolicy limiting ingress
to the control plane were the only boundary; the whole guarantee rested on the control plane never
forwarding user-controlled input into that field. M15 goal 3 ("request surfaces validate their
inputs before they reach Redis or argv") names this surface, and defense-in-depth requires the
worker to enforce it at its own edge.

## Decision

1. **Allowlist seeded from configuration, never from an assumed shape.** The allowlist is built
   once at startup from the worker's configured `SARDEENZ_RUNNER_ENTRYPOINT`. Accepted argv:
   - absent or empty → accepted (the launcher falls back to the configured vector);
   - the configured vector **verbatim** → accepted (covers non-`-m` operator overrides such as
     `["python3","sardeenz_vllm_runner.py"]`);
   - **only when** the configured vector has the canonical 3-token `<exec> -m <module>` shape →
     `<exec> -m <m>` with the same `exec0` and `m` ∈ {`sardeenz_vllm_runner`,
     `sardeenz_mlserver_runner` (the catalog's shims), the configured module}.
2. **Rejection is a 400 at the route boundary**, with the route's existing
   `{ error, code: 'BAD_REQUEST' }` shape, before any process is spawned; the rejected argv is
   logged with `JSON.stringify` (no log forging).
3. **An unusable configured vector fails worker startup loudly**, naming
   `SARDEENZ_RUNNER_ENTRYPOINT`, instead of turning every start request into a 400. The check
   lives with config load and applies in every launch mode.
4. **The catalog stays the source of truth.** The control plane continues to source `entrypoint`
   from catalog metadata and forward it through the deploy path; the contract field, its type and
   its optionality are unchanged (description-level constraint only).

## Consequences

- The "verbatim exec of arbitrary argv" gap closes while preserving catalog authority and the
  current release cadence: adding a catalog engine whose shim argv matches one of the admitted
  modules needs no worker change.
- **Traps with real cost.** Assuming `python3 -m` unconditionally breaks operator overrides;
  widening the match to prefixes or extra flags re-opens argv injection through trailing
  arguments; adding a genuinely new shim module requires adding it to `KNOWN_SHIM_MODULES` (a
  worker release, not config); and a non-`-m` configured override silently disables the `-m`
  family, so an operator running both vLLM and MLServer catalog entries must keep a `-m` vector
  (the shipped default). Entrypoint-less catalog entries inherit the configured default.
- The launcher and `RunnerManager` keep their contract; validation is threaded explicitly through
  `createServer` → `registerRunnerRoutes` (compile-enforced, no manager getter).
- **Rejected alternatives.** Option A (worker resolves argv from `runnerType`, ignores the body
  field) duplicates catalog knowledge into the worker and couples every new engine to a worker
  release; option C (exact-argv allowlist against catalog values) breaks whenever the catalog
  bumps a shim's argv for the same runner type.

## Non-goals

- Sanitizing or shell-quoting argv — this is allowlisting, not sanitization; the argv is never
  shell-interpreted.
- Restricting the non-`entrypoint` fields of `POST /runners` (model path, engine args) — separate
  surfaces.
