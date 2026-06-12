mod redis_sync;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::config::Config;
use crate::forwarding::{CircuitBreaker, ForwardingClient, WeightedRoundRobin};
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
    pub metrics_handle: metrics_exporter_prometheus::PrometheusHandle,
    redis_connected: Arc<AtomicBool>,
}

impl AppState {
    pub fn new(config: Config, metrics_handle: metrics_exporter_prometheus::PrometheusHandle) -> Self {
        let routing_cache = RoutingMapCache::new();
        let wake_client = WakeTriggerClient::new(&config.control_plane_url);
        let resolver = Arc::new(ModelResolver::new(routing_cache.clone()));
        let parking = ParkingManager::new(
            config.parking.clone(),
            routing_cache.clone(),
            wake_client,
        );
        let circuit_breaker = CircuitBreaker::new(config.circuit_breaker.clone());

        Self {
            config,
            routing_cache,
            resolver,
            parking,
            balancer: Arc::new(WeightedRoundRobin::new()),
            circuit_breaker,
            forwarding_client: ForwardingClient::new(),
            metrics_handle,
            redis_connected: Arc::new(AtomicBool::new(false)),
        }
    }

    pub async fn is_ready(&self) -> bool {
        self.redis_connected.load(Ordering::Relaxed)
    }

    pub fn set_redis_connected(&self, connected: bool) {
        self.redis_connected.store(connected, Ordering::Relaxed);
    }
}
