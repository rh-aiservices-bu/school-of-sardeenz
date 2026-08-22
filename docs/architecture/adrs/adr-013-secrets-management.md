# ADR-013: Secrets Management Policy

## Status

Accepted

## Context

The proxy already redacts Redis URL credentials before logging (`proxy/src/main.rs:redact_url`), but there is no cross-component policy for how secrets are sourced, injected, or protected from leaking into logs. As the control plane (Phase 2) and dashboard (Phase 3) introduce additional credentials — database connections, inter-component auth tokens, API keys — a consistent policy is needed before the credential surface grows.

## Decision

### Secret sources

Secrets are injected via **environment variables** at all stages:

| Stage             | Source                       | Mechanism                                                                       |
| ----------------- | ---------------------------- | ------------------------------------------------------------------------------- |
| Local development | `.env` files, `compose.yaml` | Docker/Podman Compose `environment:` or `env_file:`                             |
| CI                | Pipeline secret store        | Injected as env vars by the CI runner                                           |
| Production (K8s)  | Kubernetes Secrets           | Projected into pods as env vars via `envFrom` or `env[].valueFrom.secretKeyRef` |

No vault integration is planned. If a secrets vault (e.g., HashiCorp Vault, AWS Secrets Manager) becomes necessary, it will be introduced behind the same env-var interface — the application code reads env vars regardless of the upstream secret source.

### Naming convention

All secret-bearing environment variables follow the pattern:

```
SARDEENZ_<COMPONENT>_<PURPOSE>_{URL|KEY|SECRET|PASSWORD|TOKEN}
```

The suffix (`_URL`, `_KEY`, `_SECRET`, `_PASSWORD`, `_TOKEN`) marks a variable as secret-bearing. Examples:

| Variable               | Component             | Contains                               |
| ---------------------- | --------------------- | -------------------------------------- |
| `SARDEENZ_REDIS_URL`   | Proxy, Control Plane  | Connection URL (may embed credentials) |
| `SARDEENZ_CP_API_KEY`  | Proxy → Control Plane | Inter-component auth token (not yet implemented) |
| `SARDEENZ_DB_PASSWORD` | Control Plane         | Database password (not yet implemented) |

The suffix-based convention makes secrets greppable for auditing and CI checks.

### Log sanitization rules

All components must follow these rules:

1. **Never log the raw value of a secret-bearing env var.** Log the variable name or a redacted placeholder instead.
2. **URLs with embedded credentials must be redacted before logging.** The proxy's `redact_url()` function is the reference pattern: parse the URL, replace username/password with `***`, log the redacted form.
3. **Use structured logging.** All components use structured loggers (Rust: `tracing`, TypeScript: to be selected in Phase 2). Structured fields prevent secrets from leaking via positional format strings or string interpolation accidents.
4. **Request/response bodies are not logged at INFO level.** Debug-level body logging (if implemented) must scrub fields that may contain API keys or tokens.

### .env files

`.env` files are listed in `.gitignore` and must never be committed. The repository provides `.env.example` files with placeholder values to document the required variables.

### What this policy does NOT cover

- **Inter-component authentication** (e.g., whether the proxy authenticates to the control plane via API key, mTLS, or network policy). That is a separate design decision for Phase 2.
- **End-user authentication** (e.g., how inference API consumers authenticate). That is out of scope for the platform — it is handled upstream by the API gateway or ingress.
- **Encryption at rest** for the Redis/Valkey data store. Redis TLS and ACLs are deployment configuration, not application-level secrets management.

## Consequences

- **Consistent secret handling.** All components follow the same sourcing pattern (env vars) and naming convention, making audits and rotations straightforward.
- **Greppable secrets.** The suffix convention (`_KEY`, `_SECRET`, `_PASSWORD`, `_TOKEN`, `_URL`) enables automated detection of secret-bearing variables in code and logs.
- **No application-level vault dependency.** Secrets management complexity is pushed to the deployment layer (K8s Secrets, CI pipeline stores), keeping application code simple.
- **Log safety by convention.** The rules are enforced by code review, not by a runtime framework. A future CI check (grep for secret-suffixed variable names near log statements) can add automated enforcement.
- **Proxy sets the pattern.** The existing `redact_url()` in the proxy serves as the reference implementation. Control plane and dashboard should follow the same approach for any URL or credential logging.
