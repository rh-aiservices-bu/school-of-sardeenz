// Test proxy builder.
//
// Creates a full proxy instance without Redis. The caller provides the control
// plane URL so tests can wire up mock wake triggers. Routing map entries are
// injected directly via RoutingMapCache.
//
// Metrics: integration tests use `build_recorder()` (instead of
// `install_recorder()`) so each test has its own isolated recorder without
// touching the process-wide global recorder.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::extract::State;
use axum::http::{Request, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use metrics_exporter_prometheus::PrometheusBuilder;
use tokio::net::TcpListener;

use sardeenz_proxy::config::{CircuitBreakerConfig, Config, ParkingConfig};
use sardeenz_proxy::error::ProxyError;
use sardeenz_proxy::forwarding::{CircuitBreaker, ForwardingClient, WeightedRoundRobin};
use sardeenz_proxy::parking::{ParkingManager, WakeTriggerClient};
use sardeenz_proxy::protocol;
use sardeenz_proxy::routing::{ModelResolver, RoutingMapCache};

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

        let routing_cache = existing_cache.unwrap_or_default();
        let wake_client = WakeTriggerClient::new(&cfg.control_plane_url);
        let resolver = Arc::new(ModelResolver::new(routing_cache.clone()));

        let parking_config = ParkingConfig {
            timeout: cfg.parking_timeout,
            max_per_model: cfg.parking_max_per_model,
            max_global: cfg.parking_max_global,
        };

        let cb_config = CircuitBreakerConfig {
            failure_threshold: cfg.cb_failure_threshold,
            failure_window: cfg.cb_failure_window,
            recovery_timeout: cfg.cb_recovery_timeout,
        };

        let parking =
            ParkingManager::new(parking_config.clone(), routing_cache.clone(), wake_client);
        let circuit_breaker = CircuitBreaker::new(cb_config.clone());

        let config = Config {
            listen_addr: "127.0.0.1:0".parse().unwrap(),
            admin_addr: "127.0.0.1:0".parse().unwrap(),
            redis_url: "redis://127.0.0.1:6379".to_string(),
            control_plane_url: cfg.control_plane_url,
            log_level: "error".to_string(),
            parking: parking_config,
            circuit_breaker: cb_config,
        };

        let redis_connected = Arc::new(AtomicBool::new(redis_connected));

        let state = ProxyHandlerState {
            routing_cache: routing_cache.clone(),
            resolver,
            parking,
            balancer: Arc::new(WeightedRoundRobin::new()),
            circuit_breaker,
            forwarding_client: ForwardingClient::new(),
            metrics_handle,
            redis_connected,
        };

        let proxy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_addr = proxy_listener.local_addr().unwrap();

        let admin_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let admin_addr = admin_listener.local_addr().unwrap();

        let proxy_app = build_proxy_router(state.clone());
        let admin_app = build_admin_router(state, config);

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

// ---------------------------------------------------------------------------
// Internal handler state — mirrors AppState without touching AppState::new()
// so we avoid the install_recorder() global-recorder conflict in tests.
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct ProxyHandlerState {
    routing_cache: RoutingMapCache,
    resolver: Arc<ModelResolver>,
    parking: ParkingManager,
    balancer: Arc<WeightedRoundRobin>,
    circuit_breaker: CircuitBreaker,
    forwarding_client: ForwardingClient,
    metrics_handle: metrics_exporter_prometheus::PrometheusHandle,
    redis_connected: Arc<AtomicBool>,
}

impl ProxyHandlerState {
    fn is_ready(&self) -> bool {
        self.redis_connected.load(Ordering::Relaxed)
    }
}

// Proxy router (inference traffic)
fn build_proxy_router(state: ProxyHandlerState) -> Router {
    Router::new()
        .route("/v1/chat/completions", post(handle_inference))
        .route("/v1/completions", post(handle_inference))
        .route("/v1/models", get(handle_models))
        .with_state(state)
}

// Admin router (health + metrics, no healthz/readyz from health module since
// those take AppState — we re-implement them inline using ProxyHandlerState)
fn build_admin_router(state: ProxyHandlerState, _config: Config) -> Router {
    Router::new()
        .route("/healthz", get(handle_healthz))
        .route("/readyz", get(handle_readyz))
        .route("/metrics", get(handle_metrics))
        .with_state(state)
}

async fn handle_healthz() -> impl IntoResponse {
    (StatusCode::OK, "ok")
}

async fn handle_readyz(State(state): State<ProxyHandlerState>) -> impl IntoResponse {
    if state.is_ready() {
        (StatusCode::OK, "ready")
    } else {
        (StatusCode::SERVICE_UNAVAILABLE, "not ready")
    }
}

async fn handle_inference(
    State(state): State<ProxyHandlerState>,
    request: Request<Body>,
) -> Result<impl IntoResponse, ProxyError> {
    use sardeenz_proxy::routing::resolver::Resolution;

    let (parts, body) = request.into_parts();
    let body_bytes = axum::body::to_bytes(body, 10 * 1024 * 1024)
        .await
        .map_err(|e| ProxyError::Internal(e.into()))?;

    let body_json: serde_json::Value =
        serde_json::from_slice(&body_bytes).map_err(|e| ProxyError::Internal(e.into()))?;

    let model_name = protocol::extract_model_name(&body_json)
        .ok_or_else(|| ProxyError::Internal(anyhow::anyhow!("missing model field")))?;

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

    let entry = state
        .routing_cache
        .get(&model_name)
        .await
        .ok_or_else(|| ProxyError::ModelNotFound(model_name.clone()))?;

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

async fn handle_models(State(state): State<ProxyHandlerState>) -> impl IntoResponse {
    let models = protocol::list_models(&state.routing_cache).await;
    axum::Json(models)
}

async fn handle_metrics(State(state): State<ProxyHandlerState>) -> impl IntoResponse {
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
