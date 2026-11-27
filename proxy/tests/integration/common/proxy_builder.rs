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

use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Router;
use metrics_exporter_prometheus::PrometheusBuilder;
use tokio::net::TcpListener;
use tokio::sync::watch;
use tokio::task::JoinHandle;

use sardeenz_proxy::config::{CircuitBreakerConfig, Config, ParkingConfig};
use sardeenz_proxy::handlers;
use sardeenz_proxy::parking::ParkingManager;
use sardeenz_proxy::routing::RoutingMapCache;
use sardeenz_proxy::shutdown;
use sardeenz_proxy::state::AppState;

/// A running test proxy with its addresses and routing cache exposed.
pub struct TestProxy {
    pub proxy_addr: std::net::SocketAddr,
    pub admin_addr: std::net::SocketAddr,
    pub routing_cache: RoutingMapCache,
    pub parking: ParkingManager,
}

/// Configuration knobs for the test proxy.
pub struct TestProxyConfig {
    pub control_plane_url: String,
    pub parking_timeout: Duration,
    pub parking_max_per_model: usize,
    pub parking_max_global: usize,
    pub parking_max_bytes: usize,
    pub cb_failure_threshold: u32,
    pub cb_failure_window: Duration,
    pub cb_recovery_timeout: Duration,
    pub max_body_bytes: usize,
    /// Aggregate buffered-body budget (#300). The default is the enforcing
    /// production value so every existing test runs under enforcement; their
    /// bodies are kilobytes at most.
    pub max_buffered_bytes: usize,
    pub max_concurrent_forwards: usize,
    pub max_concurrent_forwards_per_model: usize,
    /// Optional static inference API keys (#332). Empty = key disabled.
    pub inference_api_keys: Vec<String>,
    /// Drain margin added to `parking_timeout` by `Config::shutdown_deadline()`
    /// (#330). The default mirrors production (45 s).
    pub shutdown_drain_secs: u64,
}

impl Default for TestProxyConfig {
    fn default() -> Self {
        Self {
            control_plane_url: "http://127.0.0.1:1".to_string(), // unused sentinel
            parking_timeout: Duration::from_secs(10),
            parking_max_per_model: 1000,
            parking_max_global: 10000,
            parking_max_bytes: 1_073_741_824,
            cb_failure_threshold: 5,
            cb_failure_window: Duration::from_secs(30),
            cb_recovery_timeout: Duration::from_secs(15),
            max_body_bytes: 33_554_432,
            max_buffered_bytes: 268_435_456,
            max_concurrent_forwards: 0,
            max_concurrent_forwards_per_model: 0,
            inference_api_keys: Vec::new(),
            shutdown_drain_secs: 45,
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
    pub async fn spawn_with_shared_cache(control_plane_url: &str, cache: RoutingMapCache) -> Self {
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
            true,  // routing map was loaded before the simulated disconnect
        )
        .await
    }

    /// Spawn the one deliberately not-ready state used by the readiness probe test.
    pub async fn spawn_before_routing_map_loaded(control_plane_url: &str) -> Self {
        Self::spawn_inner_full(
            TestProxyConfig {
                control_plane_url: control_plane_url.to_string(),
                ..Default::default()
            },
            None,
            true,
            false,
        )
        .await
    }

    async fn spawn_inner(cfg: TestProxyConfig, existing_cache: Option<RoutingMapCache>) -> Self {
        // Most integration tests inject entries after spawning instead of providing an existing
        // cache. They model a completed empty HGETALL followed by later updates, so mark the
        // initial routing load complete even when the injected map starts empty.
        Self::spawn_inner_full(cfg, existing_cache, true, true).await
    }

    async fn spawn_inner_full(
        cfg: TestProxyConfig,
        existing_cache: Option<RoutingMapCache>,
        redis_connected: bool,
        routing_map_loaded: bool,
    ) -> Self {
        let state = build_state(&cfg, existing_cache, redis_connected, routing_map_loaded);

        let routing_cache = state.routing_cache.clone();
        let parking = state.parking.clone();

        let proxy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_addr = proxy_listener.local_addr().unwrap();

        let admin_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let admin_addr = admin_listener.local_addr().unwrap();

        let proxy_app = sardeenz_proxy::routes::build_proxy_router(state.clone());

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

        TestProxy { proxy_addr, admin_addr, routing_cache, parking }
    }

    pub fn proxy_url(&self) -> String {
        format!("http://{}", self.proxy_addr)
    }

    pub fn admin_url(&self) -> String {
        format!("http://{}", self.admin_addr)
    }
}

/// The two axum serve tasks (`proxy`, `admin`), each of which resolves to the
/// server's I/O result.
type ServeHandles = (JoinHandle<std::io::Result<()>>, JoinHandle<std::io::Result<()>>);

/// Handle for graceful-shutdown tests: mirrors the binary's shutdown ordering
/// (#330) and is reused by #340's replica-kill scenario.
pub struct ShutdownHandle {
    shutdown_tx: Option<watch::Sender<()>>,
    handles: Option<ServeHandles>,
    /// Stand-in for the binary's Redis-sync task: this harness has no Redis, so
    /// the task simply resolves when the shutdown channel fires — the same
    /// contract `drain_with_deadline` relies on in production.
    redis_handle: Option<JoinHandle<()>>,
    state: AppState,
    deadline: Duration,
}

impl ShutdownHandle {
    /// The proxy's shared state, so a test can observe `is_ready()` or set the
    /// shutting-down flag exactly where the binary does.
    pub fn state(&self) -> &AppState {
        &self.state
    }

    /// Run the production shutdown sequence: flip readiness, fire the service
    /// shutdown channel, then resolve once `drain_with_deadline` — bounded by
    /// the config's derived deadline — has finished (or cut the remaining
    /// connections).
    pub async fn begin(&mut self) {
        self.state.set_shutting_down(true);
        drop(self.shutdown_tx.take());
        if let Some((proxy_handle, admin_handle)) = self.handles.take() {
            shutdown::drain_with_deadline(
                proxy_handle,
                admin_handle,
                self.redis_handle.take().expect("drain called once"),
                &self.state,
                self.deadline,
            )
            .await;
        }
    }
}

/// Spawn a proxy whose serve tasks honour graceful shutdown, so a test can run
/// the production drain sequence through [`ShutdownHandle::begin`].
pub async fn spawn_drainable(
    cfg: TestProxyConfig,
    cache: Option<RoutingMapCache>,
) -> (TestProxy, ShutdownHandle) {
    let state = build_state(&cfg, cache, true, true);
    let deadline = state.config.shutdown_deadline();

    let routing_cache = state.routing_cache.clone();
    let parking = state.parking.clone();

    let proxy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy_addr = proxy_listener.local_addr().unwrap();
    let admin_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let admin_addr = admin_listener.local_addr().unwrap();

    let proxy_app = sardeenz_proxy::routes::build_proxy_router(state.clone());
    let admin_app = Router::new()
        .route("/healthz", get(handle_healthz))
        .route("/readyz", get(handle_readyz))
        .route("/metrics", get(handlers::handle_metrics))
        .with_state(state.clone());

    // Same wiring as `proxy/src/main.rs`: one shutdown channel, each serve task
    // waits on its own receiver.
    let (shutdown_tx, _) = watch::channel(());
    let mut rx_proxy = shutdown_tx.subscribe();
    let mut rx_admin = shutdown_tx.subscribe();

    let proxy_handle = tokio::spawn(async move {
        axum::serve(proxy_listener, proxy_app)
            .with_graceful_shutdown(async move {
                let _ = rx_proxy.changed().await;
            })
            .await
    });
    let admin_handle = tokio::spawn(async move {
        axum::serve(admin_listener, admin_app)
            .with_graceful_shutdown(async move {
                let _ = rx_admin.changed().await;
            })
            .await
    });

    let mut rx_redis = shutdown_tx.subscribe();
    let redis_handle = tokio::spawn(async move {
        let _ = rx_redis.changed().await;
    });

    let proxy = TestProxy { proxy_addr, admin_addr, routing_cache, parking };
    let handle = ShutdownHandle {
        shutdown_tx: Some(shutdown_tx),
        handles: Some((proxy_handle, admin_handle)),
        redis_handle: Some(redis_handle),
        state,
        deadline,
    };
    (proxy, handle)
}

fn build_state(
    cfg: &TestProxyConfig,
    existing_cache: Option<RoutingMapCache>,
    redis_connected: bool,
    routing_map_loaded: bool,
) -> AppState {
    // build_recorder() does NOT install a global recorder, so multiple tests in
    // the same binary can each call this without panicking.
    let recorder = PrometheusBuilder::new().build_recorder();
    let metrics_handle = recorder.handle();
    // The recorder itself is not installed globally; the handle is sufficient
    // for render(). Metrics macros in the proxy code will silently no-op.
    drop(recorder);

    // Use AppState directly — the production state type.
    // No install_recorder() conflict because we pass a pre-built handle.
    let state = AppState::new_with_cache(
        build_config(cfg),
        metrics_handle,
        existing_cache,
        redis_connected,
    );
    state.set_routing_map_loaded(routing_map_loaded);
    state
}

fn build_config(cfg: &TestProxyConfig) -> Config {
    let upstream_timeout = Duration::from_secs(30);
    // Mirror the production derivation in Config::from_env: a claimed probe is
    // only "leaked" after the longer of recovery_timeout and upstream_timeout,
    // so a slow-but-live probe is never reclaimed early.
    let probe_timeout = std::cmp::max(cfg.cb_recovery_timeout, upstream_timeout);

    Config {
        listen_addr: "127.0.0.1:0".parse().unwrap(),
        admin_addr: "127.0.0.1:0".parse().unwrap(),
        redis_url: "redis://test-not-connected:0".to_string(),
        redis_key_prefix: "sardeenz".to_string(),
        control_plane_url: cfg.control_plane_url.clone(),
        log_level: "error".to_string(),
        parking: ParkingConfig {
            timeout: cfg.parking_timeout,
            max_per_model: cfg.parking_max_per_model,
            max_global: cfg.parking_max_global,
            max_bytes: cfg.parking_max_bytes,
        },
        upstream_timeout,
        circuit_breaker: CircuitBreakerConfig {
            failure_threshold: cfg.cb_failure_threshold,
            failure_window: cfg.cb_failure_window,
            recovery_timeout: cfg.cb_recovery_timeout,
            probe_timeout,
        },
        api_token: None,
        inference_api_keys: cfg.inference_api_keys.clone(),
        max_body_bytes: cfg.max_body_bytes,
        max_buffered_bytes: cfg.max_buffered_bytes,
        max_concurrent_forwards: cfg.max_concurrent_forwards,
        max_concurrent_forwards_per_model: cfg.max_concurrent_forwards_per_model,
        shutdown_drain_secs: cfg.shutdown_drain_secs,
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
