use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use tokio::sync::Mutex;

use crate::config::ParkingConfig;
use crate::error::ProxyError;
use crate::generated::proxy_control_plane::ModelState;
use crate::parking::WakeTriggerClient;
use crate::routing::RoutingMapCache;

/// Manages connection parking for sleeping models.
///
/// Uses a `watch::Receiver` from the routing map cache to detect state
/// transitions. Implements thundering herd prevention by tracking which
/// models have pending wake triggers.
#[derive(Clone)]
pub struct ParkingManager {
    config: ParkingConfig,
    routing_cache: RoutingMapCache,
    wake_client: WakeTriggerClient,
    pending_wakes: Arc<Mutex<HashMap<String, ()>>>,
    parked_count: Arc<ParkedCount>,
}

struct ParkedCount {
    global: AtomicUsize,
    per_model: Mutex<HashMap<String, usize>>,
}

impl ParkingManager {
    pub fn new(
        config: ParkingConfig,
        routing_cache: RoutingMapCache,
        wake_client: WakeTriggerClient,
    ) -> Self {
        Self {
            config,
            routing_cache,
            wake_client,
            pending_wakes: Arc::new(Mutex::new(HashMap::new())),
            parked_count: Arc::new(ParkedCount {
                global: AtomicUsize::new(0),
                per_model: Mutex::new(HashMap::new()),
            }),
        }
    }

    /// Park a request for a sleeping model. Fires a wake trigger if this is
    /// the first request, then waits for the model to become active.
    ///
    /// Returns Ok(()) when the model is active and the caller can forward.
    pub async fn park(
        &self,
        model_name: &str,
        fire_wake: bool,
    ) -> Result<(), ProxyError> {
        self.check_limits(model_name).await?;
        self.increment_parked(model_name).await;

        let result = self.do_park(model_name, fire_wake).await;

        self.decrement_parked(model_name).await;
        result
    }

    async fn do_park(&self, model_name: &str, fire_wake: bool) -> Result<(), ProxyError> {
        // Thundering herd: only the first request fires the wake trigger
        if fire_wake {
            let mut pending = self.pending_wakes.lock().await;
            if !pending.contains_key(model_name) {
                pending.insert(model_name.to_string(), ());
                drop(pending);

                if let Err(e) = self.wake_client.trigger_wake(model_name).await {
                    self.pending_wakes.lock().await.remove(model_name);
                    return Err(ProxyError::ModelUnavailable(format!(
                        "wake trigger failed: {e}"
                    )));
                }
            }
        }

        // Wait for the model to become active
        let mut receiver = self.routing_cache.subscribe();
        let deadline = tokio::time::Instant::now() + self.config.timeout;

        loop {
            match self.routing_cache.get(model_name).await {
                Some(entry) if entry.state == ModelState::Active => {
                    self.pending_wakes.lock().await.remove(model_name);
                    return Ok(());
                }
                Some(entry) if entry.state == ModelState::Error => {
                    self.pending_wakes.lock().await.remove(model_name);
                    return Err(ProxyError::ModelUnavailable(format!(
                        "{model_name} entered error state during wake"
                    )));
                }
                None => {
                    self.pending_wakes.lock().await.remove(model_name);
                    return Err(ProxyError::ModelNotFound(model_name.to_string()));
                }
                _ => {}
            }

            tokio::select! {
                _ = tokio::time::sleep_until(deadline) => {
                    return Err(ProxyError::ParkingTimeout(model_name.to_string()));
                }
                result = receiver.changed() => {
                    if result.is_err() {
                        return Err(ProxyError::Internal(
                            anyhow::anyhow!("routing map channel closed")
                        ));
                    }
                }
            }
        }
    }

    async fn check_limits(&self, model_name: &str) -> Result<(), ProxyError> {
        if self.parked_count.global.load(Ordering::Relaxed) >= self.config.max_global {
            return Err(ProxyError::ParkingLimitReached(
                "global parking limit reached".to_string(),
            ));
        }

        let per_model = self.parked_count.per_model.lock().await;
        if let Some(&count) = per_model.get(model_name) {
            if count >= self.config.max_per_model {
                return Err(ProxyError::ParkingLimitReached(model_name.to_string()));
            }
        }

        Ok(())
    }

    async fn increment_parked(&self, model_name: &str) {
        self.parked_count.global.fetch_add(1, Ordering::Relaxed);
        let mut per_model = self.parked_count.per_model.lock().await;
        *per_model.entry(model_name.to_string()).or_insert(0) += 1;
    }

    async fn decrement_parked(&self, model_name: &str) {
        self.parked_count.global.fetch_sub(1, Ordering::Relaxed);
        let mut per_model = self.parked_count.per_model.lock().await;
        if let Some(count) = per_model.get_mut(model_name) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                per_model.remove(model_name);
            }
        }
    }

    #[allow(dead_code)]
    pub fn global_parked_count(&self) -> usize {
        self.parked_count.global.load(Ordering::Relaxed)
    }
}
