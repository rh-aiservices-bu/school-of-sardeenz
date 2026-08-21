use std::collections::HashMap;
use std::sync::Arc;

use metrics::{counter, gauge, histogram};

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
    pending_wakes: Arc<std::sync::Mutex<HashMap<String, WakeState>>>,
    parked_count: Arc<ParkedCount>,
}

struct ParkedCount {
    per_model: std::sync::Mutex<HashMap<String, usize>>,
    global: std::sync::atomic::AtomicUsize,
}

/// RAII guard for a reserved parking slot. All release accounting — the
/// global + per-model counters, the parked-connections gauge, the
/// parking-duration histogram, and (as of #94) the thundering-herd
/// `pending_wakes` entry when the last parked request for a model departs —
/// runs in `Drop`, so a slot is reclaimed even when the handler future is
/// cancelled mid-park.
struct ParkingSlotGuard {
    parked_count: Arc<ParkedCount>,
    pending_wakes: Arc<std::sync::Mutex<HashMap<String, WakeState>>>,
    model_name: String,
    park_start: std::time::Instant,
}

impl ParkingSlotGuard {
    /// Call ONLY after the slot has been reserved (counters incremented).
    fn new(
        parked_count: Arc<ParkedCount>,
        pending_wakes: Arc<std::sync::Mutex<HashMap<String, WakeState>>>,
        model_name: String,
    ) -> Self {
        gauge!("sardeenz_proxy_parked_connections", "model" => model_name.clone()).increment(1);
        Self { parked_count, pending_wakes, model_name, park_start: std::time::Instant::now() }
    }
}

impl Drop for ParkingSlotGuard {
    fn drop(&mut self) {
        use std::sync::atomic::Ordering;

        self.parked_count.global.fetch_sub(1, Ordering::SeqCst);
        let was_last = {
            let mut per_model = self.parked_count.per_model.lock().unwrap();
            match per_model.get_mut(&self.model_name) {
                Some(count) => {
                    *count = count.saturating_sub(1);
                    if *count == 0 {
                        per_model.remove(&self.model_name);
                        true
                    } else {
                        false
                    }
                }
                None => false,
            }
        };
        // #94: clear the thundering-herd entry only when the LAST parked
        // request for this model departs (timeout OR client-disconnect
        // cancellation — both run this Drop). A timeout/cancel is terminal
        // for ONE request while the rest of the herd may still be waiting
        // productively, so an earlier departure must NOT remove the entry.
        // (Contrast do_park's Active/Error/vanished arms, which are terminal
        // for the WHOLE herd and remove the entry eagerly.) Lock order:
        // per_model is released above before pending_wakes is acquired, and
        // no other path nests these two, so there is no deadlock.
        if was_last {
            self.pending_wakes.lock().unwrap().remove(&self.model_name);
        }
        gauge!("sardeenz_proxy_parked_connections", "model" => self.model_name.clone())
            .decrement(1);
        histogram!("sardeenz_proxy_parking_duration_seconds")
            .record(self.park_start.elapsed().as_secs_f64());
    }
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
            pending_wakes: Arc::new(std::sync::Mutex::new(HashMap::new())),
            parked_count: Arc::new(ParkedCount {
                global: std::sync::atomic::AtomicUsize::new(0),
                per_model: std::sync::Mutex::new(HashMap::new()),
            }),
        }
    }

    /// Park a request for a sleeping model. Fires a wake trigger if this is
    /// the first request, then waits for the model to become active.
    ///
    /// Returns Ok(()) when the model is active and the caller can forward.
    pub async fn park(&self, model_name: &str, fire_wake: bool) -> Result<(), ProxyError> {
        let _guard = self.reserve_slot(model_name)?;
        self.do_park(model_name, fire_wake).await
    }

    async fn do_park(&self, model_name: &str, fire_wake: bool) -> Result<(), ProxyError> {
        // Thundering herd: only the first request fires the wake trigger.
        // `is_first` is computed in a block scoped strictly to the lock
        // guard's lifetime — std::sync::MutexGuard is !Send, and an
        // explicit `drop()` mid-block isn't enough on its own to convince
        // the async-fn liveness analysis the guard doesn't span the
        // `trigger_wake(...).await` below; ending its declaring block
        // before the await is what makes `do_park`'s future Send.
        let is_first = fire_wake
            && {
                let mut pending = self.pending_wakes.lock().unwrap();
                if pending.contains_key(model_name) {
                    false
                } else {
                    pending.insert(model_name.to_string(), WakeState::InFlight);
                    true
                }
            };
        if is_first {
            match self.wake_client.trigger_wake(model_name).await {
                Ok(()) => {
                    counter!("sardeenz_proxy_wake_triggers_total", "result" => "accepted")
                        .increment(1);
                    let mut pending = self.pending_wakes.lock().unwrap();
                    if let Some(state) = pending.get_mut(model_name) {
                        *state = WakeState::Triggered;
                    }
                }
                Err(e) => {
                    counter!("sardeenz_proxy_wake_triggers_total", "result" => "failed")
                        .increment(1);
                    self.pending_wakes.lock().unwrap().remove(model_name);
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
                    self.pending_wakes.lock().unwrap().remove(model_name);
                    return Ok(());
                }
                Some(entry) if entry.state == ModelState::Error => {
                    self.pending_wakes.lock().unwrap().remove(model_name);
                    return Err(ProxyError::ModelUnavailable(format!(
                        "{model_name} entered error state during wake"
                    )));
                }
                None => {
                    self.pending_wakes.lock().unwrap().remove(model_name);
                    return Err(ProxyError::ModelNotFound(model_name.to_string()));
                }
                _ => {}
            }

            tokio::select! {
                _ = tokio::time::sleep_until(deadline) => {
                    // The guard's Drop clears the pending_wakes entry once
                    // this is the last parked request for the model, so
                    // future requests can retry the wake trigger.
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

    /// Atomically check limits and reserve a slot. Returns Err if either
    /// limit is exceeded. On success, returns a guard that releases the slot
    /// (counters + gauge + histogram) on drop — including on cancellation.
    fn reserve_slot(&self, model_name: &str) -> Result<ParkingSlotGuard, ProxyError> {
        use std::sync::atomic::Ordering;

        let mut per_model = self.parked_count.per_model.lock().unwrap();

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
        drop(per_model);

        Ok(ParkingSlotGuard::new(
            self.parked_count.clone(),
            self.pending_wakes.clone(),
            model_name.to_string(),
        ))
    }

    // NOTE: kept #[allow(dead_code)] despite blueprint A7 — main.rs
    // duplicates this module tree as a separate `bin` crate compilation
    // (it doesn't depend on the `sardeenz_proxy` lib crate), so this method
    // is genuinely unreachable from that target even though the lib crate's
    // unit test and the integration test suite both call it. See PR report.
    #[allow(dead_code)]
    pub fn global_parked_count(&self) -> usize {
        use std::sync::atomic::Ordering;
        self.parked_count.global.load(Ordering::SeqCst)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_manager() -> ParkingManager {
        ParkingManager::new(
            ParkingConfig {
                timeout: std::time::Duration::from_secs(30),
                max_per_model: 10,
                max_global: 100,
            },
            RoutingMapCache::new(),
            WakeTriggerClient::new("http://127.0.0.1:1"),
        )
    }

    #[test]
    fn park_slot_guard_releases_on_drop() {
        let manager = test_manager();

        let guard = manager.reserve_slot("model-a").expect("slot reserved");
        assert_eq!(manager.global_parked_count(), 1);
        drop(guard);
        assert_eq!(manager.global_parked_count(), 0);

        let guard_a = manager.reserve_slot("model-a").expect("slot reserved");
        let guard_b = manager.reserve_slot("model-a").expect("slot reserved");
        assert_eq!(manager.global_parked_count(), 2);
        drop(guard_a);
        assert_eq!(manager.global_parked_count(), 1);
        drop(guard_b);
        assert_eq!(manager.global_parked_count(), 0);
    }
}
