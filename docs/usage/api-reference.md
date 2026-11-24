# API Reference

Sardeenz has no hand-written API reference. The OpenAPI 3.1 specifications in
[`packages/contracts/specs/`](../../packages/contracts/specs/) are the reference: they are the
single source of truth for every inter-component API (see
[ADR-005](../architecture/adrs/adr-005-openapi-contracts.md)) and the generated TypeScript types
and hand-maintained Rust types are derived from them.

| Spec                       | Audience                                  | Served by                                                       |
| -------------------------- | ----------------------------------------- | --------------------------------------------------------------- |
| `control-plane.yaml`       | Operators and the dashboard BFF           | Control plane, `/api/v1/*` (bearer token: `SARDEENZ_API_TOKEN`) |
| `proxy-control-plane.yaml` | Proxy ↔ control plane (routing map, wake) | Control plane `/api/v1/wake` + Redis routing map                |
| `engine-runner.yaml`       | Runner shim authors                       | Every runner's management port (`/health`, `/sleep`, …)         |
| `worker-agent.yaml`        | Control plane ↔ worker                    | Worker agent (`POST/DELETE /runners`, logs)                     |

The **inference** API is not a Sardeenz contract: the proxy forwards OpenAI-compatible requests
under `/openai/v1/...` and KServe V2 Open Inference Protocol requests under `/oip/v2/...`
verbatim to the engine. The prefix must match the model's `protocol` tag: the proxy is the
admission point and answers `404 model_not_found` for a model invoked (or readiness-probed) under
the other family's prefix, before any parking, wake or forward
([ADR-021](../architecture/adrs/adr-021-protocol-family-path-prefixes.md),
[structured-output notes](../architecture/components/structured-output-compatibility.md)).

The dashboard BFF exposes its own `/api/*` surface (auth, events, metrics, catalog, inference
relay) for the frontend only; it is documented in
[`docs/architecture/components/dashboard.md`](../architecture/components/dashboard.md).

## Proxy request limits

The proxy buffers each inference request body before routing it, capped by
`SARDEENZ_PROXY_MAX_BODY_BYTES` (default `33554432`, 32 MiB). A larger body is rejected before
routing with `413` and the proxy's standard error envelope:

```json
{
  "error": {
    "message": "request body exceeds the 33554432-byte limit (SARDEENZ_PROXY_MAX_BODY_BYTES); raise the limit or send a smaller payload",
    "type": "request_too_large"
  }
}
```

This applies to `/openai/*` and `/oip/*` alike. Because the inference API is not a Sardeenz
contract (see above), the limit is operator configuration rather than a versioned contract
value; an OpenShift Route or other router in front of the proxy may enforce its own, lower body
limit.

## Protocol-family admission

A model is invocable only under the prefix that matches its `protocol` tag — `/openai/v1/...` for
`openai`, `/oip/v2/...` for `oip` (see
[ADR-021](../architecture/adrs/adr-021-protocol-family-path-prefixes.md)). A request under the
other prefix returns the proxy's standard error envelope with status `404`:

```json
{
  "error": {
    "message": "model not found under this protocol family: iris-sklearn",
    "type": "model_not_found"
  }
}
```

The request is never forwarded and a sleeping model is never woken, so the wrong prefix fails fast
instead of waiting out the parking timeout. This applies to the `/oip/v2/models/{model}/ready`
probe as well. The message names only the requested model — never the model's real family.

## Browsing the specs

```bash
# Render one spec as a prerendered Redoc page, then open the file in a browser
# (Redocly is a dev dependency of the repo; `preview-docs` was removed in Redocly v2)
npx redocly build-docs packages/contracts/specs/control-plane.yaml -o /tmp/control-plane.html

# Validate all specs
npm run validate -w @sardeenz/contracts
```

Editing workflow and conventions: [`docs/development/contracts.md`](../development/contracts.md).
