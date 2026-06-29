use axum::body::Body;
use axum::extract::State;
use axum::http::{Request, StatusCode};
use axum::response::{IntoResponse, Response};
use metrics::{counter, gauge, histogram};

use crate::error::ProxyError;
use crate::generated::proxy_control_plane::ModelState;
use crate::routing::resolver::Resolution;
use crate::state::AppState;

pub async fn handle_inference(State(state): State<AppState>, request: Request<Body>) -> Response {
    let start = std::time::Instant::now();
    gauge!("sardeenz_proxy_active_connections").increment(1);

    let response = match handle_inference_inner(state, request).await {
        Ok(resp) => resp,
        Err(err) => err.into_response(),
    };

    let elapsed = start.elapsed().as_secs_f64();
    let status = response.status().as_u16().to_string();
    gauge!("sardeenz_proxy_active_connections").decrement(1);
    counter!("sardeenz_proxy_requests_total", "status" => status).increment(1);
    histogram!("sardeenz_proxy_request_duration_seconds").record(elapsed);

    response
}

async fn handle_inference_inner(
    state: AppState,
    request: Request<Body>,
) -> Result<Response, ProxyError> {
    let (parts, body) = request.into_parts();
    let body_bytes = axum::body::to_bytes(body, 10 * 1024 * 1024)
        .await
        .map_err(|e| ProxyError::BadRequest(format!("invalid request body: {e}")))?;

    let body_json: serde_json::Value = serde_json::from_slice(&body_bytes)
        .map_err(|e| ProxyError::BadRequest(format!("invalid JSON: {e}")))?;

    let model_name = crate::protocol::extract_model_name(&body_json)
        .ok_or_else(|| ProxyError::BadRequest("missing or invalid 'model' field".to_string()))?;

    let resolution = state.resolver.resolve(&model_name).await?;

    match &resolution {
        Resolution::Sleeping(_) => {
            state.parking.park(&model_name, true).await?;
        }
        Resolution::Starting(_) => {
            state.parking.park(&model_name, false).await?;
        }
        Resolution::Active(_) => {}
    }

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

    // Pick an endpoint via weighted round-robin, respecting circuit breaker
    let healthy_endpoints: Vec<_> = {
        let mut eps = Vec::new();
        for ep in &entry.endpoints {
            let key = format!("{}:{}", ep.host, ep.port);
            if state.circuit_breaker.is_allowed(&key).await {
                eps.push(ep.clone());
            }
        }
        eps
    };

    let endpoint = state
        .balancer
        .pick(&healthy_endpoints)
        .ok_or_else(|| ProxyError::AllEndpointsUnhealthy(model_name.clone()))?
        .clone();

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
                state.circuit_breaker.record_failure(&ep_key).await;
            } else {
                state.circuit_breaker.record_success(&ep_key).await;
            }
            Ok(response)
        }
        Err(e) => {
            state.circuit_breaker.record_failure(&ep_key).await;
            Err(ProxyError::Upstream(e.to_string()))
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
