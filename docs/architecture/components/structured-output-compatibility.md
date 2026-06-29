# Structured Output Compatibility

**Document scope:** This document covers how structured output features (JSON mode, schema-constrained outputs, tool/function calling) behave across the inference engines Sardeenz v2 targets, and specifies the proxy's approach to handling these parameters.

**Relationship to the proxy:** This document is the deliverable for Phase 1, Task 1.9. It informs the proxy implementation (Tasks 1.5 and 1.10) and provides recommendations for the control plane capability surface (Phase 2).

---

## Background: OpenAI Structured Output API

OpenAI introduced structured output features in three distinct generations:

| Generation                | Introduced | Mechanism                                                      | Guarantee                                      |
| ------------------------- | ---------- | -------------------------------------------------------------- | ---------------------------------------------- |
| **Tool/function calling** | Mar 2023   | `tools` + `tool_choice`                                        | Best-effort schema adherence (~86% compliance) |
| **JSON mode**             | Nov 2023   | `response_format: { type: "json_object" }`                     | Valid JSON syntax only — no schema enforcement |
| **Structured Outputs**    | Aug 2024   | `response_format: { type: "json_schema", json_schema: {...} }` | Hard schema guarantee via constrained decoding |

All three mechanisms coexist in the OpenAI API. The `json_schema` type is the current production standard; `json_object` is considered legacy but will not be removed for compatibility reasons.

### `response_format` parameter

```jsonc
// JSON mode (legacy — valid JSON syntax only)
{ "response_format": { "type": "json_object" } }

// Structured Outputs (current standard — schema-constrained)
{
  "response_format": {
    "type": "json_schema",
    "json_schema": {
      "name": "my_schema",
      "strict": true,
      "schema": {
        "type": "object",
        "properties": { "field": { "type": "string" } },
        "required": ["field"],
        "additionalProperties": false
      }
    }
  }
}
```

When `strict: true` is set, OpenAI requires `additionalProperties: false` on all objects and all fields to be listed in `required`. Requests that violate these constraints are rejected.

### `tools` / `tool_choice` parameter

```jsonc
{
  "tools": [{
    "type": "function",
    "function": {
      "name": "get_weather",
      "description": "...",
      "parameters": { "type": "object", "properties": {...}, "required": [...] },
      "strict": true   // OpenAI-only: constrained decoding for tool args
    }
  }],
  "tool_choice": "auto"   // "auto" | "none" | "required" | named function
}
```

**Key OpenAI limitation (as of 2025):** Structured Outputs (`json_schema` type or `strict: true` on tools) are incompatible with parallel tool calls. Clients must set `parallel_tool_calls: false` when using either.

---

## OpenAI API Structured Output — Complete Feature Inventory

| Parameter / Feature                    | Type                  | Notes                                                                                        |
| -------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------- |
| `response_format.type = "json_object"` | JSON mode             | Valid JSON syntax only, no schema                                                            |
| `response_format.type = "json_schema"` | Schema-constrained    | Requires `strict: true`, `additionalProperties: false` on objects                            |
| `tools[]`                              | Tool definitions      | Array of function specs                                                                      |
| `tool_choice`                          | Tool selection        | `"auto"`, `"none"`, `"required"`, or `{ "type": "function", "function": { "name": "..." } }` |
| `tool_choice = "required"`             | Force tool use        | Guarantees a tool call is made                                                               |
| `parallel_tool_calls`                  | Multi-tool            | `true` by default; must be `false` when using Structured Outputs                             |
| `strict: true` on function             | Constrained tool args | Hard schema enforcement for tool arguments                                                   |

---

## vLLM Support Across Versions

### API evolution summary

vLLM's structured output API has gone through three distinct phases:

**Phase 1 — Legacy `guided_*` extra body parameters (v0.5.x through v0.11.x)**

vLLM extended the OpenAI API with non-standard parameters passed in the request body as extra fields:

```jsonc
{
  "model": "llama-3",
  "messages": [...],
  "guided_json": { "type": "object", "properties": {...} },
  "guided_decoding_backend": "xgrammar"
}
```

Supported parameters in this phase:

- `guided_json` — JSON schema enforcement
- `guided_regex` — regex pattern matching
- `guided_choice` — exact selection from a list
- `guided_grammar` — context-free grammar (GBNF or Lark format)
- `guided_whitespace_pattern` — override whitespace handling in JSON
- `guided_decoding_backend` — per-request backend selection

**Phase 2 — Unified `structured_outputs` parameter (v0.9.x through v0.11.x, parallel to Phase 1)**

vLLM introduced a consolidated `structured_outputs` field as the replacement for `guided_*`:

```jsonc
{ "structured_outputs": { "json": {...} } }
```

**Phase 3 — `guided_*` removed (v0.12.0+)**

The legacy `guided_*` fields were removed in v0.12.0. Clients must use the standard `response_format` API or the new `structured_outputs` field.

### Version-by-version breakdown

| vLLM version    | Engine     | Default backend              | `json_object` | `json_schema` | `guided_*` params | `tool_choice: "required"` | Notes                                                                                                                                                                                         |
| --------------- | ---------- | ---------------------------- | ------------- | ------------- | ----------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0.6.x**       | V0         | XGrammar (Outlines fallback) | Yes           | Partial       | Yes               | No                        | XGrammar introduced as default; known inconsistencies with `response_format`; blocking initialization on structured output in V0 engine degrades throughput                                   |
| **0.7.x**       | V0         | XGrammar (Outlines fallback) | Yes           | Partial       | Yes               | No                        | Active bug-fixing period; `response_format` had varying behavior across sub-releases (reported in issues up to v0.7.3); three backends (Outlines, XGrammar, lm-format-enforcer) all supported |
| **0.8.0**       | V1 default | XGrammar (no_fallback in V1) | Yes           | Yes           | Yes               | No                        | V1 engine became default; non-blocking structured output initialization; V1 initially limited to `xgrammar:no_fallback` — returns 400 for unsupported schemas instead of falling back         |
| **0.8.1–0.8.2** | V1         | XGrammar                     | Yes           | Yes           | Yes               | No                        | Known major bugs in guided generation reported (GitHub issue #15236); Guidance backend added in 0.8.2                                                                                         |
| **0.8.3**       | V1         | XGrammar / Guidance          | Yes           | Yes           | Yes               | Yes                       | `tool_choice: "required"` added; Guidance backend stabilized                                                                                                                                  |
| **0.8.5**       | V1         | XGrammar / Guidance (auto)   | Yes           | Yes           | Yes               | Yes                       | Structured output documented as production-ready in V1; full JSON schema support; `structural_tag` parameter added                                                                            |
| **0.9.x**       | V1 only    | XGrammar / Guidance          | Yes           | Yes           | Yes               | Yes                       | `structural_tag` in docs; Outlines and lm-format-enforcer no longer listed as primary backends in V1; `--structured-outputs-config.backend` flag (replacing `--guided-decoding-backend`)      |
| **0.10.x**      | V1 only    | XGrammar / Guidance          | Yes           | Yes           | Yes               | Yes                       | Continued stabilization; `--guided-decoding-backend` still accepted for backward compat in some sub-releases                                                                                  |
| **0.11.x**      | V1 only    | XGrammar / Guidance          | Yes           | Yes           | Yes               | Yes                       | Reasoning + structured outputs integration (`--structured-outputs-config.enable_in_reasoning=True` required for models like Qwen3 Coder with reasoning enabled)                               |
| **0.12.0+**     | V1 only    | XGrammar / Guidance          | Yes           | Yes           | No (removed)      | Yes                       | `guided_*` fields removed from API; `structured_outputs` field is the non-OpenAI extension path; `--structured-outputs-config.backend` is the canonical flag                                  |

### Guided decoding backends

vLLM supports multiple backends for constrained token generation, selectable at server startup:

| Backend                   | Status in V1              | Strengths                                                                                                                   | Limitations                                                                                                                                                               |
| ------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **XGrammar** (default)    | Primary                   | Low time-per-output-token with schema reuse; C/pthread grammar compilation; effective caching                               | Does not support advanced JSON Schema features (patterns, numeric ranges, string length constraints); returns 400 rather than falling back in `xgrammar:no_fallback` mode |
| **Guidance (llguidance)** | Primary                   | Rust-based Earley parser; fast time-to-first-token for unique schemas; handles complex JSON Schema features XGrammar cannot | Slightly higher per-token overhead when schemas are reused                                                                                                                |
| **Outlines**              | Legacy (V0 only / plugin) | Comprehensive JSON Schema feature support; Lark grammar support                                                             | Python FSM compilation is slow and blocks the V0 engine; removed as a primary backend in V1                                                                               |
| **lm-format-enforcer**    | Legacy (V0 only)          | Character-level constraints                                                                                                 | Performance and accuracy inferior to Outlines in long-context cases; removed as a primary backend in V1                                                                   |

The server-level `auto` mode (default) selects between XGrammar and Guidance based on request characteristics. Per-request backend override via `guided_decoding_backend` body field was removed in v0.12.0.

### Tool calling specifics

- **`tool_choice: "auto"`, `"none"`, named function** — supported since v0.5.x with `--enable-auto-tool-choice` flag and `--tool-call-parser` flag
- **`tool_choice: "required"`** — added in v0.8.3
- **`strict: true` on function definitions** — the field is accepted to avoid breaking clients but has no effect; vLLM does not implement constrained decoding for tool arguments in `auto` mode (as of mid-2025)
- **Parallel tool calls** — model-dependent; not supported for Llama 3 family; supported in Llama 4 via the `llama4_pythonic` parser
- **Streaming tool calls** — known formatting discrepancy: the first chunk in a streaming tool call response may omit the required `"type": "function"` field (GitHub issue #16340)

### vLLM-specific extra parameters retained post-v0.12.0

After removing `guided_*`, vLLM still accepts vLLM-specific extensions outside the standard OpenAI surface:

- `structural_tag` — enforces JSON schema within specified tags (e.g., for models that emit structured output inside XML-style markers)
- `structured_outputs` object — the replacement for `guided_*` for non-OpenAI-standard constraint types

---

## Other Engines

### Text Generation Inference (TGI)

TGI implemented structured output starting in v1.4.3 using the Outlines library as its constraint backend.

**Supported features:**

- `response_format.type = "json_object"` — valid JSON syntax
- `response_format.type = "json_schema"` — schema-constrained output (added to align with OpenAI API)
- `grammar` parameter on `/generate` — JSON schema, regex, or Pydantic model
- `tools` / `tool_choice` via `/v1/chat/completions` — OpenAI-compatible

**Status note:** As of December 2025, TGI is in maintenance mode. HuggingFace now recommends vLLM or SGLang for new deployments. For Sardeenz, TGI is unlikely to be a first-class runner target; this information is included for completeness and for operators migrating from TGI deployments.

### NVIDIA Triton Inference Server

Triton does not implement structured output natively in the same sense as vLLM or TGI. The architecture is model-agnostic: Triton runs backends (TensorRT-LLM, vLLM backend, Python backend, etc.) and structured output capability is a property of the backend and the model, not Triton itself.

**Relevant integration points:**

- **TensorRT-LLM backend via Triton:** XGrammar is the default structured generation backend in TensorRT-LLM (as of 2025), with the same feature profile as vLLM's XGrammar integration.
- **OpenAI-compatible frontend:** Triton's optional OpenAI-compatible frontend layer supports named function calling and structured output via logit biasing, using Outlines as the constraint library. This is similar to vLLM's approach but implemented as a separate layer.
- **KServe/MLServer Predict v2 protocol:** Triton's native HTTP/gRPC protocol (v2 dataplane) does not expose structured output parameters. This protocol is used for non-LLM workloads (vision, classification, regression) and is out of scope for the OpenAI-compatible proxy path.

For Sardeenz, a Triton-backed runner serving LLMs would typically expose an OpenAI-compatible endpoint (either via TRT-LLM's built-in server or a sidecar), and the proxy behavior would be identical to the vLLM case.

### MLServer (Seldon)

MLServer targets the KFServing V2 dataplane protocol for traditional ML models (scikit-learn, XGBoost, MLflow, etc.). It does not implement the OpenAI Chat Completions API and has no structured output features in the OpenAI sense.

In Sardeenz's architecture, MLServer runners (e.g., for predictive models) communicate via the V2 protocol, which the proxy handles as a separate protocol path (out of scope for Phase 1). OpenAI-style structured output parameters are irrelevant for this runner type.

---

## Compatibility Matrix

### Feature × Engine support

| Feature                         | vLLM 0.6.x | vLLM 0.7.x | vLLM 0.8.0–0.8.2 | vLLM 0.8.3–0.8.5 | vLLM 0.9.x–0.11.x | vLLM 0.12.x+ | TGI 1.4.x+ | Triton (TRT-LLM) |
| ------------------------------- | ---------- | ---------- | ---------------- | ---------------- | ----------------- | ------------ | ---------- | ---------------- |
| `json_object` response_format   | Yes        | Yes        | Yes              | Yes              | Yes               | Yes          | Yes        | Yes              |
| `json_schema` response_format   | Partial    | Partial    | Yes              | Yes              | Yes               | Yes          | Yes        | Yes              |
| `tools` / `tool_choice: "auto"` | Yes\*      | Yes\*      | Yes\*            | Yes\*            | Yes\*             | Yes\*        | Yes        | Yes              |
| `tool_choice: "required"`       | No         | No         | No               | Yes              | Yes               | Yes          | Yes        | Partial          |
| `strict: true` on tools         | Ignored    | Ignored    | Ignored          | Ignored          | Ignored           | Ignored      | Ignored    | N/A              |
| `guided_json` (extra body)      | Yes        | Yes        | Yes              | Yes              | Yes               | Removed      | No         | No               |
| `guided_regex` (extra body)     | Yes        | Yes        | Yes              | Yes              | Yes               | Removed      | No         | No               |
| `guided_choice` (extra body)    | Yes        | Yes        | Yes              | Yes              | Yes               | Removed      | No         | No               |
| `guided_grammar` (extra body)   | Yes        | Yes        | Yes              | Yes              | Yes               | Removed      | No         | No               |
| `structural_tag`                | No         | No         | No               | Yes              | Yes               | Yes          | No         | No               |
| Streaming SSE                   | Yes        | Yes        | Yes              | Yes              | Yes               | Yes          | Yes        | Yes              |
| Parallel tool calls             | Model-dep. | Model-dep. | Model-dep.       | Model-dep.       | Model-dep.        | Model-dep.   | Model-dep. | Model-dep.       |

\*Tool calling in vLLM requires `--enable-auto-tool-choice` and `--tool-call-parser` server flags.

### Backend × XGrammar JSON Schema feature support

XGrammar's V1 implementation does not support the full JSON Schema specification. Complex schemas may require the Guidance backend or produce a 400 error in `xgrammar:no_fallback` mode. Known unsupported features:

| JSON Schema feature                  | XGrammar       | Guidance | Notes                        |
| ------------------------------------ | -------------- | -------- | ---------------------------- |
| `type`, `properties`, `required`     | Yes            | Yes      | Core object structure        |
| `enum` / `const`                     | Yes            | Yes      |                              |
| `anyOf` / `oneOf`                    | Yes            | Yes      |                              |
| `$ref` / `$defs`                     | Yes            | Yes      |                              |
| `pattern` (regex on strings)         | No             | Yes      | XGrammar limitation          |
| `minimum` / `maximum` on numbers     | No             | Yes      | XGrammar limitation          |
| `minLength` / `maxLength` on strings | No             | Yes      | XGrammar limitation          |
| Deeply nested `$ref` cycles          | Limited        | Yes      |                              |
| Lark grammar format                  | No (GBNF only) | Yes      | Falls back to Outlines in V0 |

---

## Proxy Approach: Pure Passthrough

### Decision

**The Sardeenz proxy passes all structured output parameters through to the backend runner transparently, without inspection or transformation.**

This is the correct approach for the following reasons:

**1. Semantic opacity is a feature, not a limitation.**

The proxy's job is model routing: read the routing map, resolve the target runner, forward the request, stream the response. Parsing structured output parameters would require the proxy to understand OpenAI API semantics, vLLM-specific extensions, and their evolution over time — coupling a transport-layer component to application-layer concerns that change with every engine release.

**2. Engines are the authority on their own capabilities.**

If a client sends a `json_schema` request to a vLLM 0.6.x instance with a schema that uses `pattern`, vLLM returns a 400 error. That error is accurate and useful. If the proxy intercepted the request and tried to validate or transform it, the proxy would need to replicate vLLM's schema compatibility logic for every engine version — and it would inevitably be wrong or stale.

**3. The engine version is known to the control plane, not the proxy.**

In Sardeenz's architecture, the control plane manages runner lifecycle and knows which engine version is running where. Capability filtering (if needed in the future) belongs in the control plane, not the proxy. The proxy reads only the routing map, which tells it where to send requests — not what requests are valid.

**4. API evolution is frequent and breaking.**

vLLM's structured output API changed significantly across versions (guided\_\* deprecated and removed, backend flags renamed, new parameters added). A proxy that inspects these parameters would need constant updates. A pure passthrough proxy is immune to this churn.

**5. Existing proxy implementations confirm this pattern.**

Production reverse proxy deployments for vLLM (nginx, Envoy, vllm-proxy) all operate in passthrough mode for request bodies. The only proxy-level concern is streaming (disabling response buffering) and timeout configuration — both of which are transport-level, not semantic.

### What the proxy does handle

Even in passthrough mode, the proxy handles two endpoints that have structured output implications:

**`/v1/chat/completions` and `/v1/completions`:** Forwarded verbatim. All parameters — `response_format`, `tools`, `tool_choice`, `guided_json`, `structured_outputs`, and any future parameters — pass through unchanged. The proxy only reads the `model` field for routing and the `stream` field to set the correct response handling path (SSE vs. buffered).

**`/v1/models`:** The proxy aggregates the model list from the routing map. It does not proxy this endpoint to individual runners. The response returns the set of models currently in the routing map with their state.

The `/v1/models` response does not include structured output capability metadata. This is intentional — that metadata would need to come from the runner and would vary by engine version, model, and server configuration. The control plane is the right place to surface per-model capabilities (see Recommendation for Phase 2 below).

### What the proxy explicitly does not do

- Does not parse or validate `response_format`, `tools`, or any structured output parameters
- Does not reject requests based on structured output feature compatibility
- Does not transform `guided_*` parameters to `structured_outputs` or vice versa
- Does not add or remove `parallel_tool_calls`
- Does not inspect `strict` flags on tool definitions
- Does not maintain per-runner capability registries

### Streaming considerations

Structured output responses (both streaming and non-streaming) pass through without modification. The proxy must:

- Forward the full request body including all extra parameters
- Set `proxy_buffering: off` (or the Rust/axum equivalent) for SSE responses
- Use a generous request timeout (structured output generation can be slow for complex schemas)
- Forward error responses verbatim — a 400 from vLLM reporting `"The provided JSON schema contains features not supported by xgrammar"` is useful to the client

### Implications for tool calling with streaming

There is a known vLLM bug (as of mid-2025) where the first chunk of a streaming tool call response is missing `"type": "function"`. The proxy passes this through as-is. Clients connecting to vLLM-backed models should be prepared for this formatting discrepancy. The bug should be filed against vLLM, not worked around in the proxy.

---

## Recommendations for Phase 2 (Control Plane)

The control plane has context the proxy lacks: which engine version is running for each model, and what the runner's capability declaration includes. The following recommendations inform how the control plane should surface structured output capabilities.

**1. Include structured output capabilities in the runner contract.**

The runner contract already defines a `capabilities` section for features like tensor parallelism and sleep levels. Add a `structured_output` capability block:

```jsonc
{
  "capabilities": {
    "structured_output": {
      "json_schema": true,
      "guided_json": true, // false for vLLM >= 0.12.0
      "guided_regex": true,
      "structural_tag": true,
      "tool_calling": true,
      "tool_choice_required": true, // false for vLLM < 0.8.3
      "strict_tools": false, // vLLM does not implement this
      "parallel_tool_calls": true, // model-dependent
    },
  },
}
```

Runners self-report this block on startup. The control plane stores it in Redis/Valkey alongside other runner state.

**2. Expose capabilities via the control plane API, not `/v1/models`.**

The `/v1/models` endpoint is a thin routing construct. Capability metadata should be a separate API path, e.g., `GET /api/v1/models/{model_id}/capabilities`, served by the control plane or dashboard backend. This keeps the hot-path proxy endpoint simple and allows richer metadata than the OpenAI models spec accommodates.

**3. Do not reject requests at the control plane based on structured output parameters.**

The control plane manages model lifecycle, not request routing. Capability filtering is an operator concern that should be handled by client configuration or API gateway policy, not embedded in the orchestration layer.

**4. Document per-model capability caveats in the dashboard.**

The admin dashboard should display structured output support status per model — engine version, backend, and known limitations (e.g., "XGrammar: pattern constraints not supported"). This gives operators actionable information without encoding it into request routing logic.

---

## References

- [vLLM Structured Outputs documentation](https://docs.vllm.ai/en/stable/features/structured_outputs/)
- [vLLM Tool Calling documentation](https://docs.vllm.ai/en/stable/features/tool_calling/)
- [vLLM V1 Architecture blog post](https://blog.vllm.ai/2025/01/27/v1-alpha-release.html)
- [Structured Decoding in vLLM: A Gentle Introduction (vLLM blog, Jan 2025)](https://blog.vllm.ai/2025/01/14/struct-decode-intro.html)
- [OpenAI Introducing Structured Outputs (Aug 2024)](https://openai.com/index/introducing-structured-outputs-in-the-api/)
- [OpenAI Structured Outputs API reference](https://developers.openai.com/api/docs/guides/structured-outputs)
- [Red Hat Developer: Structured outputs in vLLM (Jun 2025)](https://developers.redhat.com/articles/2025/06/03/structured-outputs-vllm-guiding-ai-responses)
- [TGI Guidance documentation](https://huggingface.co/docs/text-generation-inference/en/conceptual/guidance)
- [NVIDIA Triton Inference Server: Function Calling tutorial](https://docs.nvidia.com/deeplearning/triton-inference-server/user-guide/docs/tutorials/Feature_Guide/Function_Calling/README.html)
- [GitHub issue #15236: Major issues with guided generation in vLLM up to v0.8.1](https://github.com/vllm-project/vllm/issues/15236)
- [GitHub issue #16340: Missing "type":"function" in streaming tool calls](https://github.com/vllm-project/vllm/issues/16340)
- [Runner contract specification](runner-contract.md)
- [Phase 1 plan](../../docs/project/phase1.md) — Task 1.9
