mod config;
mod error;
mod forwarding;
mod generated;
mod handlers;
mod health;
mod inference_tracker;
mod parking;
mod protocol;
mod routing;
mod state;

use axum::routing::{get, post};
use axum::Router;
use tokio::net::TcpListener;
use tokio::signal;
use tokio::sync::watch;
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;

use crate::config::Config;
use crate::state::AppState;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Load the repo-root .env for local dev (walks up from cwd). Never overrides real env vars,
    // and is a no-op when no .env exists, so it is inert in container/k8s deployments.
    let _ = dotenvy::dotenv();

    let config = Config::from_env()?;

    // Structured JSON logging
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(&config.log_level)),
        )
        .json()
        .with_target(false)
        .with_thread_ids(true)
        .init();

    tracing::info!(
        listen_addr = %config.listen_addr,
        admin_addr = %config.admin_addr,
        redis_url = %redact_url(&config.redis_url),
        "starting sardeenz-proxy"
    );

    // Metrics
    let metrics_handle = health::setup_metrics();
    health::metrics::describe_metrics();

    // App state
    let state = AppState::new(config.clone(), metrics_handle);

    // Shared shutdown signal
    let (shutdown_tx, _) = watch::channel(());
    let mut rx_redis = shutdown_tx.subscribe();

    // Start Redis sync in background with shutdown awareness
    let redis_state = state.clone();
    let redis_handle = tokio::spawn(async move {
        loop {
            tokio::select! {
                biased;
                _ = rx_redis.changed() => break,
                result = state::start_redis_sync(redis_state.clone()) => {
                    if let Err(e) = result {
                        tracing::error!(error = %e, "redis sync failed, retrying in 5s");
                        redis_state.set_redis_connected(false);
                        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    }
                }
            }
        }
    });

    // Proxy routes (inference traffic)
    let proxy_app = Router::new()
        .route("/v1/chat/completions", post(handlers::handle_inference))
        .route("/v1/completions", post(handlers::handle_inference))
        .route("/v1/models", get(handlers::handle_models))
        .layer(
            TraceLayer::new_for_http()
                .make_span_with(|request: &axum::http::Request<_>| {
                    let request_id = request
                        .headers()
                        .get("x-request-id")
                        .and_then(|v| v.to_str().ok())
                        .map(String::from)
                        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

                    tracing::info_span!(
                        "request",
                        method = %request.method(),
                        path = %request.uri().path(),
                        request_id = %request_id,
                    )
                })
                .on_response(
                    |response: &axum::http::Response<_>,
                     latency: std::time::Duration,
                     _span: &tracing::Span| {
                        tracing::info!(
                            status = response.status().as_u16(),
                            latency_ms = latency.as_millis(),
                            "response"
                        );
                    },
                ),
        )
        .with_state(state.clone());

    // Admin routes (health + metrics, separate port)
    let admin_app = Router::new()
        .route("/healthz", get(health::healthz))
        .route("/readyz", get(health::readyz))
        .route("/metrics", get(handlers::handle_metrics))
        .with_state(state.clone());

    // Bind listeners
    let proxy_listener = TcpListener::bind(config.listen_addr).await?;
    let admin_listener = TcpListener::bind(config.admin_addr).await?;

    tracing::info!(
        proxy = %config.listen_addr,
        admin = %config.admin_addr,
        "listening"
    );

    // Run both servers with shared graceful shutdown
    let mut rx1 = shutdown_tx.subscribe();
    let mut rx2 = shutdown_tx.subscribe();

    let proxy_handle = tokio::spawn(async move {
        axum::serve(proxy_listener, proxy_app)
            .with_graceful_shutdown(async move {
                let _ = rx1.changed().await;
            })
            .await
    });
    let admin_handle = tokio::spawn(async move {
        axum::serve(admin_listener, admin_app)
            .with_graceful_shutdown(async move {
                let _ = rx2.changed().await;
            })
            .await
    });

    // Wait for shutdown signal
    shutdown_signal().await;

    // Signal all tasks to stop
    drop(shutdown_tx);

    // Wait for both servers to drain gracefully
    let (proxy_result, admin_result) = tokio::join!(proxy_handle, admin_handle);
    if let Err(e) = proxy_result {
        tracing::error!(error = %e, "proxy server task failed");
    }
    if let Err(e) = admin_result {
        tracing::error!(error = %e, "admin server task failed");
    }

    // Wait for Redis sync to stop
    let _ = redis_handle.await;

    tracing::info!("proxy shut down");
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        signal::ctrl_c().await.expect("failed to install Ctrl+C handler");
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

/// Redact credentials from a URL for safe logging.
fn redact_url(url: &str) -> String {
    match url::Url::parse(url) {
        Ok(mut parsed) => {
            if parsed.password().is_some() || !parsed.username().is_empty() {
                let _ = parsed.set_username("***");
                let _ = parsed.set_password(Some("***"));
            }
            parsed.to_string()
        }
        Err(_) => "<invalid-url>".to_string(),
    }
}
