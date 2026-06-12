// Test proxy builder.
//
// Creates a full proxy instance without Redis. The caller provides the control
// plane URL so tests can wire up mock wake triggers. Routing map entries are
// injected directly via RoutingMapCache.
//
// Uses the same AppState and handler functions as the production binary,
// ensuring tests exercise the real request-handling code.
//
// Metrics: integration tests use `build_recorder()` (instead of
// `install_recorder()`) so each test has its own isolated recorder without
// touching the process-wide global recorder.

use std::time::Duration;

use axum::Router;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use metrics_exporter_prometheus::PrometheusBuilder;
use tokio::net::TcpListener;

use sardeenz_proxy::config::{CircuitBreakerConfig, Config, ParkingConfig};
use sardeenz_proxy::handlers;
use sardeenz_proxy::routing::RoutingMapCache;
use sardeenz_proxy::state::AppState;

/// A running test proxy with its addresses and routing cache exposed.
pub struct TestProxy {
    pub proxy_addr: std::net::SocketAddr,
    pub admin_addr: std::net::SocketAddr,
    pub routing_cache: RoutingMapCache,
}

/// Configuration knobs for the test proxy.
pub struct TestProxyConfig {
    pub control_plane_url: String,
    pub parking_timeout: Duration,
    pub parking_max_per_model: usize,
    pub parking_max_global: usize,
    pub cb_failure_threshold: u32,
    pub cb_failure_window: Duration,
    pub cb_recovery_timeout: Duration,
}

impl Default for TestProxyConfig {
    fn default() -> Self {
        Self {
            control_plane_url: "http://127.0.0.1:1".to_string(), // unused sentinel
            parking_timeout: Duration::from_secs(10),
            parking_max_per_model: 1000,
            parking_max_global: 10000,
            cb_failure_threshold: 5,
            cb_failure_window: Duration::from_secs(30),
            cb_recovery_timeout: Duration::from_secs(15),
        }
    }
}

impl TestProxy {
    /// Spawn with a specific control-plane URL (points at mock control plane).
    pub async fn spawn(control_plane_url: &str) -> Self {
        Self::spawn_with_config(TestProxyConfig {
            control_plane_url: control_plane_url.to_string(),
            ..Default::default()
        })
        .await
    }

    /// Spawn with a pre-existing RoutingMapCache (shared with mock control
    /// plane so that wake triggers update the same in-memory map the proxy
    /// reads).
    pub async fn spawn_with_shared_cache(
        control_plane_url: &str,
        cache: RoutingMapCache,
    ) -> Self {
        Self::spawn_inner(
            TestProxyConfig {
                control_plane_url: control_plane_url.to_string(),
                ..Default::default()
            },
            Some(cache),
        )
        .await
    }

    pub async fn spawn_with_config(cfg: TestProxyConfig) -> Self {
        Self::spawn_inner(cfg, None).await
    }

    /// Spawn with full config override AND a shared routing cache.
    pub async fn spawn_with_shared_cache_and_config(
        cfg: TestProxyConfig,
        cache: RoutingMapCache,
    ) -> Self {
        Self::spawn_inner(cfg, Some(cache)).await
    }

    /// Spawn a proxy that reports Redis as disconnected (/readyz → 503).
    pub async fn spawn_with_redis_disconnected(control_plane_url: &str) -> Self {
        Self::spawn_inner_full(
            TestProxyConfig {
                control_plane_url: control_plane_url.to_string(),
                ..Default::default()
            },
            None,
            false, // redis_connected = false
        )
        .await
    }

    async fn spawn_inner(cfg: TestProxyConfig, existing_cache: Option<RoutingMapCache>) -> Self {
        Self::spawn_inner_full(cfg, existing_cache, true).await
    }

    async fn spawn_inner_full(
        cfg: TestProxyConfig,
        existing_cache: Option<RoutingMapCache>,
        redis_connected: bool,
    ) -> Self {
        // build_recorder() does NOT install a global recorder, so multiple
        // tests in the same binary can each call this without panicking.
        let recorder = PrometheusBuilder::new().build_recorder();
        let metrics_handle = recorder.handle();
        // The recorder itself is not installed globally; the handle is sufficient
        // for render(). Metrics macros in the proxy code will silently no-op.
        drop(recorder);

        let config = Config {
            listen_addr: "127.0.0.1:0".parse().unwrap(),
            admin_addr: "127.0.0.1:0".parse().unwrap(),
            redis_url: "redis://test-not-connected:0".to_string(),
            control_plane_url: cfg.control_plane_url,
            log_level: "error".to_string(),
            parking: ParkingConfig {
                timeout: cfg.parking_timeout,
                max_per_model: cfg.parking_max_per_model,
                max_global: cfg.parking_max_global,
            },
            circuit_breaker: CircuitBreakerConfig {
                failure_threshold: cfg.cb_failure_threshold,
                failure_window: cfg.cb_failure_window,
                recovery_timeout: cfg.cb_recovery_timeout,
            },
        };

        // Use AppState directly — the production state type.
        // No install_recorder() conflict because we pass a pre-built handle.
        let state = AppState::new_with_cache(
            config.clone(),
            metrics_handle,
            existing_cache.clone(),
            redis_connected,
        );

        let routing_cache = state.routing_cache.clone();

        let proxy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_addr = proxy_listener.local_addr().unwrap();

        let admin_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let admin_addr = admin_listener.local_addr().unwrap();

        let proxy_app = Router::new()
            .route("/v1/chat/completions", post(handlers::handle_inference))
            .route("/v1/completions", post(handlers::handle_inference))
            .route("/v1/models", get(handlers::handle_models))
            .with_state(state.clone());

        let admin_app = Router::new()
            .route("/healthz", get(handle_healthz))
            .route("/readyz", get(handle_readyz))
            .route("/metrics", get(handlers::handle_metrics))
            .with_state(state);

        tokio::spawn(async move {
            axum::serve(proxy_listener, proxy_app).await.unwrap();
        });
        tokio::spawn(async move {
            axum::serve(admin_listener, admin_app).await.unwrap();
        });

        TestProxy {
            proxy_addr,
            admin_addr,
            routing_cache,
        }
    }

    pub fn proxy_url(&self) -> String {
        format!("http://{}", self.proxy_addr)
    }

    pub fn admin_url(&self) -> String {
        format!("http://{}", self.admin_addr)
    }
}

async fn handle_healthz() -> impl IntoResponse {
    (StatusCode::OK, "ok")
}

async fn handle_readyz(
    axum::extract::State(state): axum::extract::State<AppState>,
) -> impl IntoResponse {
    if state.is_ready().await {
        (StatusCode::OK, "ready")
    } else {
        (StatusCode::SERVICE_UNAVAILABLE, "not ready")
    }
}
