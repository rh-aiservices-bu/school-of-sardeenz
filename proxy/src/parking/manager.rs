use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::Mutex;

use crate::config::ParkingConfig;
use crate::error::ProxyError;
use crate::generated::proxy_control_plane::ModelState;
use crate::parking::WakeTriggerClient;
use crate::routing::RoutingMapCache;

/// State of a pending wake trigger.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WakeState {
    /// Wake trigger HTTP call is currently in flight.
    InFlight,
    /// Wake trigger completed successfully; waiting for model to become Active.
    Triggered,
}

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
    pending_wakes: Arc<Mutex<HashMap<String, WakeState>>>,
    parked_count: Arc<ParkedCount>,
}

struct ParkedCount {
    per_model: Mutex<HashMap<String, usize>>,
    global: std::sync::atomic::AtomicUsize,
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
                global: std::sync::atomic::AtomicUsize::new(0),
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
        self.reserve_slot(model_name).await?;

        let result = self.do_park(model_name, fire_wake).await;

        self.release_slot(model_name).await;
        result
    }

    async fn do_park(&self, model_name: &str, fire_wake: bool) -> Result<(), ProxyError> {
        // Thundering herd: only the first request fires the wake trigger.
        // The lock is held across the trigger_wake call so concurrent
        // requests correctly see InFlight state instead of skipping the wake.
        if fire_wake {
            let mut pending = self.pending_wakes.lock().await;
            if !pending.contains_key(model_name) {
                pending.insert(model_name.to_string(), WakeState::InFlight);
                drop(pending);

                match self.wake_client.trigger_wake(model_name).await {
                    Ok(()) => {
                        let mut pending = self.pending_wakes.lock().await;
                        if let Some(state) = pending.get_mut(model_name) {
                            *state = WakeState::Triggered;
                        }
                    }
                    Err(e) => {
                        self.pending_wakes.lock().await.remove(model_name);
                        return Err(ProxyError::ModelUnavailable(format!(
                            "wake trigger failed: {e}"
                        )));
                    }
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
                    // Clean up pending_wakes on timeout so future requests
                    // can retry the wake trigger.
                    self.cleanup_pending_wakes_if_last(model_name).await;
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

    /// Remove the pending_wakes entry if no other requests are parked for
    /// this model (so the next request can fire a fresh wake trigger).
    async fn cleanup_pending_wakes_if_last(&self, model_name: &str) {
        let per_model = self.parked_count.per_model.lock().await;
        let count = per_model.get(model_name).copied().unwrap_or(0);
        // count includes this request (not yet decremented). If count <= 1,
        // this is the last parked request — clean up.
        if count <= 1 {
            drop(per_model);
            self.pending_wakes.lock().await.remove(model_name);
        }
    }

    /// Atomically check limits and reserve a slot. Returns Err if either
    /// limit is exceeded.
    async fn reserve_slot(&self, model_name: &str) -> Result<(), ProxyError> {
        use std::sync::atomic::Ordering;

        let mut per_model = self.parked_count.per_model.lock().await;

        // Check per-model limit
        let model_count = per_model.get(model_name).copied().unwrap_or(0);
        if model_count >= self.config.max_per_model {
            return Err(ProxyError::ParkingLimitReached(model_name.to_string()));
        }

        // Atomically increment global and check
        let prev_global = self.parked_count.global.fetch_add(1, Ordering::SeqCst);
        if prev_global >= self.config.max_global {
            // Roll back
            self.parked_count.global.fetch_sub(1, Ordering::SeqCst);
            return Err(ProxyError::ParkingLimitReached(
                "global parking limit reached".to_string(),
            ));
        }

        // Increment per-model (under the same lock as the check)
        *per_model.entry(model_name.to_string()).or_insert(0) += 1;

        Ok(())
    }

    async fn release_slot(&self, model_name: &str) {
        use std::sync::atomic::Ordering;

        self.parked_count.global.fetch_sub(1, Ordering::SeqCst);
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
        use std::sync::atomic::Ordering;
        self.parked_count.global.load(Ordering::SeqCst)
    }
}
