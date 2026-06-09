# Overall Plan

## Delivery Phases

### Phase 0: Engine Runner Contract Design

Design exercise — specification documents and interface types, not runtime code. Define the engine runner contract (health checking, memory reporting, lifecycle management, sleep/wake, log/progress extraction, capability declarations) based on the Sardeenz v1 vLLM integration.

### Phase 1: Rust Proxy with Connection Parking

Stateless routing proxy — request routing, weighted round-robin, cluster forwarding, circuit breaking, connection parking for sleeping models, thundering herd dedup. Requires a resolved approach for the structured output compatibility problem.

### Phase 2: Control Plane Sleep/Wake Orchestration

VRAM budget tracking, LRU eviction engine (behind a pluggable interface), sleep/wake coordination with engine runners, model lifecycle state machine.

### Phase 3: Admin Dashboard

New React + PatternFly 6 frontend built from a clean scaffold. Cherry-pick proven v1 components (GPU cards, model status panels, memory visualizations, benchmark views). New app shell, routing, data-fetching layer, and auth flow designed for the new platform's domain model.

### Phase 4: Highlander Runtime Integration

Lmod/EasyBuild integration in worker containers, CephFS mount architecture, module load/unload IPC from control plane, squashfs/erofs packaging for metadata storm mitigation.
