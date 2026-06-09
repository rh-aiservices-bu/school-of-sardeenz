# ADR-003: Rust for the Routing Proxy

## Status

Accepted

## Context

The routing proxy sits on the critical path of every inference request. It must handle high-throughput traffic, maintain potentially thousands of concurrent SSE streams, and implement connection parking (holding client connections open while sleeping models wake up) — all with minimal and predictable latency overhead.

Sardeenz v1's proxy is part of the Fastify/Node.js monolith. While adequate for the prototype, Node.js introduces latency variability under high concurrency due to its single-threaded event loop and garbage collection pauses. As the proxy scales to handle more connections and more complex routing (cluster forwarding, circuit breaking, weighted round-robin, protocol-level modularity for multiple model serving types), these characteristics become limiting.

The control plane and dashboard have different profiles — they are not on the hot path of every request, and developer velocity matters more than nanosecond-level latency control. TypeScript/Node.js remains a strong fit for those components.

## Decision

The routing proxy is built in **Rust** using `axum` and `tokio`.

This choice is driven by:

- **Deterministic performance.** No garbage collector, no event loop contention. Latency behavior is predictable under load.
- **Safe concurrency.** Rust's ownership model provides compile-time guarantees for safe multi-threaded access — critical for connection parking state, request deduplication (thundering herd prevention), and concurrent SSE stream management.
- **Low resource footprint.** Deterministic memory usage makes capacity planning straightforward and keeps the proxy lightweight relative to the workloads it fronts.

## Alternatives Considered

- **TypeScript (Fastify/Node.js):** Proven in v1. Strong developer velocity and shared language with the control plane. However, single-threaded model and GC pauses make latency behavior less predictable under high concurrency. Connection parking with thousands of held connections would require careful tuning.
- **Go:** Strong concurrency model with goroutines, good performance profile. Viable alternative, but Rust's zero-cost abstractions and absence of GC provide tighter latency control for this specific use case.

## Consequences

- **Performance ceiling is higher.** The proxy can scale to high connection counts with predictable latency, without becoming the bottleneck.
- **Cross-language boundary.** The proxy and the TypeScript components (control plane, dashboard) communicate through OpenAPI-defined contracts with generated types on both sides. This is an explicit trade-off: type safety is maintained through code generation rather than shared language.
- **Smaller contributor pool.** Rust has a steeper learning curve and smaller ecosystem for web services compared to TypeScript or Go. Mitigated by the proxy's narrow scope — it is a focused, well-bounded component.
- **Build toolchain divergence.** The monorepo includes both Cargo (Rust) and npm (TypeScript) build systems. The Makefile provides a unified interface across both.
