mod redis_sync;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::config::Config;
use crate::forwarding::{CircuitBreaker, ForwardingClient, ForwardingLimiter, WeightedRoundRobin};
use crate::inference_tracker::InferenceTracker;
use crate::parking::ParkingManager;
use crate::parking::WakeTriggerClient;
use crate::routing::{ModelResolver, RoutingMapCache};

pub use redis_sync::start_redis_sync;

/// Shared application state, cloneable across handlers.
#[derive(Clone)]
pub struct AppState {
    pub config: Config,
    pub routing_cache: RoutingMapCache,
    pub resolver: Arc<ModelResolver>,
    pub parking: ParkingManager,
    pub balancer: Arc<WeightedRoundRobin>,
    pub circuit_breaker: CircuitBreaker,
    pub forwarding_client: ForwardingClient,
    pub forwarding_limiter: ForwardingLimiter,
    pub inference_tracker: InferenceTracker,
    pub metrics_handle: metrics_exporter_prometheus::PrometheusHandle,
    proxy_id: Arc<str>,
    redis_connected: Arc<AtomicBool>,
    routing_map_loaded: Arc<AtomicBool>,
}

impl AppState {
    pub fn new(
        config: Config,
        metrics_handle: metrics_exporter_prometheus::PrometheusHandle,
    ) -> Self {
        Self::new_with_cache(config, metrics_handle, None, false)
    }

    /// Create AppState with an optional pre-existing routing cache and
    /// initial redis_connected value. Used by tests to inject a shared cache.
    pub fn new_with_cache(
        config: Config,
        metrics_handle: metrics_exporter_prometheus::PrometheusHandle,
        existing_cache: Option<RoutingMapCache>,
        redis_connected: bool,
    ) -> Self {
        let has_existing_cache = existing_cache.is_some();
        let routing_cache = existing_cache.unwrap_or_default();
        let wake_client =
            WakeTriggerClient::new(&config.control_plane_url, config.api_token.clone());
        let resolver = Arc::new(ModelResolver::new(routing_cache.clone()));
        let parking =
            ParkingManager::new(config.parking.clone(), routing_cache.clone(), wake_client);
        let circuit_breaker = CircuitBreaker::new(config.circuit_breaker.clone());
        let forwarding_client = ForwardingClient::new(config.upstream_timeout);
        let forwarding_limiter = ForwardingLimiter::new(
            config.max_concurrent_forwards,
            config.max_concurrent_forwards_per_model,
        );
        let inference_tracker =
            InferenceTracker::new(config.redis_url.clone(), config.redis_key_prefix.clone());

        Self {
            config,
            routing_cache,
            resolver,
            parking,
            balancer: Arc::new(WeightedRoundRobin::new()),
            circuit_breaker,
            forwarding_client,
            forwarding_limiter,
            inference_tracker,
            metrics_handle,
            proxy_id: Arc::from(uuid::Uuid::new_v4().to_string()),
            redis_connected: Arc::new(AtomicBool::new(redis_connected)),
            routing_map_loaded: Arc::new(AtomicBool::new(has_existing_cache)),
        }
    }

    pub async fn is_ready(&self) -> bool {
        self.redis_connected.load(Ordering::Acquire)
            && self.routing_map_loaded.load(Ordering::Acquire)
    }

    pub fn set_redis_connected(&self, connected: bool) {
        self.redis_connected.store(connected, Ordering::Release);
    }

    pub fn set_routing_map_loaded(&self, loaded: bool) {
        self.routing_map_loaded.store(loaded, Ordering::Release);
    }

    pub fn proxy_id(&self) -> &str {
        &self.proxy_id
    }
}
