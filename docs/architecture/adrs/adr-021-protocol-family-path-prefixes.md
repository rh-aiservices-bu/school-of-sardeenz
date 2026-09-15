# ADR-021: Protocol-Family Path Prefixes for Multi-Protocol Runners

## Status

Accepted. Implementation tracked in
[#125](https://github.com/rh-aiservices-bu/school-of-sardeenz/issues/125). Additive within
[ADR-005](adr-005-openapi-contracts.md) (a `Protocol` enum + required `protocol` field on
`RoutingEntry` in the Rust-mirrored `proxy-control-plane.yaml`; a required `protocol` + optional
`entrypoint` on `CatalogEntry` in `control-plane.yaml`). Amends
[ADR-020](adr-020-config-name-vs-served-model-name.md)'s "the Rust proxy and
`proxy-control-plane.yaml` are untouched" consequence (see Consequences). Builds on
[ADR-010](adr-010-engine-runners.md) (engine runners) and
[ADR-019](adr-019-logical-model-vs-instance-split.md) (logical model vs. instance).

## Context

Until now, one string surface (`/v1/*`) served only OpenAI-compatible runners. MLServer speaks
KServe V2 (the Open Inference Protocol, OIP: `POST /v2/models/{model}/infer`, with the model name
in the URL path, not the request body). `RoutingEntry` carried no protocol tag, and
`RoutingEntryMetadata.engineType` was declared in the spec but never populated (dead field). The
proxy could not tell which models are V2-invocable and which are OpenAI-invocable — both listings
would advertise models their surface cannot actually invoke.

## Decision

1. **Protocol-family path prefixes on one host.** `/openai/…` (OpenAI-compatible surface) and
   `/oip/…` (KServe V2 OIP surface). Prefixes name the **protocol family, never the engine**. Full
   surface: `POST /openai/v1/chat/completions`, `POST /openai/v1/completions`,
   `GET /openai/v1/models`, `POST /oip/v2/models/{model}/infer`,
   `GET /oip/v2/models/{model}/ready`, `GET /oip/v2/models`. The prefix is stripped before
   forwarding, so runners always receive canonical `/v1/*` or `/v2/*` paths.
2. **No unprefixed aliases.** Bare `/v1/*` is removed in the same change, with no deprecation
   period (pre-release). The dashboard inference-URL banner shows both protocol-labeled base URLs.
3. **First-class routing-entry `protocol` tag.** Required, non-`Option` on the Rust mirror (an
   absent tag must not be representable); both listings filter on it. The dead `engineType` field
   is deleted in the same change.
4. **Data-driven activation.** The proxy compiles in its protocol adapters and always mounts every
   prefix; which models appear under which prefix is driven entirely by the per-entry `protocol`
   tag written by the control plane. Importing and deploying a runner lights up its surface live —
   no proxy restart or config edit.
5. **Forward-compat guard.** The proxy advertises its supported protocol set at the
   `{prefix}:proxy:protocols` Redis key (written on every reconnect). Catalog import of a runner
   whose `protocol` the running proxy does not advertise **fails fast at import time** (409,
   "proxy upgrade required"), never at request time. A genuinely new wire protocol requires a
   proxy release by design; this check makes that explicit and safe. Key-absent ⇒ import permitted
   (fail-open — the control plane cannot distinguish "proxy not started yet" from "proxy predates
   this protocol", and failing closed would block legitimate imports whenever the proxy happens to
   be down).
6. **`/oip/v2/models/{model}/ready` does not park or wake.** A sleeping model's readiness probe
   returns 503 from the routing map (the body notes it wakes on inference); an active model's
   probe is forwarded. A readiness probe must not be an accidental wake trigger.
7. **`GET /oip/v2/models` shape is Sardeenz-defined** (`{models:[{name,ready}]}`), answered from
   the routing map, never forwarded; sleeping models are listed (`ready:false`) — invocable,
   wake-on-request, exactly like the `openai` listing's sleeping entries.

## Consequences

- REST-only; gRPC is out of scope.
- Repository/admin `/v2/repository/*` calls stay entirely inside the control plane's engine-runner
  management sideband — never proxied.
- Load-balancing across multiple same-model runners needs no proxy change but is gated by #120.
- **Amendment note:** This ADR supersedes ADR-020's "the Rust proxy and `proxy-control-plane.yaml`
  are untouched" consequence — that statement was true of ADR-020's own change (register both
  names engine-side, no body rewrite), which still holds; ADR-021 subsequently adds the prefixes
  and the `protocol` field. ADR-020's naming decision is otherwise unaffected.

## Non-goals

- gRPC proxying.
- A dedicated OIP listener port serving root-path `/v2/*` (the **escape hatch**). Considered and
  **deferred**: additive and non-breaking, following the existing multi-listener pattern
  (inference vs. admin), to be added only if strict-V2-client tooling that hard-appends `/v2` to
  `host:port` ever bites in practice.
- Unprefixed protocol aliases (explicitly rejected in Decision 2).
- Converting `supportedModelTypes` to a structured enum (#15).

## References

- [#125](https://github.com/rh-aiservices-bu/school-of-sardeenz/issues/125) — implementation issue.
- [ADR-005](adr-005-openapi-contracts.md) — OpenAPI contracts as source of truth.
- [ADR-010](adr-010-engine-runners.md) — engine runner abstraction.
- [ADR-019](adr-019-logical-model-vs-instance-split.md) — logical model vs. instance split.
- [ADR-020](adr-020-config-name-vs-served-model-name.md) — configuration name vs. served model
  name; this ADR amends its "proxy untouched" consequence.
- `proxy/src/routes.rs` — prefix mounting.
- `proxy/src/protocol/extract.rs` — path- and body-based model extractors.
- `proxy/src/state/redis_sync.rs` — `{prefix}:proxy:protocols` publication.
- `control-plane/src/services/catalog-service.ts` — the import-time protocol guard.
