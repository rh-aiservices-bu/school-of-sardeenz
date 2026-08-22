use axum::body::Body;
use axum::extract::State;
use axum::http::{Request, StatusCode};
use axum::response::{IntoResponse, Response};
use metrics::{counter, gauge, histogram};

use crate::error::ProxyError;
use crate::generated::proxy_control_plane::ModelState;
use crate::routing::resolver::Resolution;
use crate::state::AppState;

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

pub async fn handle_inference(State(state): State<AppState>, request: Request<Body>) -> Response {
    let _active_guard = ActiveConnectionGuard::new();

    let (response, model_label, endpoint_label, elapsed) =
        match handle_inference_inner(state, request).await {
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

async fn handle_inference_inner(
    state: AppState,
    request: Request<Body>,
) -> Result<InferenceOutcome, ProxyError> {
    let (parts, body) = request.into_parts();
    let body_bytes = axum::body::to_bytes(body, state.config.max_body_bytes)
        .await
        .map_err(|e| ProxyError::BadRequest(format!("invalid request body: {e}")))?;

    let body_json: serde_json::Value = serde_json::from_slice(&body_bytes)
        .map_err(|e| ProxyError::BadRequest(format!("invalid JSON: {e}")))?;

    let model_name = crate::protocol::extract_model_name(&body_json)
        .ok_or_else(|| ProxyError::BadRequest("missing or invalid 'model' field".to_string()))?;
    drop(body_json);

    let resolution = state.resolver.resolve(&model_name).await?;

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

    // Re-resolve after parking to verify the model is still Active.
    let entry = state
        .routing_cache
        .get(&model_name)
        .await
        .ok_or_else(|| ProxyError::ModelNotFound(model_name.clone()))?;

    if entry.state != ModelState::Active {
        return Err(ProxyError::ModelUnavailable(format!(
            "{model_name} is no longer active (state: {:?})",
            entry.state
        )));
    }

    // Reserve a forwarding permit AFTER parking resolves (so a parked request
    // never holds one while it waits for a sleeping model to wake — see
    // ForwardingLimiter docs) and BEFORE endpoint selection/forwarding. Held
    // until this function returns, releasing the permit on every exit path
    // including cancellation.
    let _forward_guard = state.forwarding_limiter.try_acquire(&model_name)?;

    // Build candidates with a NON-mutating availability check, so we do not
    // strand a probe on any endpoint the balancer won't select (#93).
    let mut candidates: Vec<_> = entry
        .endpoints
        .iter()
        .filter(|ep| {
            let key = format!("{}:{}", ep.host, ep.port);
            state.circuit_breaker.is_available(&key)
        })
        .cloned()
        .collect();

    // Reserve the half-open probe on the endpoint the balancer picks. If
    // another task claimed it between is_available and here, drop that
    // candidate and re-pick — a lost probe race is NOT a 503. Bounded because
    // each miss removes one candidate; when none remain, pick() → None →
    // AllEndpointsUnhealthy.
    let (endpoint, probe_guard) = loop {
        let picked = state
            .balancer
            .pick(&candidates)
            .ok_or_else(|| ProxyError::AllEndpointsUnhealthy(model_name.clone()))?
            .clone();
        let key = format!("{}:{}", picked.host, picked.port);
        match state.circuit_breaker.try_acquire_probe(&key) {
            Some(guard) => break (picked, guard),
            None => candidates.retain(|ep| format!("{}:{}", ep.host, ep.port) != key),
        }
    };

    // Preserve query string via path_and_query
    let path = parts.uri.path_and_query().map(|pq| pq.as_str()).unwrap_or(parts.uri.path());

    let ep_key = format!("{}:{}", endpoint.host, endpoint.port);

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
                response,
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

pub async fn handle_metrics(State(state): State<AppState>) -> impl IntoResponse {
    let body = state.metrics_handle.render();
    (
        StatusCode::OK,
        [(axum::http::header::CONTENT_TYPE, "text/plain; version=0.0.4; charset=utf-8")],
        body,
    )
}
