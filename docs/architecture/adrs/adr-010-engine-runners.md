# ADR-010: Engine Runners

## Status

Accepted

## Context

Sardeenz must orchestrate different types of AI workloads — LLM inference (vLLM), general model serving (Triton), diffusion pipelines, predictive models (MLServer), and potentially others. Each engine has its own process lifecycle, health check mechanism, memory reporting, sleep/wake capabilities (or lack thereof), and log format.

Sardeenz v1 is tightly coupled to vLLM: process spawn commands, health endpoint polling, log parsing for progress extraction, sleep/wake API calls, and kvcached integration are all hardcoded. Supporting additional engines in this model would mean threading conditionals throughout the codebase.

The platform needs a clean abstraction that encapsulates engine-specific behavior behind a common contract, while acknowledging that not all engines support the same features.

## Decision

The abstraction unit is the **runner**. A runner is a process-level component that runs a single workload (a model, a pipeline, etc.) on a worker. Each runner type implements a common contract that the control plane uses to manage its lifecycle.

**Terminology:**

- **Worker:** A Pod with one or more accelerators (or CPU capacity). Long-lived, persistent. Hosts one or many runners.
- **Runner:** A process within a worker that runs a specific workload using a specific engine. One runner per model/workload. Short-lived relative to the worker — runners are started, stopped, slept, and woken by the control plane.
- **Runner type:** The engine-specific implementation of the runner contract (e.g., vLLM runner, Triton runner). Defines how to operate that particular engine.

**The runner contract** defines the interface between the control plane and any engine. Each runner type must provide:

- **Lifecycle management:** How to start, stop, and drain the engine process
- **Health checking:** How to determine readiness (HTTP endpoint, process signal, etc.)
- **Memory reporting:** How the engine reports current device memory consumption
- **Sleep/wake support:** Whether the engine supports memory offload, and the API to trigger it (optional — not all engines support this)
- **Log format / progress reporting:** How to extract loading progress and error information
- **Capability declaration:** Which platform features the runner can leverage (e.g., kvcached, tensor parallelism, specific sleep levels)

The vLLM runner, extracted from Sardeenz v1's existing integration, serves as the reference implementation.

## Consequences

- **Multi-engine support.** New engines are added by implementing a runner type, not by modifying core platform code.
- **Capability-aware orchestration.** The control plane adapts its behavior based on what each runner declares it can do. A runner without sleep/wake support simply can't be slept — the control plane skips it in eviction decisions or uses full stop/start instead.
- **Clear worker/runner hierarchy.** Workers are infrastructure (Pods, accelerators). Runners are workloads (models, pipelines). This maps naturally to how Kubernetes and the control plane each see the system.
- **Contract design is Phase 0 work.** The formal specification of the runner contract (exact interface, schemas, capability flags) is the first delivery phase, as every subsequent phase depends on this boundary.
- **Runner types vary in capability.** The contract must handle engines that support different subsets of features without forcing lowest-common-denominator behavior.
