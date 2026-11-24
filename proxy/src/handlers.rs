use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{Request, StatusCode};
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use http_body::{Frame, SizeHint};
use metrics::{counter, gauge, histogram};
use std::pin::Pin;
use std::task::{Context, Poll};

use crate::error::ProxyError;
use crate::generated::proxy_control_plane::{ModelState, Protocol, RoutingEntry, RunnerEndpoint};
use crate::routing::resolver::Resolution;
use crate::routing::RoutingLease;
use crate::state::AppState;

/// Response body wrapper that pins a routing generation through the final streamed byte. Merely
/// retaining the lease in the handler future is insufficient: forwarding returns after upstream
/// headers, while an inference body can continue streaming for minutes.
struct LeasedBody {
    inner: Pin<Box<Body>>,
    _routing_lease: RoutingLease,
}

impl LeasedBody {
    fn new(inner: Body, routing_lease: RoutingLease) -> Self {
        Self { inner: Box::pin(inner), _routing_lease: routing_lease }
    }
}

impl http_body::Body for LeasedBody {
    type Data = Bytes;
    type Error = axum::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
        self.inner.as_mut().poll_frame(cx)
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

fn hold_routing_lease(response: Response, routing_lease: RoutingLease) -> Response {
    let (parts, body) = response.into_parts();
    Response::from_parts(parts, Body::new(LeasedBody::new(body, routing_lease)))
}

/// RAII guard that decrements `sardeenz_proxy_active_connections` on drop,
/// so the gauge is balanced even if the handler future is cancelled.
struct ActiveConnectionGuard;

impl ActiveConnectionGuard {
    fn new() -> Self {
        gauge!("sardeenz_proxy_active_connections").increment(1);
        Self
    }
}

impl Drop for ActiveConnectionGuard {
    fn drop(&mut self) {
        gauge!("sardeenz_proxy_active_connections").decrement(1);
    }
}

/// Outcome of the forwarding attempt, carrying the labels needed for metrics
/// even when the upstream call itself failed (late errors still get
/// model/endpoint labels; only early errors — before an endpoint was
/// selected — go through `Err` without labels).
struct InferenceOutcome {
    response: Response,
    model: Option<String>,
    endpoint: Option<String>,
    forward_start: std::time::Instant,
}

/// Parse a declared Content-Length; absent, non-UTF8 or unparseable → None.
fn declared_content_length(parts: &axum::http::request::Parts) -> Option<u64> {
    parts
        .headers
        .get(axum::http::header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
}

/// Structured warn at rejection. OpenAI model names live inside the rejected
/// body and must not be fabricated; only log a model when the path supplied one.
fn log_body_too_large(
    surface: &'static str,
    model: Option<&str>,
    content_length: Option<u64>,
    limit: usize,
) {
    match model {
        Some(model) => {
            tracing::warn!(
                surface,
                model,
                content_length,
                limit,
                "request body exceeds SARDEENZ_PROXY_MAX_BODY_BYTES"
            )
        }
        None => tracing::warn!(
            surface,
            content_length,
            limit,
            "request body exceeds SARDEENZ_PROXY_MAX_BODY_BYTES"
        ),
    }
}

/// Map a `to_bytes` failure: overflow → 413 with a warn log, anything else → 400.
fn body_read_error(
    error: axum::Error,
    surface: &'static str,
    model: Option<&str>,
    content_length: Option<u64>,
    limit: usize,
) -> ProxyError {
    use std::error::Error as _;
    let overflow = error
        .source()
        .and_then(|source| source.downcast_ref::<http_body_util::LengthLimitError>())
        .is_some();
    if overflow {
        log_body_too_large(surface, model, content_length, limit);
        ProxyError::RequestTooLarge { limit }
    } else {
        ProxyError::BadRequest(format!("invalid request body: {error}"))
    }
}

/// Shared outer metrics wrapper for both infer handlers (openai and oip):
/// records `sardeenz_proxy_requests_total` / `sardeenz_proxy_request_duration_seconds`
/// regardless of success/failure, then produces the HTTP response.
fn finalize(result: Result<InferenceOutcome, ProxyError>) -> Response {
    let (response, model_label, endpoint_label, elapsed) = match result {
        Ok(outcome) => {
            let elapsed = outcome.forward_start.elapsed().as_secs_f64();
            (
                outcome.response,
                outcome.model.unwrap_or_default(),
                outcome.endpoint.unwrap_or_default(),
                elapsed,
            )
        }
        Err(err) => (err.into_response(), String::new(), String::new(), 0.0),
    };

    let status = response.status().as_u16().to_string();
    counter!(
        "sardeenz_proxy_requests_total",
        "model" => model_label,
        "endpoint" => endpoint_label,
        "status" => status
    )
    .increment(1);
    histogram!("sardeenz_proxy_request_duration_seconds").record(elapsed);

    response
}

pub async fn handle_inference(State(state): State<AppState>, request: Request<Body>) -> Response {
    let _active_guard = ActiveConnectionGuard::new();
    finalize(handle_inference_inner(state, request).await)
}

async fn handle_inference_inner(
    state: AppState,
    request: Request<Body>,
) -> Result<InferenceOutcome, ProxyError> {
    let (parts, body) = request.into_parts();
    let limit = state.config.max_body_bytes;
    let content_length = declared_content_length(&parts);
    if content_length.is_some_and(|len| len > limit as u64) {
        log_body_too_large("openai", None, content_length, limit);
        return Err(ProxyError::RequestTooLarge { limit });
    }
    let body_bytes = axum::body::to_bytes(body, limit)
        .await
        .map_err(|e| body_read_error(e, "openai", None, content_length, limit))?;

    let body_json: serde_json::Value = serde_json::from_slice(&body_bytes)
        .map_err(|e| ProxyError::BadRequest(format!("invalid JSON: {e}")))?;

    let model_name = crate::protocol::extract_model_name(&body_json)
        .ok_or_else(|| ProxyError::BadRequest("missing or invalid 'model' field".to_string()))?;
    drop(body_json);

    run_inference(state, model_name, parts, body_bytes, Protocol::Openai).await
}

/// V2 (OIP) inference: `POST /oip/v2/models/{model}/infer`. The model name
/// comes from the URL path rather than the request body.
pub async fn handle_oip_infer(
    State(state): State<AppState>,
    Path(model): Path<String>,
    request: Request<Body>,
) -> Response {
    let _active_guard = ActiveConnectionGuard::new();
    finalize(handle_oip_infer_inner(state, model, request).await)
}

async fn handle_oip_infer_inner(
    state: AppState,
    model: String,
    request: Request<Body>,
) -> Result<InferenceOutcome, ProxyError> {
    let model_name = crate::protocol::extract_model_name_from_path(&model).ok_or_else(|| {
        ProxyError::BadRequest("missing or invalid model path segment".to_string())
    })?;

    let (parts, body) = request.into_parts();
    let limit = state.config.max_body_bytes;
    let content_length = declared_content_length(&parts);
    if content_length.is_some_and(|len| len > limit as u64) {
        log_body_too_large("oip", Some(model_name.as_str()), content_length, limit);
        return Err(ProxyError::RequestTooLarge { limit });
    }
    let body_bytes = axum::body::to_bytes(body, limit)
        .await
        .map_err(|e| body_read_error(e, "oip", Some(model_name.as_str()), content_length, limit))?;

    run_inference(state, model_name, parts, body_bytes, Protocol::Oip).await
}

/// Resolve→park→forward core shared by the openai and oip infer handlers.
/// `protocol` is the family of the surface the request arrived on; both admission checks use it.
async fn run_inference(
    state: AppState,
    model_name: String,
    parts: axum::http::request::Parts,
    body_bytes: bytes::Bytes,
    protocol: Protocol,
) -> Result<InferenceOutcome, ProxyError> {
    // A disconnected proxy intentionally stops admitting inference. Serving from a stale cache
    // would let a move's cutover barrier miss this process while it continues selecting the old
    // runner.
    if !state.is_ready().await {
        return Err(ProxyError::ModelUnavailable("routing state is not connected".to_string()));
    }

    let resolution = state.resolver.resolve(&model_name, protocol).await?;

    match &resolution {
        Resolution::Sleeping(_) => {
            state.parking.park(&model_name, true, body_bytes.len()).await?;
        }
        Resolution::Starting(_) => {
            state.parking.park(&model_name, false, body_bytes.len()).await?;
        }
        Resolution::Active(_) => {}
    }

    // Captured after parking resolves so the recorded duration excludes any
    // time spent waiting for a sleeping/starting model to wake.
    let forward_start = std::time::Instant::now();

    // Reserve a forwarding permit AFTER parking resolves (so a parked request
    // never holds one while it waits for a sleeping model to wake — see
    // ForwardingLimiter docs) and BEFORE endpoint selection/forwarding. Held
    // until this function returns, releasing the permit on every exit path
    // including cancellation.
    let _forward_guard = state.forwarding_limiter.try_acquire(&model_name)?;

    // Pin the current per-model routing generation only after the forwarding permit is held.
    // Destructive map updates wait for this lease through the upstream response before a proxy
    // acknowledges their propagation barrier.
    let routing_lease = state
        .routing_cache
        .get_with_lease(&model_name)
        .await
        .ok_or_else(|| ProxyError::ModelNotFound(model_name.clone()))?;
    // Close the race where Redis disconnects after the admission check but before this request
    // acquires its routing generation. Disconnect cleanup waits on existing leases; a request
    // that acquired only after that wait began must observe not-ready and decline the old route.
    if !state.is_ready().await {
        return Err(ProxyError::ModelUnavailable("routing state is not connected".to_string()));
    }
    let entry = &routing_lease.entry;

    // A protocol-only change of an ACTIVE entry swaps the value with no quiescence barrier:
    // RoutingMapCache::requires_quiescence inspects state and endpoint identity only (routing/map.rs),
    // so a lease acquired after such a swap can carry the other family's tag. Re-check under the
    // lease before selecting an endpoint; a cross-family entry is "not here", not a 503.
    if entry.protocol != protocol {
        return Err(ProxyError::ModelNotFoundUnderProtocol(model_name.clone()));
    }

    if entry.state != ModelState::Active {
        return Err(ProxyError::ModelUnavailable(format!(
            "{model_name} is no longer active (state: {:?})",
            entry.state
        )));
    }

    // Build candidates with a NON-mutating availability check, so we do not
    // strand a probe on any endpoint the balancer won't select (#93).
    let mut candidates: Vec<_> = entry
        .endpoints
        .iter()
        .filter(|ep| state.circuit_breaker.is_available(&endpoint_key(ep)))
        .cloned()
        .collect();

    // Reserve the half-open probe on the endpoint the balancer picks. If
    // another task claimed it between is_available and here, drop that
    // candidate and re-pick — a lost probe race is NOT a 503. Bounded because
    // each miss removes one candidate; when none remain, pick() → None →
    // AllEndpointsUnhealthy. The loop yields the picked endpoint together with
    // the key that claimed its probe — that key is then reused for the breaker,
    // the metrics label and the log.
    let (endpoint, ep_key, probe_guard) = loop {
        let picked = state
            .balancer
            .pick(&candidates)
            .ok_or_else(|| ProxyError::AllEndpointsUnhealthy(model_name.clone()))?
            .clone();
        // Format the selected endpoint's key once: this is the string that claims
        // the probe and is then reused as the breaker key, the metrics label and
        // the logged endpoint.
        let key = endpoint_key(&picked);
        match state.circuit_breaker.try_acquire_probe(&key) {
            Some(guard) => break (picked, key, guard),
            None => candidates.retain(|ep| endpoint_key(ep) != key),
        }
    };

    // Preserve query string via path_and_query
    let path = parts.uri.path_and_query().map(|pq| pq.as_str()).unwrap_or(parts.uri.path());

    // Record inference recency regardless of upstream outcome — a model
    // receiving traffic (even 5xx) is still actively in use for LRU purposes.
    state.inference_tracker.record(&model_name).await;

    match state
        .forwarding_client
        .forward(&endpoint, path, parts.method, &parts.headers, body_bytes)
        .await
    {
        Ok(response) => {
            if response.status().is_server_error() {
                state.circuit_breaker.record_failure(&ep_key);
            } else {
                state.circuit_breaker.record_success(&ep_key);
            }
            probe_guard.disarm();
            Ok(InferenceOutcome {
                response: hold_routing_lease(response, routing_lease),
                model: Some(model_name),
                endpoint: Some(ep_key),
                forward_start,
            })
        }
        Err(e) => {
            state.circuit_breaker.record_failure(&ep_key);
            probe_guard.disarm();
            // Log the raw error (may embed the internal endpoint URL) server-side
            // only; the client-facing error must not disclose cluster topology.
            tracing::warn!(endpoint = %ep_key, error = %e, "upstream request failed");
            Ok(InferenceOutcome {
                response: ProxyError::Upstream("upstream request failed".to_string())
                    .into_response(),
                model: Some(model_name),
                endpoint: Some(ep_key),
                forward_start,
            })
        }
    }
}

pub async fn handle_models(State(state): State<AppState>) -> impl IntoResponse {
    let models = crate::protocol::list_models(&state.routing_cache).await;
    axum::Json(models)
}

pub async fn handle_oip_models(State(state): State<AppState>) -> impl IntoResponse {
    axum::Json(crate::protocol::list_models_v2(&state.routing_cache).await)
}

/// V2 (OIP) readiness probe: `GET /oip/v2/models/{model}/ready`. Deliberately
/// does NOT park or trigger a wake — a readiness probe that silently
/// cold-starts a sleeping model would make health-checking clients an
/// accidental wake trigger. A SLEEPING/STARTING/DRAINING/ERROR model answers
/// 503 straight from the routing map; only an ACTIVE model's probe is
/// forwarded to the runner. An entry tagged with the other protocol family
/// answers 404 without probing (#246).
pub async fn handle_oip_ready(
    State(state): State<AppState>,
    Path(model): Path<String>,
    request: Request<Body>,
) -> Response {
    match handle_oip_ready_inner(state, model, request).await {
        Ok(response) => response,
        Err(err) => err.into_response(),
    }
}

async fn handle_oip_ready_inner(
    state: AppState,
    model: String,
    request: Request<Body>,
) -> Result<Response, ProxyError> {
    if !state.is_ready().await {
        return Err(ProxyError::ModelUnavailable("routing state is not connected".to_string()));
    }
    let model_name = crate::protocol::extract_model_name_from_path(&model).ok_or_else(|| {
        ProxyError::BadRequest("missing or invalid model path segment".to_string())
    })?;

    let routing_lease = state
        .routing_cache
        .get_with_lease(&model_name)
        .await
        .ok_or_else(|| ProxyError::ModelNotFound(model_name.clone()))?;
    if !state.is_ready().await {
        return Err(ProxyError::ModelUnavailable("routing state is not connected".to_string()));
    }
    let entry = &routing_lease.entry;

    // Readiness is admitted only for an entry in the family this prefix names (#246, ADR-021
    // Decision 3). The other family's model is "not here" (404), not "not ready" (503), and the
    // probe is never forwarded to a wrong-protocol engine (Decision 6: no park, no wake).
    if entry.protocol != Protocol::Oip {
        return Err(ProxyError::ModelNotFoundUnderProtocol(model_name.clone()));
    }

    if entry.state != ModelState::Active {
        let body = serde_json::json!({
            "ready": false,
            "model": model_name,
            "message": "model is not active; it wakes on inference",
        });
        return Ok((StatusCode::SERVICE_UNAVAILABLE, axum::Json(body)).into_response());
    }

    let endpoint = select_endpoint(&state, entry)
        .ok_or_else(|| ProxyError::AllEndpointsUnhealthy(model_name.clone()))?;

    let (parts, _body) = request.into_parts();
    let path = parts.uri.path_and_query().map(|pq| pq.as_str()).unwrap_or(parts.uri.path());

    let response = state
        .forwarding_client
        .forward(&endpoint, path, parts.method, &parts.headers, bytes::Bytes::new())
        .await
        .map_err(|e| {
            // A readiness probe must not perturb circuit-breaker state — no
            // record_failure/record_success here, unlike run_inference.
            tracing::warn!(model = %model_name, error = %e, "oip readiness probe forwarding failed");
            ProxyError::Upstream("upstream request failed".to_string())
        })?;
    Ok(hold_routing_lease(response, routing_lease))
}

/// Circuit-breaker identity of a runner endpoint and the value of the `endpoint`
/// metrics label. The `host:port` rendering is load-bearing and must stay
/// byte-identical: `CircuitBreaker` keys every circuit by this string
/// (`forwarding/circuit_breaker.rs:111,134`) and the request histogram is labelled
/// with it (`handlers.rs:151,162`), so any change collapses/creates breakers and
/// moves label cardinality.
fn endpoint_key(endpoint: &RunnerEndpoint) -> String {
    format!("{}:{}", endpoint.host, endpoint.port)
}

/// Non-mutating endpoint selection for a readiness probe: filters by circuit
/// breaker availability, then load-balances, WITHOUT claiming a half-open
/// probe slot (unlike `run_inference`, which does — see its comments).
fn select_endpoint(state: &AppState, entry: &RoutingEntry) -> Option<RunnerEndpoint> {
    let candidates: Vec<_> = entry
        .endpoints
        .iter()
        .filter(|ep| state.circuit_breaker.is_available(&endpoint_key(ep)))
        .cloned()
        .collect();

    state.balancer.pick(&candidates).cloned()
}

pub async fn handle_metrics(State(state): State<AppState>) -> impl IntoResponse {
    let body = state.metrics_handle.render();
    (
        StatusCode::OK,
        [(axum::http::header::CONTENT_TYPE, "text/plain; version=0.0.4; charset=utf-8")],
        body,
    )
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;
    use crate::generated::proxy_control_plane::{Protocol, RoutingEntry, RunnerEndpoint};
    use crate::routing::RoutingMapCache;

    fn routing_entry(weight: u32) -> RoutingEntry {
        RoutingEntry {
            model_name: "streaming-model".to_string(),
            state: ModelState::Active,
            protocol: Protocol::Openai,
            endpoints: vec![RunnerEndpoint {
                host: "127.0.0.1".to_string(),
                port: 8000,
                weight,
                healthy: true,
                runner_id: None,
            }],
            updated_at: "2026-01-01T00:00:00Z".to_string(),
            metadata: None,
        }
    }

    #[test]
    fn endpoint_key_is_host_colon_port_verbatim() {
        let ep = |host: &str, port: u16| RunnerEndpoint {
            host: host.to_string(),
            port,
            weight: 1,
            healthy: true,
            runner_id: None,
        };
        assert_eq!(endpoint_key(&ep("127.0.0.1", 8000)), "127.0.0.1:8000");
        // Deliberately NOT "[::1]:8000": the breaker key and metrics label have always
        // been the raw `host:port` join, and changing it silently would orphan every
        // existing circuit and split the label series.
        assert_eq!(endpoint_key(&ep("::1", 8000)), "::1:8000");
    }

    #[tokio::test]
    async fn response_body_holds_routing_generation_until_dropped() {
        let cache = RoutingMapCache::new();
        cache.replace(HashMap::from([("streaming-model".to_string(), routing_entry(1))])).await;
        let lease = cache.get_with_lease("streaming-model").await.unwrap();
        let response = hold_routing_lease(Response::new(Body::empty()), lease);

        let replacing = {
            let cache = cache.clone();
            tokio::spawn(async move {
                cache
                    .replace(HashMap::from([("streaming-model".to_string(), routing_entry(0))]))
                    .await;
            })
        };
        tokio::task::yield_now().await;
        assert!(!replacing.is_finished());

        drop(response);
        replacing.await.unwrap();
    }
}
