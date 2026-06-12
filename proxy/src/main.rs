mod config;
mod error;
mod forwarding;
mod generated;
mod health;
mod parking;
mod protocol;
mod routing;
mod state;

use axum::body::Body;
use axum::extract::State;
use axum::http::{Request, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::Router;
use tokio::net::TcpListener;
use tokio::signal;
use tracing_subscriber::EnvFilter;

use crate::config::Config;
use crate::error::ProxyError;
use crate::routing::resolver::Resolution;
use crate::state::AppState;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = Config::from_env()?;

    // Structured JSON logging
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new(&config.log_level)),
        )
        .json()
        .with_target(false)
        .with_thread_ids(true)
        .init();

    tracing::info!(
        listen_addr = %config.listen_addr,
        admin_addr = %config.admin_addr,
        redis_url = %config.redis_url,
        "starting sardeenz-proxy"
    );

    // Metrics
    let metrics_handle = health::setup_metrics();
    health::metrics::describe_metrics();

    // App state
    let state = AppState::new(config.clone(), metrics_handle);

    // Start Redis sync in background
    let redis_state = state.clone();
    tokio::spawn(async move {
        loop {
            if let Err(e) = state::start_redis_sync(redis_state.clone()).await {
                tracing::error!(error = %e, "redis sync failed, retrying in 5s");
                redis_state.set_redis_connected(false);
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            }
        }
    });

    // Proxy routes (inference traffic)
    let proxy_app = Router::new()
        .route("/v1/chat/completions", post(handle_inference))
        .route("/v1/completions", post(handle_inference))
        .route("/v1/models", get(handle_models))
        .with_state(state.clone());

    // Admin routes (health + metrics, separate port)
    let admin_app = Router::new()
        .route("/healthz", get(health::healthz))
        .route("/readyz", get(health::readyz))
        .route("/metrics", get(handle_metrics))
        .with_state(state.clone());

    // Bind listeners
    let proxy_listener = TcpListener::bind(config.listen_addr).await?;
    let admin_listener = TcpListener::bind(config.admin_addr).await?;

    tracing::info!(
        proxy = %config.listen_addr,
        admin = %config.admin_addr,
        "listening"
    );

    // Run both servers with graceful shutdown
    tokio::select! {
        result = axum::serve(proxy_listener, proxy_app)
            .with_graceful_shutdown(shutdown_signal()) => {
            result?;
        }
        result = axum::serve(admin_listener, admin_app)
            .with_graceful_shutdown(shutdown_signal()) => {
            result?;
        }
    }

    tracing::info!("proxy shut down");
    Ok(())
}

async fn handle_inference(
    State(state): State<AppState>,
    request: Request<Body>,
) -> Result<impl IntoResponse, ProxyError> {
    let (parts, body) = request.into_parts();
    let body_bytes = axum::body::to_bytes(body, 10 * 1024 * 1024)
        .await
        .map_err(|e| ProxyError::Internal(e.into()))?;

    let body_json: serde_json::Value = serde_json::from_slice(&body_bytes)
        .map_err(|e| ProxyError::Internal(e.into()))?;

    let model_name = protocol::extract_model_name(&body_json)
        .ok_or_else(|| ProxyError::Internal(anyhow::anyhow!("missing model field")))?;

    // Resolve model and determine flow
    let resolution = state.resolver.resolve(&model_name).await?;

    // If sleeping or starting, park the connection
    match &resolution {
        Resolution::Sleeping(_) => {
            state.parking.park(&model_name, true).await?;
        }
        Resolution::Starting(_) => {
            state.parking.park(&model_name, false).await?;
        }
        Resolution::Active(_) => {}
    }

    // At this point the model is active — get fresh routing entry
    let entry = state
        .routing_cache
        .get(&model_name)
        .await
        .ok_or_else(|| ProxyError::ModelNotFound(model_name.clone()))?;

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

    // Rebuild the request and forward
    let forward_request = Request::from_parts(parts, Body::from(body_bytes));
    let path = forward_request.uri().path().to_string();

    let ep_key = format!("{}:{}", endpoint.host, endpoint.port);

    match state
        .forwarding_client
        .forward(&endpoint, &path, forward_request)
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

async fn handle_models(State(state): State<AppState>) -> impl IntoResponse {
    let models = protocol::list_models(&state.routing_cache).await;
    axum::Json(models)
}

async fn handle_metrics(State(state): State<AppState>) -> impl IntoResponse {
    let body = state.metrics_handle.render();
    (
        StatusCode::OK,
        [(
            axum::http::header::CONTENT_TYPE,
            "text/plain; version=0.0.4; charset=utf-8",
        )],
        body,
    )
}

async fn shutdown_signal() {
    let ctrl_c = async {
        signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => { tracing::info!("received Ctrl+C"); }
        _ = terminate => { tracing::info!("received SIGTERM"); }
    }
}
