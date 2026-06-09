# ADR-006: New Platform vs. V1 Refactor

## Status

Accepted

## Context

Sardeenz v1 successfully validated the core concepts: L7 VRAM scheduling, sleep/wake orchestration, multi-pod clustering, OpenAI-compatible proxying, and an admin dashboard that resonated with users. The question was whether to evolve v1 incrementally or start fresh.

V1 is a single-process Fastify monolith where the controller API, inference proxy, model lifecycle management, and frontend serving are tightly coupled. The new architecture (ADR-002) requires fundamentally different boundaries: a Rust proxy, a separate control plane, an independent dashboard with its own backend, and an engine runner abstraction.

Retrofitting these changes into the existing codebase would mean:

- Extracting the proxy into a separate Rust service while keeping the remaining Node.js code functional throughout the transition
- Rearchitecting every data flow that currently relies on in-process function calls to use inter-component APIs
- Rebuilding the frontend's data layer for a different backend topology (multiple sources instead of one Fastify server)
- Introducing the engine runner abstraction into code that hardcodes vLLM throughout

Each of these is a near-complete rewrite of the affected subsystem, but with the added constraint of maintaining backward compatibility during the transition.

## Decision

Sardeenz v2 is a **new platform** in a new repository. V1 remains intact as a living reference for cherry-picking proven UI components and implementation patterns.

What carries forward from v1:

- **Validated UX patterns.** GPU memory visualizations, model status panels, benchmark views, and the operational simplicity that users responded well to.
- **Domain knowledge.** Understanding of vLLM process management, sleep/wake behavior, kvcached integration, and cluster orchestration — captured in the architecture docs, not in code dependencies.
- **Individual components.** Specific React components can be ported when building the dashboard (Phase 3), adapted to the new data layer.

What does not carry forward:

- **Application shell and routing.** Built new for the platform's domain model.
- **Data fetching and state management.** Redesigned for multiple backend sources.
- **Backend architecture.** Replaced by the four-component split.
- **Build and deployment pipeline.** New monorepo structure with cross-language support.

## Consequences

- **Clean architectural foundation.** No legacy constraints — each component is built for its specific requirements from the start.
- **Faster delivery for the new architecture.** No time spent maintaining backward compatibility or managing a gradual migration.
- **V1 knowledge is preserved.** The v1 repo and its documentation remain available. Patterns are referenced, not lost.
- **No incremental migration path.** Users of v1 will need to adopt v2 as a separate deployment, not an upgrade. This is acceptable given v1's PoC status.
