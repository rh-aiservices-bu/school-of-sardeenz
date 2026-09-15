# ADR-020: Configuration Name vs. Served Model Name

## Status

Accepted. Implementation tracked in
[#154](https://github.com/rh-aiservices-bu/school-of-sardeenz/issues/154). Additive within
[ADR-005](adr-005-openapi-contracts.md) (optional fields in `control-plane.yaml` /
`worker-agent.yaml`; the Rust-mirrored `proxy-control-plane.yaml` is unchanged). Refines the
vocabulary of [ADR-019](adr-019-logical-model-vs-instance-split.md): what ADR-019 calls the
"logical model" is a **model configuration**, and its name is the configuration name. Amended by
[ADR-021](adr-021-protocol-family-path-prefixes.md), which adds protocol-family path prefixes and a
`protocol` field to `proxy-control-plane.yaml`; the "proxy untouched" consequence below is
historical to this ADR's own change.

## Context

A single string, `modelName`, currently serves three roles at once:

1. **Configuration identity** — Postgres `models.name UNIQUE`, the `/api/v1/models/{modelName}`
   path parameter, and a Redis lifecycle-key segment (`{prefix}:models:{modelName}:{instanceId}`).
2. **Client-facing routing key** — the proxy matches the `model` field of incoming OpenAI requests
   exactly against it (`proxy/src/routing/resolver.rs`), and the request body is forwarded to the
   engine verbatim.
3. **Engine-reported identity** — the launcher pins `--served-model-name <modelName>`
   (`runners/dev-worker/src/apptainer-launcher.ts`) so the engine registers under the routing name
   and forwarded requests don't 404 inside vLLM. The flag is reserved: users cannot set it via
   `engineArgs`.

The _weights_ reference is already a separate field — `modelPath`, which becomes vLLM's positional
`--model` argument — so model identity vs. weights location is not the problem.

The problem appears when the same underlying model is served under several configurations (A/B
testing engine args, canarying a new `runtimeModule`). The operator must give each configuration a
distinct name (`llama-fast`, `llama-quality`), and because role 3 is hardwired to role 1, the
engine then identifies as that configuration alias — in its Prometheus `model_name` metric tag and
in the `model` field of its responses — rather than as the actual model
(`meta-llama/Llama-3.1-8B-Instruct`). The v1 platform had this split (`config_id` +
`served_model_name` + `model_path` in the v1 API); v2 collapsed the first two into `modelName`.

Two constraints shape the solution:

- Whatever the client puts in `model` is both the proxy's routing key and what the engine sees —
  the proxy does not rewrite bodies. Any name the engine reports must not break that path.
- vLLM's `--served-model-name` accepts **multiple** names: the server answers to any of them, and
  the **first** is used in the response `model` field and the Prometheus `model_name` tag (vLLM
  engine-args documentation; verified against the docs for the current stable release, re-verify
  against the pinned runner version at implementation time).

## Decision

Split the vocabulary into explicit concepts, adding two optional fields:

- **Configuration name** — today's `modelName`, unchanged in every wire role: unique key in
  Postgres, URL path parameter, Redis key segment, routing-map key, the string clients send in the
  OpenAI `model` field. The wire/schema name stays `modelName`; the _concept_ is renamed to "model
  configuration" in dashboard copy and documentation only.
- **Served model name** — new optional `servedModelName` on the model configuration
  (`ModelDeploymentRequest` / `ModelDetail` in `control-plane.yaml`, passed through
  `StartRunnerRequest` in `worker-agent.yaml`, nullable `served_model_name` column on `models`).
  The identity the engine reports. Defaults to the configuration name (current behavior,
  byte-identical launcher argv when unset).
- **Model path** — existing `modelPath`, the weights reference. Unchanged.
- **Display name** — new optional `displayName` on the model configuration
  (`ModelDeploymentRequest` / `ModelInfo` / `ModelDetail` in `control-plane.yaml`, nullable
  `display_name` column). A free-form human label ("Qwen test 1"), 1–200 trimmed characters when
  present, no pattern constraint (unlike the other names it never reaches argv). Purely
  presentational: dashboard-only, not unique, never a routing key, never sent to workers/runners,
  never in Redis or the routing map. The UI falls back to the configuration name when unset.

Concretely:

1. **The launcher registers both names with the engine, served name first.** When
   `servedModelName` is set and differs from the configuration name, `buildExecPlan` emits
   `--served-model-name <servedModelName> <modelName>`. vLLM's first-name semantics make the engine
   report the served name (metrics, response `model` field) while still accepting the configuration
   name — so forwarded requests, which carry the configuration name, resolve without any proxy
   change. When unset or equal, a single name is emitted, exactly as today.
2. **`servedModelName` is not unique and not routable.** Many configurations sharing one underlying
   model is the point, so no uniqueness constraint. It never enters the routing map: clients
   address configurations by configuration name only, and the proxy's exact-match lookup is
   unchanged. Routing on a non-unique name would be ambiguous by construction.
3. **Validation reuses the configuration-name rules** (`^[A-Za-z0-9._/-]{1,200}$`), even though the
   value only ever lands in argv — one shared, already-safe alphabet is simpler to reason about
   than two. No weights-dir containment check (it is not a path). The `engineArgs` reserved-flag
   guard keeps rejecting `--served-model-name`: the flag stays platform-owned; the _field_ is the
   supported input.
4. **No API, database, or Redis renames.** `model`/`modelName` is baked into the URL surface, the
   Postgres schema, the Redis key layout, the proxy contract, and the generated types of all four
   components; a wire-level rename would be a breaking cross-component churn for purely nominal
   gain — and from a client's perspective the configuration _is_ a model (the thing named in the
   `model` field). The rename to "model configuration" is presentation-layer only: dashboard page
   copy and field labels ("Configuration name — the routing key clients send as `model`";
   "Served model name (optional) — identity the engine reports, defaults to the configuration
   name") and documentation.

## Consequences

- **The Rust proxy and `proxy-control-plane.yaml` are untouched** — the main payoff of registering
  both names engine-side instead of rewriting request bodies at the proxy. *(historical: ADR-021
  subsequently prefixes the proxy surface and adds a `protocol` routing-entry field; ADR-020's
  decision to register both names engine-side rather than rewrite request bodies is unaffected).*
- **When `servedModelName` is set, the response `model` field shows the served name**, even for a
  client that sent the configuration name (vLLM first-name semantics). Intended: responses identify
  the actual model, not the configuration alias. Documented user-facing behavior, not a bug.
- **Prometheus metrics from the engine are tagged with the served name.** Two configurations
  sharing a served name aggregate under one `model_name` tag in engine-level metrics;
  per-configuration attribution remains available via Sardeenz-level metrics keyed by configuration
  name. This aggregation is exactly what the A/B use case wants from the engine's perspective.
- **The proxy's `/v1/models` continues to list configuration names only.** The engine's own
  `/v1/models` (never client-reachable; the proxy routes by configuration name) lists both.
- **Non-vLLM runners inherit the contract field but define their own mapping.** `servedModelName`
  crosses the worker boundary as an optional generic field; the vLLM launcher's dual-name argv is
  engine-specific. Future runners (Triton, diffusion) map it to their own identity mechanism or
  ignore it; the dev-worker stub treats it as informational, like `modelPath`.
- **`displayName` is presentation-only and never leaves the control plane.** It is stored
  (nullable column), returned in list and detail responses, and rendered by the dashboard as the
  primary label with `modelName` as secondary text. It is not forwarded in `StartRunnerRequest`,
  not placed in Redis, and not routable — no worker, proxy, or `worker-agent.yaml` change. All
  operations (URLs, deletion, sorting keys) keep using `modelName`; only presentation uses the
  display name.
- **Additive contract changes** — optional fields, no breaking response-shape changes, existing
  configurations need no migration beyond the nullable columns.

## Non-goals

- **Alias routing / client-facing traffic split** — one client-facing name weighted across
  multiple _configurations_ (true blind A/B). A separate feature with its own uniqueness rules; today's
  `updateEndpointWeight` (ADR-019 point 11) splits traffic across instances of a single
  configuration only. If wanted, it builds on this split as a follow-up.
- Proxy rewriting of the request `model` field.
- Normalizing the response `model` field back to the configuration name.
- Mutating `servedModelName` on an existing configuration (configurations remain
  create/delete-only, matching every other config field).

## References

- [#154](https://github.com/rh-aiservices-bu/school-of-sardeenz/issues/154) — implementation issue
  with the full touch list and acceptance criteria.
- [ADR-005](adr-005-openapi-contracts.md) — OpenAPI contracts as source of truth.
- [ADR-019](adr-019-logical-model-vs-instance-split.md) — logical model (= configuration) vs.
  instance; this ADR names the third concept ADR-019 left implicit.
- `runners/dev-worker/src/apptainer-launcher.ts` — `buildExecPlan`, where `--served-model-name` is
  pinned today and where the dual-name argv lands.
- `proxy/src/routing/resolver.rs` — the exact-match `model`-field lookup that stays unchanged.
- vLLM engine-args documentation for `--served-model-name` multi-name semantics (first name used in
  responses and Prometheus metrics).
- Sardeenz v1 reference types (`dashboard/reference/v1/services/api.v1.ts`) — the v1
  `config_id` / `served_model_name` / `model_path` precedent.
