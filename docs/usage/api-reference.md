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
verbatim to the engine ([ADR-021](../architecture/adrs/adr-021-protocol-family-path-prefixes.md),
[structured-output notes](../architecture/components/structured-output-compatibility.md)).

The dashboard BFF exposes its own `/api/*` surface (auth, events, metrics, catalog, inference
relay) for the frontend only; it is documented in
[`docs/architecture/components/dashboard.md`](../architecture/components/dashboard.md).

## Browsing the specs

```bash
# Render one spec as interactive docs (Redocly is a dev dependency of the repo)
npx redocly preview-docs packages/contracts/specs/control-plane.yaml

# Or produce a static HTML page
npx redocly build-docs packages/contracts/specs/control-plane.yaml -o /tmp/control-plane.html

# Validate all specs
npm run validate -w @sardeenz/contracts
```

Editing workflow and conventions: [`docs/development/contracts.md`](../development/contracts.md).
